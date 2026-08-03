import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Chart, registerables } from 'chart.js';
import { OllamaProvider } from '../lib/llm/ollama-provider';
import { resolveProfile } from '../lib/profile/resolver';
import { buildPrompt } from '../lib/prompt-builder/builder';
import { segmentHtml } from '../lib/segmentation/segmenter';
import { computeReadabilityReport } from '../lib/metrics/engine';
import { DEFAULT_PROFILE, getUserProfile, saveUserProfile } from '../lib/storage/settings';
import { recordSession, getWeeklyProgress } from '../lib/storage/progress';
import type {
  ReadabilityReport, UserProfile, LLMAvailability, ContentNode, SimplificationResult,
} from '../types';

Chart.register(...registerables);

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
  const [simplifiedReport, setSimplifiedReport] = useState<ReadabilityReport | null>(null);

  // --- Progress tracking state ---
  const [weeklyProgress, setWeeklyProgress] = useState<{ weekStart: string; avgTargetGrade: number; sessionCount: number }[]>([]);
  const chartCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstanceRef = useRef<Chart | null>(null);

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

      // Load progress history
      try {
        const progress = await getWeeklyProgress();
        setWeeklyProgress(progress);
      } catch {
        // Non-fatal
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
    setSimplifiedReport(null);

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
      const completedTexts: string[] = [];
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
          fullText = stripThinkingArtifacts(fullText);
          // Mark done
          setResults(prev => prev.map((r, idx) =>
            idx === i ? { ...r, simplifiedText: fullText, status: 'done' } : r
          ));
          completedTexts.push(fullText);
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

      // Step 6: Compute "after" readability report on the full simplified text
      if (completedTexts.length > 0) {
        const combinedSimplifiedText = completedTexts.join('\n\n');
        const afterReport = computeReadabilityReport(combinedSimplifiedText);
        setSimplifiedReport(afterReport);

        // Step 7: Record session for progress tracking
        try {
          await recordSession(spec.targetGrade);
          const progress = await getWeeklyProgress();
          setWeeklyProgress(progress);
        } catch {
          // Non-fatal — progress tracking failure shouldn't break simplification
        }
      }
    } catch (err) {
      console.error('Simplification pipeline failed:', err);
    } finally {
      setSimplifying(false);
    }
  }, [report, articleHtml, articleTitle, contentHash, profile]);

  // ============================================================
  // 5. Chart.js effect — render/update the trend chart when data or tab changes
  // ============================================================
  useEffect(() => {
    if (activeTab !== 'profile') return;
    if (weeklyProgress.length < 2) return;

    // Wait a frame for the canvas to be in the DOM
    const timeoutId = setTimeout(() => {
      const canvas = chartCanvasRef.current;
      if (!canvas) return;

      // Destroy previous chart instance if any
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      chartInstanceRef.current = new Chart(ctx, {
        type: 'line',
        data: {
          labels: weeklyProgress.map(w => {
            const d = new Date(w.weekStart);
            return `${d.getMonth() + 1}/${d.getDate()}`;
          }),
          datasets: [{
            label: 'Avg Target Grade',
            data: weeklyProgress.map(w => w.avgTargetGrade),
            borderColor: '#7c83ff',
            backgroundColor: 'rgba(124, 131, 255, 0.15)',
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: '#a78bfa',
            fill: true,
            tension: 0.3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
          },
          scales: {
            x: {
              ticks: { color: '#888', font: { size: 11 } },
              grid: { color: 'rgba(255,255,255,0.05)' },
            },
            y: {
              ticks: { color: '#888', font: { size: 11 } },
              grid: { color: 'rgba(255,255,255,0.05)' },
              title: { display: true, text: 'Grade Level', color: '#888', font: { size: 11 } },
            },
          },
        },
      });
    }, 50);

    return () => {
      clearTimeout(timeoutId);
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, [activeTab, weeklyProgress]);

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

  // Progress summary calculations
  const totalSessions = weeklyProgress.reduce((sum, w) => sum + w.sessionCount, 0);
  const thisWeekData = weeklyProgress.length > 0 ? weeklyProgress[weeklyProgress.length - 1] : null;
  const earliestData = weeklyProgress.length > 0 ? weeklyProgress[0] : null;
  const gradeDelta = (thisWeekData && earliestData && weeklyProgress.length >= 2)
    ? thisWeekData.avgTargetGrade - earliestData.avgTargetGrade
    : null;

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

            {/* ---- Progress Summary Cards ---- */}
            <div className="progress-cards">
              <div className="progress-card">
                <div className="progress-card-label">Total Sessions</div>
                <div className="progress-card-value">{totalSessions}</div>
              </div>
              <div className="progress-card">
                <div className="progress-card-label">This Week Avg Grade</div>
                <div className="progress-card-value">
                  {thisWeekData ? thisWeekData.avgTargetGrade.toFixed(1) : '—'}
                  {gradeDelta !== null && (
                    <span className={`delta ${gradeDelta >= 0 ? 'positive' : 'negative'}`}>
                      {' '}{gradeDelta >= 0 ? '▲' : '▼'}{Math.abs(gradeDelta).toFixed(1)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ---- Trend Chart ---- */}
            {weeklyProgress.length >= 2 ? (
              <div className="chart-container">
                <h3 className="section-title">Reading Level Trend</h3>
                <div className="chart-wrapper">
                  <canvas ref={chartCanvasRef} />
                </div>
              </div>
            ) : (
              <div className="trend-placeholder">
                <p>📈 Keep reading to see your trend — at least 2 weeks of data needed.</p>
              </div>
            )}

            {/* ---- Session Comparison Card ---- */}
            {report && simplifiedReport && (
              <div className="comparison-card">
                <h3 className="section-title">This Session</h3>
                <div className="comparison-grid">
                  <ComparisonRow
                    label="Grade Level"
                    before={report.estimatedGradeLevel}
                    after={simplifiedReport.estimatedGradeLevel}
                  />
                  <ComparisonRow
                    label="Jargon Density"
                    before={report.jargonDensity}
                    after={simplifiedReport.jargonDensity}
                    unit="%"
                  />
                  <ComparisonRow
                    label="Avg Sentence Len"
                    before={report.avgSentenceLength}
                    after={simplifiedReport.avgSentenceLength}
                    unit=" words"
                  />
                </div>
              </div>
            )}

            {/* ---- Profile Settings Form ---- */}
            <h3 className="section-title" style={{ marginTop: '1rem' }}>Settings</h3>

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

// ============================================================
// Sub-components
// ============================================================
function ComparisonRow({ label, before, after, unit = '' }: {
  label: string;
  before: number;
  after: number;
  unit?: string;
}) {
  const delta = after - before;
  // For all three metrics (grade level, jargon density, sentence length),
  // a decrease is an improvement.
  const improved = delta < 0;
  return (
    <div className="comparison-row">
      <span className="comparison-label">{label}</span>
      <span className="comparison-before">{before.toFixed(1)}{unit}</span>
      <span className="comparison-arrow">→</span>
      <span className="comparison-after">{after.toFixed(1)}{unit}</span>
      <span className={`comparison-delta ${improved ? 'positive' : delta > 0 ? 'negative' : ''}`}>
        {delta >= 0 ? '+' : ''}{delta.toFixed(1)}
      </span>
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
