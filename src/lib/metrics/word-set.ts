import { BASE_COMMON_WORDS } from './common-words';

/**
 * Returns a Set combining BASE_COMMON_WORDS with any custom words the user has
 * added in Settings (stored in chrome.storage.sync under 'customWords').
 *
 * Custom words are split on newlines and commas, trimmed, and lowercased before
 * merging. Non-fatal if storage is unavailable (e.g. in tests) — falls back to
 * BASE_COMMON_WORDS only.
 *
 * This is the fix for the bug where computeReadabilityReport() was always called
 * with BASE_COMMON_WORDS alone, silently ignoring the user's vocabulary list.
 */
export async function getCommonWordSet(): Promise<Set<string>> {
  const wordSet = new Set(BASE_COMMON_WORDS);
  try {
    const { customWords } = await chrome.storage.sync.get('customWords');
    if (customWords && typeof customWords === 'string') {
      for (const word of customWords.split(/[\n,]+/)) {
        const trimmed = word.trim().toLowerCase();
        if (trimmed) wordSet.add(trimmed);
      }
    }
  } catch {
    // Storage unavailable (e.g. in tests) — return base set unchanged.
  }
  return wordSet;
}
