/**
 * User settings in chrome.storage.sync: the reading profile (`userProfile`),
 * the chat model (`llmModel`) and the "Extra quality" toggle (`extraQuality`).
 * All fall back to defaults when unset.
 */

import { DEFAULT_LLM_MODEL } from '../llm/ollama-provider';
import type { UserProfile } from '../../types';

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
