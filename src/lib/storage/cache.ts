/**
 * Simplification result cache, shared by all documents.
 *
 * Storage layout in chrome.storage.local:
 *   cache:<hash>  — CachedResult for one node
 *   cache:index   — string[] of hashes, least recently used first
 *
 * Design decisions:
 *  - The key is sha256(node text + spec JSON + model name), so a profile or
 *    model change misses naturally. The spec JSON has sorted keys, so property
 *    order can't change the key. "Extra quality" runs add a quality tag, so
 *    A/B runs never share outputs. The rolling context is not part of the key:
 *    it only nudges wording, and including it would make a node's key depend
 *    on its neighbours.
 *  - LRU with CACHE_MAX_ENTRIES entries. A hit moves the key to the end of the
 *    index; a put past the cap evicts from the front.
 *  - Every write (including the recency touch on a hit) goes through this
 *    module's own write queue, as in documents.ts.
 *  - The run loop decides what is worth caching (see lib/run/simplify.ts).
 *  - Entries carry CACHE_FORMAT. An entry of another format (e.g. one cached
 *    before the thesis meaning standard, judged by the old 0.80 threshold
 *    without NLI) is a miss, so a stale verdict is never reused. The key is
 *    unchanged, so the next put simply overwrites it.
 */

import { sha256 } from '../utils/hash';
import { createWriteQueue } from '../utils/write-queue';
import type { CachedResult, SimplificationSpec } from '../../types';

export const CACHE_MAX_ENTRIES = 2000;
/** Format of CachedResult; 2 = with the thesis meaning assessment. */
export const CACHE_FORMAT = 2;
const CACHE_PREFIX = 'cache:';
const CACHE_INDEX_KEY = 'cache:index';

/** Typed view of the cache:* keys in chrome.storage.local, for `get<…>()`. */
type CacheArea = Record<string, CachedResult | string[] | undefined>;

const enqueue = createWriteQueue();

// ─── Key ──────────────────────────────────────────────────────────────────────

/** JSON with object keys sorted, so equal specs always serialize the same way. */
function stableJson(spec: SimplificationSpec): string {
  return JSON.stringify(spec, Object.keys(spec).sort());
}

/**
 * Cache key for one node under one spec, model and quality mode (hex
 * SHA-256). 'standard' adds nothing, so keys from before the quality mode
 * existed stay valid.
 */
export function cacheKey(
  nodeText: string,
  spec: SimplificationSpec,
  model: string,
  quality: 'standard' | 'extra' = 'standard',
): Promise<string> {
  const suffix = quality === 'extra' ? '\u0000extra' : '';
  return sha256(`${nodeText}\u0000${stableJson(spec)}\u0000${model}${suffix}`);
}

// ─── Read / write ─────────────────────────────────────────────────────────────

async function readIndex(): Promise<string[]> {
  const { [CACHE_INDEX_KEY]: raw } = await chrome.storage.local.get<CacheArea>(CACHE_INDEX_KEY);
  return Array.isArray(raw) ? raw : [];
}

/**
 * Cached result for `key`, or null (also for an entry of another format). A
 * hit marks the entry as most recently used.
 */
export async function getCached(key: string): Promise<CachedResult | null> {
  const entryKey = `${CACHE_PREFIX}${key}`;
  const { [entryKey]: raw } = await chrome.storage.local.get<CacheArea>(entryKey);
  if (!raw || Array.isArray(raw) || raw.format !== CACHE_FORMAT) return null;

  await enqueue(async () => {
    const index = (await readIndex()).filter(k => k !== key);
    index.push(key);
    await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index });
  });
  return raw;
}

/** Stores `value` (stamped CACHE_FORMAT) under `key`, evicting least recently used entries past `cap`. */
export function putCached(
  key: string,
  value: CachedResult,
  cap: number = CACHE_MAX_ENTRIES,
): Promise<void> {
  return enqueue(async () => {
    const index = (await readIndex()).filter(k => k !== key);
    index.push(key);
    const evicted = index.length > cap ? index.splice(0, index.length - cap) : [];
    if (evicted.length > 0) {
      await chrome.storage.local.remove(evicted.map(k => `${CACHE_PREFIX}${k}`));
    }
    await chrome.storage.local.set({
      [`${CACHE_PREFIX}${key}`]: { ...value, format: CACHE_FORMAT },
      [CACHE_INDEX_KEY]: index,
    });
  });
}

/** Removes every cache entry and the index. */
export function clearCache(): Promise<void> {
  return enqueue(async () => {
    const index = await readIndex();
    await chrome.storage.local.remove([...index.map(k => `${CACHE_PREFIX}${k}`), CACHE_INDEX_KEY]);
  });
}
