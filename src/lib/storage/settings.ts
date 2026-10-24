/**
 * User settings in chrome.storage.sync: the reading profile (`userProfile`),
 * the chat model (`llmModel`), the "Extra quality" toggle (`extraQuality`)
 * and the quality mode (`qualityMode`). All fall back to defaults when unset.
 *
 * Dev-only A/B switches (chrome.storage.local, `debug:` keys, like
 * debug:nliDevice): read only when import.meta.env.DEV, so `npm run build`
 * replaces the check with `false` and drops the reads, and the store build
 * can never reach them. Both are off unless the key is set by hand in the
 * extension page's console.
 */

import { DEFAULT_LLM_MODEL } from '../llm/ollama-provider';
import { GRADE_RETRY_ENABLED, GRADE_WORDING_ENABLED } from '../quality/config';
import type { GradeTargeting, QualityModeSetting, UserProfile } from '../../types';

// ─── Profile ──────────────────────────────────────────────────────────────────

export const DEFAULT_PROFILE: UserProfile = {
  ageGroup: 'adult',
  targetGradeLevel: 'auto',
  readingPurpose: 'general',
  domainFamiliarity: 'novice',
  preferredStyle: 'plain'
};

export async function getUserProfile(): Promise<UserProfile> {
  const { userProfile } = await chrome.storage.sync.get<{ userProfile?: UserProfile }>('userProfile');
  return userProfile || DEFAULT_PROFILE;
}

export async function saveUserProfile(profile: UserProfile): Promise<void> {
  await chrome.storage.sync.set({ userProfile: profile });
}

// ─── Model ────────────────────────────────────────────────────────────────────

/** Saved Ollama chat model, or DEFAULT_LLM_MODEL when unset or invalid. */
export async function getLlmModel(): Promise<string> {
  const { llmModel } = await chrome.storage.sync.get<{ llmModel?: unknown }>('llmModel');
  return typeof llmModel === 'string' && llmModel.trim() ? llmModel.trim() : DEFAULT_LLM_MODEL;
}

export async function saveLlmModel(model: string): Promise<void> {
  await chrome.storage.sync.set({ llmModel: model });
}

// ─── Extra quality ────────────────────────────────────────────────────────────

/**
 * "Extra quality (slower)": low-scoring nodes also try the other prompt
 * variants (see lib/run/simplify.ts). Off unless saved as true.
 */
export async function getExtraQuality(): Promise<boolean> {
  const { extraQuality } = await chrome.storage.sync.get<{ extraQuality?: unknown }>('extraQuality');
  return extraQuality === true;
}

export async function saveExtraQuality(on: boolean): Promise<void> {
  await chrome.storage.sync.set({ extraQuality: on });
}

// ─── Quality mode ─────────────────────────────────────────────────────────────

const QUALITY_MODES: readonly QualityModeSetting[] = ['auto', 'full', 'lite'];

/** Quality mode setting (see lib/quality/mode.ts); 'auto' unless a valid value is saved. */
export async function getQualityMode(): Promise<QualityModeSetting> {
  const { qualityMode } = await chrome.storage.sync.get<{ qualityMode?: unknown }>('qualityMode');
  return QUALITY_MODES.find(m => m === qualityMode) ?? 'auto';
}

export async function saveQualityMode(mode: QualityModeSetting): Promise<void> {
  await chrome.storage.sync.set({ qualityMode: mode });
}

// ─── Dev-only A/B switches ────────────────────────────────────────────────────

/** Models the dev model override accepts (the Prompt 10 LoRA, not adopted). */
export const DEV_MODEL_OVERRIDES: readonly string[] = ['clarity-simplify'];

/**
 * Dev build only: local `debug:llmModelOverride` = 'clarity-simplify' runs
 * that model instead of the saved one, for A/B comparison. Null in the store
 * build, when unset, or for any other value.
 */
export async function getDevModelOverride(): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  const data = await chrome.storage.local.get<{ 'debug:llmModelOverride'?: unknown }>('debug:llmModelOverride');
  const value = data['debug:llmModelOverride'];
  return typeof value === 'string' && DEV_MODEL_OVERRIDES.includes(value) ? value : null;
}

/**
 * Grade-aware wording and the grade retry (Prompt 11): GRADE_WORDING_ENABLED
 * and GRADE_RETRY_ENABLED from config.ts (both off until
 * eval/grade-targeting/REPORT.md). Dev build only: local
 * `debug:gradeTargeting` = 'wording' (arm B), 'retry' (arm C: wording and
 * retry) or 'off' overrides them.
 */
export async function getGradeTargeting(): Promise<GradeTargeting> {
  const defaults: GradeTargeting = { wording: GRADE_WORDING_ENABLED, retry: GRADE_RETRY_ENABLED };
  if (!import.meta.env.DEV) return defaults;
  const data = await chrome.storage.local.get<{ 'debug:gradeTargeting'?: unknown }>('debug:gradeTargeting');
  switch (data['debug:gradeTargeting']) {
    case 'off': return { wording: false, retry: false };
    case 'wording': return { wording: true, retry: false };
    case 'retry': return { wording: true, retry: true };
    default: return defaults;
  }
}
