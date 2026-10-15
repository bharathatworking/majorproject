/**
 * User settings in chrome.storage.sync: the reading profile (`userProfile`)
 * and the chat model (`llmModel`). Both fall back to defaults when unset.
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
