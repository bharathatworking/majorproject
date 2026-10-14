import { describe, it, expect, vi } from 'vitest';
import {
  averageSimilarity, checkMeaning, cosineSimilarity, findMissingEntities, MIN_WORDS_FOR_CHECK,
  passesChecks, pickBetterVersion, shouldCheckNode, SIMILARITY_THRESHOLD,
} from '../../src/lib/quality/semantic';
import type { ContentNode, Entity, MeaningCandidate, StoredResult } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Unit vector whose cosine with [1, 0] is exactly `sim`. */
const vec = (sim: number) => [sim, Math.sqrt(1 - sim * sim)];

function entity(text: string, type: Entity['type'] = 'person'): Entity {
  return { text, type, start: 0, end: text.length };
}

function candidate(similarity: number | undefined, missingEntities: string[] = [], text = 'x'): MeaningCandidate {
  return { text, similarity, missingEntities };
}

function result(similarity: number | undefined, status: StoredResult['status'] = 'done'): StoredResult {
  return { nodeId: 'n0', originalText: 'o', simplifiedText: 's', status, type: 'paragraph', similarity };
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------
describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1);
  });

  it('returns 0 when either vector is all zeros', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('throws on a length mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/mismatch/);
  });
});

// ---------------------------------------------------------------------------
// checkMeaning — threshold
// ---------------------------------------------------------------------------
describe('checkMeaning', () => {
  it('embeds both texts in one call', async () => {
    const embed = vi.fn(async () => [[1, 0], [1, 0]]);
    await checkMeaning('original', 'simple', embed);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(['original', 'simple']);
  });

  it('passes at exactly the threshold and fails just below it', async () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.8);
    const at = await checkMeaning('a', 'b', async () => [[1, 0], vec(0.8)]);
    expect(at.similarity).toBeCloseTo(0.8);
    expect(at.passed).toBe(true);

    const below = await checkMeaning('a', 'b', async () => [[1, 0], vec(0.79)]);
    expect(below.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findMissingEntities
// ---------------------------------------------------------------------------
describe('findMissingEntities', () => {
  it('finds names regardless of case and possessive', () => {
    const entities = [entity('Marie Curie'), entity('Paris', 'place')];
    expect(findMissingEntities(entities, "marie curie's lab was in PARIS.")).toEqual([]);
  });

  it('reports a dropped name once', () => {
    const entities = [entity('Marie Curie'), entity('Marie Curie')];
    expect(findMissingEntities(entities, 'She won a prize.')).toEqual(['Marie Curie']);
  });

  it('matches whole words only', () => {
    expect(findMissingEntities([entity('Ann')], 'The annual report.')).toEqual(['Ann']);
  });

  it('ignores thousands separators and matches number words by value', () => {
    expect(findMissingEntities([entity('1,500', 'number')], 'It cost 1500 dollars.')).toEqual([]);
    expect(findMissingEntities([entity('three', 'number')], 'There were 3 people.')).toEqual([]);
    expect(findMissingEntities([entity('three', 'number')], 'There were 4 people.')).toEqual(['three']);
  });

  it('keeps dates as written', () => {
    expect(findMissingEntities([entity('1903', 'date')], 'In 1903, she won.')).toEqual([]);
    expect(findMissingEntities([entity('1903', 'date')], 'Long ago, she won.')).toEqual(['1903']);
  });
});

// ---------------------------------------------------------------------------
// shouldCheckNode
// ---------------------------------------------------------------------------
describe('shouldCheckNode', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const node = (type: ContentNode['type'], text: string): ContentNode => ({ id: 'n0', type, text });

  it('checks paragraphs with at least MIN_WORDS_FOR_CHECK words', () => {
    expect(MIN_WORDS_FOR_CHECK).toBe(8);
    expect(shouldCheckNode(node('paragraph', words(8)))).toBe(true);
    expect(shouldCheckNode(node('paragraph', words(7)))).toBe(false);
  });

  it('never checks headings', () => {
    expect(shouldCheckNode(node('heading', words(12)))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// passesChecks / pickBetterVersion — retry selection
// ---------------------------------------------------------------------------
describe('passesChecks', () => {
  it('needs the threshold and no missing entities', () => {
    expect(passesChecks(candidate(0.9))).toBe(true);
    expect(passesChecks(candidate(0.7))).toBe(false);
    expect(passesChecks(candidate(0.9, ['Paris']))).toBe(false);
  });

  it('judges entities alone when similarity is unmeasured', () => {
    expect(passesChecks(candidate(undefined))).toBe(true);
    expect(passesChecks(candidate(undefined, ['Paris']))).toBe(false);
  });
});

describe('pickBetterVersion', () => {
  it('prefers a passing version over a failing one with higher similarity', () => {
    const original = candidate(0.95, ['Marie Curie'], 'original');
    const retry = candidate(0.85, [], 'retry');
    expect(pickBetterVersion(original, retry).text).toBe('retry');
  });

  it('keeps the higher similarity when both fail', () => {
    expect(pickBetterVersion(candidate(0.7, [], 'o'), candidate(0.6, [], 'r')).text).toBe('o');
    expect(pickBetterVersion(candidate(0.6, [], 'o'), candidate(0.7, [], 'r')).text).toBe('r');
  });

  it('keeps the higher similarity when both pass', () => {
    expect(pickBetterVersion(candidate(0.85, [], 'o'), candidate(0.92, [], 'r')).text).toBe('r');
  });

  it('falls back to fewer missing entities on equal similarity', () => {
    const original = candidate(0.7, ['a', 'b'], 'o');
    expect(pickBetterVersion(original, candidate(0.7, ['a'], 'r')).text).toBe('r');
  });

  it('without similarity, keeps fewer missing entities and the original on ties', () => {
    expect(pickBetterVersion(candidate(undefined, ['a', 'b'], 'o'), candidate(undefined, ['a'], 'r')).text).toBe('r');
    expect(pickBetterVersion(candidate(undefined, ['a'], 'o'), candidate(undefined, ['b'], 'r')).text).toBe('o');
  });
});

// ---------------------------------------------------------------------------
// averageSimilarity
// ---------------------------------------------------------------------------
describe('averageSimilarity', () => {
  it('averages done results that were checked', () => {
    const avg = averageSimilarity([result(0.9), result(0.8), result(undefined), result(0.1, 'error')]);
    expect(avg).toBeCloseTo(0.85);
  });

  it('returns null when nothing was checked', () => {
    expect(averageSimilarity([])).toBeNull();
    expect(averageSimilarity([result(undefined)])).toBeNull();
  });
});
