import type { CacheEntry, ReadabilityReport, SimplificationResult } from '../../types';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function getCacheEntry(contentHash: string): Promise<CacheEntry | null> {
  const data = await chrome.storage.local.get(contentHash);
  const entry = data[contentHash];
  
  if (!entry) return null;
  
  if (Date.now() - entry.timestamp > SEVEN_DAYS_MS) {
    await chrome.storage.local.remove(contentHash);
    return null;
  }
  
  return entry;
}

export async function saveCacheEntry(
  contentHash: string, 
  report: ReadabilityReport, 
  results: SimplificationResult[]
): Promise<void> {
  const entry: CacheEntry = {
    report,
    results,
    timestamp: Date.now()
  };
  await chrome.storage.local.set({ [contentHash]: entry });
}

export async function clearOldCache(): Promise<void> {
  const data = await chrome.storage.local.get(null);
  const keysToRemove: string[] = [];
  const now = Date.now();
  
  for (const [key, value] of Object.entries(data)) {
    if (value.timestamp && now - value.timestamp > SEVEN_DAYS_MS) {
      keysToRemove.push(key);
    }
  }
  
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}
