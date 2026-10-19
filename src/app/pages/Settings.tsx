import React, { useState, useEffect, useCallback } from 'react';
import {
  getUserProfile, saveUserProfile, DEFAULT_PROFILE, getLlmModel, saveLlmModel,
  getExtraQuality, saveExtraQuality, getQualityMode, saveQualityMode,
} from '../../lib/storage/settings';
import { clearAllDocuments } from '../../lib/storage/documents';
import { clearCache } from '../../lib/storage/cache';
import { getNliBench } from '../../lib/storage/nli-bench';
import {
  DEFAULT_LLM_MODEL, LIGHT_LLM_MODEL, missingModelLog, OllamaProvider,
} from '../../lib/llm/ollama-provider';
import { chooseQualityMode, evidenceOf } from '../../lib/quality/mode';
import { resolveTargetGrade } from '../../lib/profile/resolver';
import { PRESETS, editProfile } from '../../lib/profile/presets';
import type { UserProfile, DisplayPrefs, ReadingPreset, NliBenchRecord, QualityModeSetting } from '../../types';

interface SettingsProps {
  displayPrefs: DisplayPrefs;
  onUpdatePrefs: (patch: Partial<DisplayPrefs>) => void;
}

type SaveStatus = 'idle' | 'saved' | 'error';

/** Installed models from Ollama: still loading, the list, or unreachable. */
type ModelList = 'loading' | 'error' | string[];

/** One plain sentence per quality mode: what it checks and what it costs. */
const QUALITY_MODE_HINT: Record<QualityModeSetting, string> = {
  auto: 'Auto uses Full when this computer can check sentences quickly, and Lite when it can\'t.',
  full: 'Full checks every sentence against the original: the most trustworthy, but slow on a computer without a graphics card.',
  lite: 'Lite checks overall meaning, names and numbers only: faster, but its results don\'t count toward the meaning pass rate.',
};

/** "Full (WebGPU, nvidia)" or "Lite (no WebGPU, about 4200 ms per paragraph)". */
function autoChoiceLabel(bench: NliBenchRecord): string {
  const { mode } = chooseQualityMode('auto', evidenceOf(bench));
  const where = bench.backend === 'webgpu'
    ? `WebGPU${bench.adapterVendor ? `, ${bench.adapterVendor}` : ''}`
    : 'no WebGPU';
  const name = mode === 'full' ? 'Full' : 'Lite';
  return `${name} (${where}, about ${Math.round(bench.predictedParagraphMs)} ms per paragraph)`;
}

export function Settings({ displayPrefs, onUpdatePrefs }: SettingsProps) {
  const [profile, setProfile]               = useState<UserProfile>(DEFAULT_PROFILE);
  const [customWords, setCustomWords]       = useState('');
  const [wordStatus, setWordStatus]         = useState<SaveStatus>('idle');
  const [docStatus, setDocStatus]           = useState<SaveStatus>('idle');
  const [progressStatus, setProgressStatus] = useState<SaveStatus>('idle');
  const [llmModel, setLlmModel]             = useState(DEFAULT_LLM_MODEL);
  const [installed, setInstalled]           = useState<ModelList>('loading');
  const [extraQuality, setExtraQuality]     = useState(false);
  const [qualityMode, setQualityMode]       = useState<QualityModeSetting>('auto');
  const [nliBench, setNliBench]             = useState<NliBenchRecord | null>(null);

  // ── Load on mount ───────────────────────────────────────────────────────────
  useEffect(() => {
    getUserProfile().then(p => setProfile(p));
    chrome.storage.sync.get<{ customWords?: string }>('customWords').then(data => {
      if (typeof data.customWords === 'string') setCustomWords(data.customWords);
    });
    getLlmModel().then(setLlmModel);
    getExtraQuality().then(setExtraQuality);
    getQualityMode().then(setQualityMode);
    getNliBench().then(setNliBench).catch(() => setNliBench(null));
    new OllamaProvider().listModels().then(setInstalled).catch(err => {
      console.log('[Clarity] Could not list Ollama models:', err);
      setInstalled('error');
    });
  }, []);

  // ── Model ───────────────────────────────────────────────────────────────────
  const handleModelChange = (model: string) => {
    setLlmModel(model);
    saveLlmModel(model);   // fire-and-forget, like the profile fields
  };

  const toggleExtraQuality = () => {
    const next = !extraQuality;
    setExtraQuality(next);
    saveExtraQuality(next);   // fire-and-forget, as above
  };

  const handleQualityModeChange = (mode: QualityModeSetting) => {
    setQualityMode(mode);
    saveQualityMode(mode);   // fire-and-forget, as above
  };

  // The saved model stays selectable even when Ollama doesn't list it
  const modelOptions = Array.isArray(installed) && installed.includes(llmModel)
    ? installed
    : [llmModel, ...(Array.isArray(installed) ? installed : [])];
  const modelMissing = Array.isArray(installed) && !installed.includes(llmModel);

  // The pull command goes to the console, not into the page
  useEffect(() => {
    if (modelMissing) console.log(missingModelLog(llmModel));
  }, [modelMissing, llmModel]);

  // ── Profile update ──────────────────────────────────────────────────────────
  // Any field edit means the profile no longer matches a preset → 'custom'.
  const updateProfile = useCallback(async (patch: Partial<UserProfile>) => {
    setProfile(prev => {
      const next = editProfile(prev, patch);
      saveUserProfile(next);   // fire-and-forget; non-critical if it fails
      return next;
    });
  }, []);

  // ── Preset selection ────────────────────────────────────────────────────────
  const applyPreset = useCallback((preset: ReadingPreset) => {
    setProfile(preset.profile);
    saveUserProfile(preset.profile);   // fire-and-forget, as above
    onUpdatePrefs(preset.displayPrefs);
  }, [onUpdatePrefs]);

  // ── Custom words save ───────────────────────────────────────────────────────
  const handleSaveWords = async () => {
    try {
      await chrome.storage.sync.set({ customWords });
      flash(setWordStatus, 'saved');
    } catch {
      flash(setWordStatus, 'error');
    }
  };

  // ── Clear documents (docs:index + doc:* — leaves progress:weekly untouched) ─
  const handleClearDocuments = async () => {
    try {
      // The cache holds simplified document text, so it goes too
      await Promise.all([clearAllDocuments(), clearCache()]);
      flash(setDocStatus, 'saved');
    } catch {
      flash(setDocStatus, 'error');
    }
  };

  // ── Reset progress (progress:weekly only) ──────────────────────────────────
  const handleResetProgress = async () => {
    try {
      await chrome.storage.local.remove('progress:weekly');
      flash(setProgressStatus, 'saved');
    } catch {
      flash(setProgressStatus, 'error');
    }
  };

  const effectiveGrade = resolveTargetGrade(profile);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="page settings-page">
      <h1 className="page-heading">Settings</h1>

      {/* ── 1. Reading Profile ──────────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Reading Profile</h2>

        <div className="preset-grid" role="radiogroup" aria-label="Reading presets">
          {PRESETS.map(preset => {
            const selected = profile.preset === preset.id;
            return (
              <button
                key={preset.id}
                className={`preset-card ${selected ? 'selected' : ''}`}
                role="radio"
                aria-checked={selected}
                onClick={() => applyPreset(preset)}
              >
                <span className="preset-card-name">{preset.name}</span>
                <span className="preset-card-desc">{preset.description}</span>
              </button>
            );
          })}
        </div>
        {(profile.preset === undefined || profile.preset === 'custom') && (
          <p className="settings-hint">Custom settings: pick a preset above, or adjust the fields below.</p>
        )}

        <h3 className="settings-subheading">Advanced</h3>

        <div className="form-group">
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
        </div>

        <div className="form-group">
          <label htmlFor="target-grade">
            Target Grade Level
            <span className="form-hint"> — controls how much the AI simplifies text</span>
          </label>
          <div className="slider-row">
            <input
              id="target-grade"
              type="range"
              min={1}
              max={16}
              value={effectiveGrade}
              onChange={e => updateProfile({ targetGradeLevel: parseInt(e.target.value, 10) })}
            />
            <span className="slider-value">
              {profile.targetGradeLevel === 'auto' ? `Auto (${effectiveGrade})` : `Grade ${effectiveGrade}`}
            </span>
            {profile.targetGradeLevel !== 'auto' && (
              <button className="reset-btn" onClick={() => updateProfile({ targetGradeLevel: 'auto' })}>
                Reset to Auto
              </button>
            )}
          </div>
        </div>

        <div className="form-group">
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
        </div>

        <div className="form-group">
          <label htmlFor="style">Preferred Style</label>
          <select
            id="style"
            value={profile.preferredStyle}
            onChange={e => updateProfile({ preferredStyle: e.target.value as UserProfile['preferredStyle'] })}
          >
            <option value="plain">Plain language</option>
            <option value="bullet-summary">Bullet summary</option>
            <option value="eli5">ELI5 (explain like I'm 5)</option>
            <option value="concise">Concise</option>
          </select>
        </div>

        <div className="form-group">
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
      </section>

      {/* ── 2. AI Model ────────────────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">AI Model</h2>
        <div className="form-group">
          <label htmlFor="llm-model">
            Ollama model
            <span className="form-hint"> — used for new simplifications</span>
          </label>
          <select
            id="llm-model"
            value={llmModel}
            onChange={e => handleModelChange(e.target.value)}
            disabled={installed === 'loading'}
          >
            {modelOptions.map(name => (
              <option key={name} value={name}>
                {name}{modelMissing && name === llmModel ? ' (not installed)' : ''}
              </option>
            ))}
          </select>
        </div>
        {installed === 'error' && (
          <p className="settings-hint">
            Can't reach Ollama, so installed models can't be listed. Start Ollama and reopen Settings.
          </p>
        )}
        {modelMissing && (
          <p className="settings-hint">
            This model isn't installed in Ollama. Install it (see README.md) or pick another.
            {llmModel !== DEFAULT_LLM_MODEL && (
              <> The default is <code>{DEFAULT_LLM_MODEL}</code>.</>
            )}
            {llmModel !== LIGHT_LLM_MODEL && (
              <> On a slower computer, <code>{LIGHT_LLM_MODEL}</code> is a lighter option.</>
            )}
          </p>
        )}

        <div className="form-group">
          <label htmlFor="quality-mode">
            Quality mode
            <span className="form-hint"> — how carefully the meaning check works</span>
          </label>
          <select
            id="quality-mode"
            value={qualityMode}
            onChange={e => handleQualityModeChange(e.target.value as QualityModeSetting)}
          >
            <option value="auto">Auto (recommended)</option>
            <option value="full">Full</option>
            <option value="lite">Lite</option>
          </select>
        </div>
        <p className="settings-hint">{QUALITY_MODE_HINT[qualityMode]}</p>
        {qualityMode === 'auto' && (
          <p className="settings-hint">
            {nliBench
              ? `Auto currently uses: ${autoChoiceLabel(nliBench)}.`
              : 'Auto measures this computer on the first simplification.'}
          </p>
        )}

        <div className="form-group form-group-inline">
          <label htmlFor="extra-quality-toggle">
            Extra quality (slower)
            <span className="form-hint">
              {' '}— if a paragraph scores low, tries two other prompt styles and keeps the best
              (up to 3× slower for those paragraphs)
            </span>
          </label>
          <button
            id="extra-quality-toggle"
            className={`toggle-switch ${extraQuality ? 'on' : ''}`}
            onClick={toggleExtraQuality}
            role="switch"
            aria-checked={extraQuality}
          >
            <span className="toggle-thumb" />
          </button>
        </div>
      </section>

      {/* ── 3. Display Preferences ─────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Display</h2>

        <div className="form-group form-group-inline">
          <label htmlFor="dyslexia-toggle">Dyslexia-friendly font (OpenDyslexic)</label>
          <button
            id="dyslexia-toggle"
            className={`toggle-switch ${displayPrefs.dyslexiaFont ? 'on' : ''}`}
            onClick={() => onUpdatePrefs({ dyslexiaFont: !displayPrefs.dyslexiaFont })}
            role="switch"
            aria-checked={displayPrefs.dyslexiaFont}
          >
            <span className="toggle-thumb" />
          </button>
        </div>

        <div className="form-group">
          <label htmlFor="text-size">Text Size in Reading view</label>
          <select
            id="text-size"
            value={displayPrefs.textSize}
            onChange={e => onUpdatePrefs({ textSize: e.target.value as DisplayPrefs['textSize'] })}
          >
            <option value="normal">Normal (16px)</option>
            <option value="large">Large (19px)</option>
            <option value="xlarge">Extra Large (22px)</option>
          </select>
        </div>

        <div className="form-group form-group-inline">
          <label htmlFor="focus-toggle">
            Focus mode
            <span className="form-hint"> — dims paragraphs you're not hovering over</span>
          </label>
          <button
            id="focus-toggle"
            className={`toggle-switch ${displayPrefs.focusMode ? 'on' : ''}`}
            onClick={() => onUpdatePrefs({ focusMode: !displayPrefs.focusMode })}
            role="switch"
            aria-checked={displayPrefs.focusMode}
          >
            <span className="toggle-thumb" />
          </button>
        </div>
      </section>

      {/* ── 4. Vocabulary ──────────────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Custom Common Words</h2>
        <p className="settings-hint">
          Words listed here won't be counted as jargon in readability reports.
          One word per line or comma-separated.
        </p>
        <textarea
          rows={6}
          className="word-textarea"
          value={customWords}
          onChange={e => setCustomWords(e.target.value)}
          placeholder={'quantum\nphotosynthesis\nmitochondria'}
          spellCheck={false}
        />
        <div className="form-actions">
          <button className="btn-primary" onClick={handleSaveWords}>Save words</button>
          <StatusTag status={wordStatus} />
        </div>
      </section>

      {/* ── 5. Data ────────────────────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Data</h2>

        <div className="data-row">
          <div className="data-row-text">
            <div className="data-row-label">Clear document history</div>
            <div className="settings-hint">
              Removes all captured documents, simplified results and cached simplifications.
              Progress tracking data is <strong>not</strong> affected.
            </div>
          </div>
          <div className="data-row-action">
            <button className="btn-destructive" onClick={handleClearDocuments}>Clear</button>
            <StatusTag status={docStatus} />
          </div>
        </div>

        <div className="data-row">
          <div className="data-row-text">
            <div className="data-row-label">Reset progress history</div>
            <div className="settings-hint">
              Clears the weekly reading level trend only. Documents are <strong>not</strong> affected.
            </div>
          </div>
          <div className="data-row-action">
            <button className="btn-destructive" onClick={handleResetProgress}>Reset</button>
            <StatusTag status={progressStatus} />
          </div>
        </div>
      </section>

      {/* ── 6. About ───────────────────────────────────────────────────────── */}
      <section className="settings-section settings-section-about">
        <h2 className="settings-section-title">About</h2>
        <p className="settings-hint">
          <strong>Clarity</strong> v1.0.0 · All AI processing runs locally via Ollama — no text ever
          leaves your device.
          <br />
          Set <code>OLLAMA_ORIGINS=chrome-extension://emnnfgmpahidhdpdakmblphimmamckon</code> and restart
          Ollama for the extension to connect.
        </p>
      </section>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flash(setter: React.Dispatch<React.SetStateAction<SaveStatus>>, value: 'saved' | 'error') {
  setter(value);
  setTimeout(() => setter('idle'), 2500);
}

function StatusTag({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null;
  return (
    <span className={`status-tag ${status === 'saved' ? 'status-ok' : 'status-err'}`}>
      {status === 'saved' ? '✓ Done' : '✗ Failed'}
    </span>
  );
}
