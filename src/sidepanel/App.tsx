import React, { useState, useEffect, useRef, useCallback } from 'react';
import { OllamaProvider } from '../lib/llm/ollama-provider';
import { resolveProfile } from '../lib/profile/resolver';
import { buildPrompt } from '../lib/prompt-builder/builder';
import { segmentHtml } from '../lib/segmentation/segmenter';
import { DEFAULT_PROFILE, getUserProfile, saveUserProfile } from '../lib/storage/settings';
import type {
  ReadabilityReport, UserProfile, LLMAvailability, ContentNode, SimplificationResult,
} from '../types';

export default function App() {
  // --- Tab state ---
  const [activeTab, setActiveTab] = useState<'dashboard' | 'profile' | 'simplified'>('dashboard');

  // --- LLM state (single instance, held in a ref so it survives re-renders) ---
  const llmRef = useRef<OllamaProvider>(new OllamaProvider());
  const [availability, setAvailability] = useState<LLMAvailability | 'checking'>('checking');
  const [downloadProgress, setDownloadProgress] = useState(0);

  // --- Pipeline data ---
  const [report, setReport] = useState<ReadabilityReport | null>(null);
  const [articleTitle, setArticleTitle] = useState<string>('');
  const [articleHtml, setArticleHtml] = useState<string>('');
  const [articleText, setArticleText] = useState<string>('');
  const [contentHash, setContentHash] = useState<string>('');
  const [extractionStatus, setExtractionStatus] = useState<'idle' | 'extracting' | 'done' | 'error'>('idle');

  // --- Profile state (bound to the UI, persisted to chrome.storage.sync) ---
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE);

  // --- Simplification state ---
  const [simplifying, setSimplifying] = useState(false);
  const [results, setResults] = useState<SimplificationResult[]>([]);
  const [showOriginal, setShowOriginal] = useState(false);

  // ============================================================
  // 1. On mount: check LLM availability, load profile, trigger extraction
  // ============================================================
  useEffect(() => {
    const llm = llmRef.current;
    const init = async () => {
      // Check LLM
      const status = await llm.checkAvailability();
      setAvailability(status);

      // Load persisted user profile
      try {
        const saved = await getUserProfile();
        setProfile(saved);
      } catch {
        // storage not available (e.g. in tests) — keep default
      }

      // Ask background to inject the extractor into the active tab
      try {
        chrome.runtime.sendMessage({ type: 'EXTRACT_PAGE' });
        setExtractionStatus('extracting');
      } catch {
        setExtractionStatus('error');
      }
    };
    init();
    // Destroy the LLM session when the side panel is closed/unmounted
    return () => { llm.destroy(); };
  }, []);

  // ============================================================
  // 2. Listen for extraction results from background
  // ============================================================
  useEffect(() => {
    const listener = (message: any) => {
      if (message.type === 'EXTRACTION_COMPLETE') {
        setArticleTitle(message.extraction.title);
        setArticleHtml(message.extraction.content);
        setArticleText(message.extraction.textContent);
        setContentHash(message.extraction.contentHash);
        setReport(message.report);
        setExtractionStatus('done');
      } else if (message.type === 'EXTRACTION_FAILED') {
        console.error('[Clarity] Extraction failed:', message.error);
        setExtractionStatus('error');
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // Also poll once in case we missed the broadcast (side panel opened after extraction)
    chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, (response) => {
      if (response?.report && response?.extraction) {
        setArticleTitle(response.extraction.title);
        setArticleHtml(response.extraction.content);
        setArticleText(response.extraction.textContent);
        setContentHash(response.extraction.contentHash);
        setReport(response.report);
        setExtractionStatus('done');
      }
    });

    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ============================================================
  // 3. Profile change handler — persists to storage
  // ============================================================
  const updateProfile = useCallback(async (patch: Partial<UserProfile>) => {
    const next = { ...profile, ...patch };
    setProfile(next);
    try {
      await saveUserProfile(next);
    } catch {
      // Non-fatal — works in-memory even if storage fails
    }
  }, [profile]);

  // ============================================================
  // 4. Simplify: the actual pipeline wiring
  // ============================================================
  const handleSimplify = useCallback(async () => {
    if (!report || !articleHtml) return;

    const llm = llmRef.current;

    // Re-check availability in case the model finished downloading since mount
    const currentStatus = await llm.checkAvailability();
    setAvailability(currentStatus);

    if (currentStatus === 'unavailable') return;

    setSimplifying(true);
    setResults([]);

    try {
      // Step 1: Resolve profile → SimplificationSpec
      const spec = resolveProfile(profile, report.estimatedGradeLevel);

      // Step 2: Segment HTML into ContentNode[]
      const segmented = segmentHtml(articleHtml, articleTitle, contentHash);
      const simplifiableNodes = segmented.nodes.filter(n => !n.skipSimplification && n.text.trim().length > 0);

      // Initialise result slots so the UI can show per-node progress
      const initialResults: SimplificationResult[] = simplifiableNodes.map(n => ({
        nodeId: n.id,
        originalText: n.text,
        simplifiedText: '',
        status: 'pending',
      }));
      setResults([...initialResults]);

      // Step 3: Build the system prompt from the first node (reused for all chunks)
      const firstPrompt = buildPrompt(simplifiableNodes[0], spec, report);

      // Step 4: Create a base LLM session.
      // Destroy any existing session first so repeated 'Simplify Now' clicks
      // don't leak sessions (each call to createBaseSession clones into it).
      llm.destroy();
      // 'available' → immediate; 'downloadable' → triggers download via monitor.
      await llm.createBaseSession(firstPrompt.system, (loaded, total) => {
        setDownloadProgress(Math.round((loaded / total) * 100));
      });

      // After session creation, model is definitely available now
      setAvailability('available');
      setDownloadProgress(0);

      // Step 5: Stream each node through the LLM
      let previousContext = '';
      for (let i = 0; i < simplifiableNodes.length; i++) {
        const node = simplifiableNodes[i];
        const prompt = buildPrompt(node, spec, report, previousContext);

        // Mark this node as streaming
        setResults(prev => prev.map((r, idx) =>
          idx === i ? { ...r, status: 'streaming' } : r
        ));

        try {
          const stream = await llm.simplifyChunk(prompt.user);
          let fullText = '';
          for await (const chunk of stream) {
            // promptStreaming yields *deltas*, not cumulative text — accumulate.
            fullText += chunk;
            setResults(prev => prev.map((r, idx) =>
              idx === i ? { ...r, simplifiedText: fullText, status: 'streaming' } : r
            ));
          }
          // Strip any leaked <think>...</think> blocks before finalizing.
          // qwen3:4b is known to leak reasoning artifacts despite think:false
          // and the /no_think directive — this is the last line of defense.
          fullText = stripThinkingArtifacts(fullText);
          // Mark done
          setResults(prev => prev.map((r, idx) =>
            idx === i ? { ...r, simplifiedText: fullText, status: 'done' } : r
          ));
          // Carry forward context for next chunk
          const sentences = fullText.split(/[.!?]\s/);
          previousContext = sentences[sentences.length - 1] || '';
        } catch (err) {
          console.error(`Simplification failed for node ${node.id}:`, err);
          setResults(prev => prev.map((r, idx) =>
            idx === i ? { ...r, status: 'error' } : r
          ));
        }
      }
    } catch (err) {
      console.error('Simplification pipeline failed:', err);
    } finally {
      setSimplifying(false);
    }
  }, [report, articleHtml, articleTitle, contentHash, profile]);

  // ============================================================
  // Render helpers
  // ============================================================
  const renderGauge = (label: string, value: number, unit: string = '') => (
    <div className="gauge-item" key={label}>
      <div className="gauge-label">{label}</div>
      <div className="gauge-value">{value.toFixed(1)}{unit}</div>
    </div>
  );

  const statusText = availability === 'checking' ? '⏳ Checking Ollama…'
    : availability === 'available' ? '● Ollama Ready'
    : '✗ Ollama Not Reachable';

  // ============================================================
  // Render
  // ============================================================
  return (
    <div className="container">
      <header>
        <h1>Clarity</h1>
        <div className={`status-chip status-${availability}`}>{statusText}</div>
      </header>

      <nav className="tabs" role="tablist">
        {(['dashboard', 'profile', 'simplified'] as const).map(tab => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={activeTab === tab ? 'active' : ''}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>

      <main>
        {/* ========== DASHBOARD TAB ========== */}
        {activeTab === 'dashboard' && (
          <div className="tab-content dashboard">
            <h2>Readability Dashboard</h2>
            {extractionStatus === 'extracting' && <p className="loading-text">Extracting article…</p>}
            {extractionStatus === 'error' && <p className="error-text">Could not extract content from this page.</p>}
            {report ? (
              <>
                {articleTitle && <h3 className="article-title">{articleTitle}</h3>}
                <div className="gauges">
                  {renderGauge('Flesch Ease', report.fleschReadingEase)}
                  {renderGauge('Grade Level', report.estimatedGradeLevel)}
                  {renderGauge('FKGL', report.fleschKincaidGradeLevel)}
                  {renderGauge('Gunning Fog', report.gunningFogIndex)}
                  {renderGauge('SMOG', report.smogIndex)}
                  {renderGauge('Coleman-Liau', report.colemanLiauIndex)}
                  {renderGauge('ARI', report.automatedReadabilityIndex)}
                  {renderGauge('Dale-Chall', report.daleChallScore)}
                </div>
                <div className="stats-grid">
                  {renderGauge('Avg sentence', report.avgSentenceLength, ' words')}
                  {renderGauge('Complex words', report.complexWordPercent, '%')}
                  {renderGauge('Jargon', report.jargonDensity, '%')}
                  {renderGauge('Long sentences', report.longSentencePercent, '%')}
                  {renderGauge('Type-token ratio', report.typeTokenRatio)}
                </div>
              </>
            ) : (
              extractionStatus === 'idle' && <p>Navigate to an article and open Clarity to analyze it.</p>
            )}
          </div>
        )}

        {/* ========== PROFILE TAB ========== */}
        {activeTab === 'profile' && (
          <div className="tab-content profile">
            <h2>Reading Profile</h2>

            <label htmlFor="age-group">Age Group</label>
            <select
              id="age-group"
              value={profile.ageGroup}
              onChange={e => updateProfile({ ageGroup: e.target.value as UserProfile['ageGroup'] })}
            >
              <option value="child">Child (grades 1–5)</option>
              <option value="teen">Teen (grades 6–10)</option>
              <option value="adult">Adult (grades 11+)</option>
            </select>

            <label htmlFor="target-grade">Target Grade Level</label>
            <div className="slider-row">
              <input
                id="target-grade"
                type="range"
                min={1}
                max={16}
                value={profile.targetGradeLevel === 'auto' ? resolveTargetGradeFromAge(profile.ageGroup) : profile.targetGradeLevel}
                onChange={e => updateProfile({ targetGradeLevel: parseInt(e.target.value, 10) })}
              />
              <span className="slider-value">
                {profile.targetGradeLevel === 'auto' ? `Auto (${resolveTargetGradeFromAge(profile.ageGroup)})` : profile.targetGradeLevel}
              </span>
              {profile.targetGradeLevel !== 'auto' && (
                <button className="reset-btn" onClick={() => updateProfile({ targetGradeLevel: 'auto' })}>Reset to Auto</button>
              )}
            </div>

            <label htmlFor="purpose">Reading Purpose</label>
            <select
              id="purpose"
              value={profile.readingPurpose}
              onChange={e => updateProfile({ readingPurpose: e.target.value as UserProfile['readingPurpose'] })}
            >
              <option value="general">General</option>
              <option value="esl">ESL / English learner</option>
              <option value="dyslexia-friendly">Dyslexia-friendly</option>
              <option value="expert-to-lay">Expert → Layperson</option>
            </select>

            <label htmlFor="style">Preferred Style</label>
            <select
              id="style"
              value={profile.preferredStyle}
              onChange={e => updateProfile({ preferredStyle: e.target.value as UserProfile['preferredStyle'] })}
            >
              <option value="plain">Plain language</option>
              <option value="bullet-summary">Bullet summary</option>
              <option value="eli5">ELI5</option>
              <option value="concise">Concise</option>
            </select>

            <label htmlFor="familiarity">Domain Familiarity</label>
            <select
              id="familiarity"
              value={profile.domainFamiliarity}
              onChange={e => updateProfile({ domainFamiliarity: e.target.value as UserProfile['domainFamiliarity'] })}
            >
              <option value="novice">Novice</option>
              <option value="intermediate">Intermediate</option>
              <option value="expert">Expert</option>
            </select>
          </div>
        )}

        {/* ========== SIMPLIFIED TAB ========== */}
        {activeTab === 'simplified' && (
          <div className="tab-content simplified">
            <div className="simplify-header">
              <h2>Simplified Text</h2>
              {results.length > 0 && (
                <button
                  className="toggle-btn"
                  onClick={() => setShowOriginal(!showOriginal)}
                >
                  {showOriginal ? 'Show Simplified' : 'Show Original'}
                </button>
              )}
            </div>

            <button
              className="simplify-btn"
              onClick={handleSimplify}
              disabled={
                availability === 'unavailable' ||
                availability === 'checking' ||
                simplifying ||
                !report
              }
              title={
                availability === 'unavailable'
                  ? "Can't reach Ollama — make sure it's running and OLLAMA_ORIGINS is set"
                  : !report
                  ? 'Extract an article first'
                  : ''
              }
            >
              {simplifying ? 'Simplifying…' : 'Simplify Now'}
            </button>

            {availability === 'unavailable' && (
              <p className="unavailable-msg">
                Can't reach Ollama at <code>localhost:11434</code>. Make sure Ollama is running
                (<code>ollama serve</code>) and <code>OLLAMA_ORIGINS=*</code> is set so the
                extension can connect.
              </p>
            )}

            <div className="output">
              {results.map((r, i) => (
                <div key={r.nodeId} className={`result-block status-${r.status}`}>
                  {showOriginal ? (
                    <p className="original-text">{r.originalText}</p>
                  ) : (
                    <p className="simplified-text">
                      {r.simplifiedText || (r.status === 'pending' ? '⏳' : r.status === 'streaming' ? '…' : '')}
                    </p>
                  )}
                  {r.status === 'error' && <span className="error-badge">Failed</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// Small helper — duplicates logic from resolver.ts but avoids importing it just for the UI label
function resolveTargetGradeFromAge(ageGroup: UserProfile['ageGroup']): number {
  return ageGroup === 'child' ? 4 : ageGroup === 'teen' ? 8 : 12;
}

/**
 * Defensive cleanup: strips <think>...</think> blocks that qwen3 may leak
 * despite think:false in the API request and /no_think in the system prompt.
 */
function stripThinkingArtifacts(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
