import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from '../mocks/chrome';
import {
  cacheKey, getCached, putCached, clearCache, CACHE_MAX_ENTRIES,
} from '../../src/lib/storage/cache';
import { resolveProfile } from '../../src/lib/profile/resolver';
import { DEFAULT_PROFILE } from '../../src/lib/storage/settings';
import type { SimplificationSpec } from '../../src/types';

const SPEC: SimplificationSpec = resolveProfile(DEFAULT_PROFILE, 14);
const TEXT = 'Photosynthesis converts light energy into chemical energy.';
const MODEL = 'qwen2.5:3b';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const index = () => mock.areas.local.data.get('cache:index') as string[] | undefined;

// ---------------------------------------------------------------------------
// cacheKey — sha256(node text + spec JSON + model)
// ---------------------------------------------------------------------------
describe('cacheKey', () => {
  it('is a stable 64-character hex digest', async () => {
    const key = await cacheKey(TEXT, SPEC, MODEL);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await cacheKey(TEXT, { ...SPEC }, MODEL)).toBe(key);
  });

  it('changes with the node text', async () => {
    expect(await cacheKey(`${TEXT} `, SPEC, MODEL)).not.toBe(await cacheKey(TEXT, SPEC, MODEL));
  });

  it('changes with any spec field', async () => {
    const key = await cacheKey(TEXT, SPEC, MODEL);
    const variants: Partial<SimplificationSpec>[] = [
      { targetGrade: SPEC.targetGrade + 1 },
      { depthTier: 'aggressive' },
      { maxSentenceLength: SPEC.maxSentenceLength + 1 },
      { explainTerms: !SPEC.explainTerms },
      { avoidIdioms: !SPEC.avoidIdioms },
      { tone: 'formal' },
    ];
    for (const patch of variants) {
      expect(await cacheKey(TEXT, { ...SPEC, ...patch }, MODEL)).not.toBe(key);
    }
  });

  it('changes with the model', async () => {
    expect(await cacheKey(TEXT, SPEC, 'llama3.2:1b')).not.toBe(await cacheKey(TEXT, SPEC, MODEL));
  });

  it('ignores spec property order', async () => {
    const reversed = Object.fromEntries(Object.entries(SPEC).reverse()) as SimplificationSpec;
    expect(await cacheKey(TEXT, reversed, MODEL)).toBe(await cacheKey(TEXT, SPEC, MODEL));
  });

  it('keeps text and spec apart (no ambiguous concatenation)', async () => {
    expect(await cacheKey('a', SPEC, 'b')).not.toBe(await cacheKey('', SPEC, 'ab'));
  });

  it("separates 'extra' quality results and leaves 'standard' keys unchanged", async () => {
    const plain = await cacheKey(TEXT, SPEC, MODEL);
    expect(await cacheKey(TEXT, SPEC, MODEL, 'standard')).toBe(plain);
    expect(await cacheKey(TEXT, SPEC, MODEL, 'extra')).not.toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// getCached / putCached / clearCache — 2,000-entry LRU in storage.local
// ---------------------------------------------------------------------------
describe('result cache store', () => {
  it('caps at 2,000 entries by default', () => {
    expect(CACHE_MAX_ENTRIES).toBe(2000);
  });

  it('round-trips a result and misses unknown keys', async () => {
    await putCached('k1', { text: 'Plants make food from light.', similarity: 0.9 });
    expect(await getCached('k1')).toEqual({ text: 'Plants make food from light.', similarity: 0.9 });
    expect(await getCached('nope')).toBeNull();
  });

  it('evicts the least recently used entry past the cap', async () => {
    await putCached('a', { text: 'A' }, 2);
    await putCached('b', { text: 'B' }, 2);
    await putCached('c', { text: 'C' }, 2);

    expect(await getCached('a')).toBeNull();
    expect(mock.areas.local.data.has('cache:a')).toBe(false);
    expect(index()).toEqual(['b', 'c']);
  });

  it('a hit refreshes recency, so another entry is evicted instead', async () => {
    await putCached('a', { text: 'A' }, 2);
    await putCached('b', { text: 'B' }, 2);
    await getCached('a');
    await putCached('c', { text: 'C' }, 2);

    expect(await getCached('a')).toEqual({ text: 'A' });
    expect(await getCached('b')).toBeNull();
  });

  it('re-putting a key updates it without duplicating the index entry', async () => {
    await putCached('a', { text: 'old' });
    await putCached('a', { text: 'new' });
    expect(index()).toEqual(['a']);
    expect(await getCached('a')).toEqual({ text: 'new' });
  });

  it('serializes concurrent writes', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map(k => putCached(k, { text: k }, 3)));
    expect(index()).toEqual(['b', 'c', 'd']);
  });

  it('clearCache removes every entry and the index, nothing else', async () => {
    await mock.areas.local.set({ 'doc:x': { id: 'x' } });
    await putCached('a', { text: 'A' });
    await putCached('b', { text: 'B' });

    await clearCache();

    expect([...mock.areas.local.data.keys()]).toEqual(['doc:x']);
  });
});
