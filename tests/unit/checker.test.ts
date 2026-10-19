import { describe, it, expect } from 'vitest';
import {
  checkerFeatures, combinedScore, FEATURES, harmfulFeatures, lengthRatioOf, LITE_FEATURES, NLI_FEATURES,
  sigmoid, standardise, usesNli, worstFeature,
} from '../../src/lib/quality/checker';
import type { SentenceScore } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MODEL = {
  features: ['sbert', 'entity'] as const,
  means: [0.8, 0.5],
  stds: [0.1, 0.25],
  weights: [2, -1],
  bias: 0.5,
};

function sentence(entailment: number, contradiction: number, exempt = false): SentenceScore {
  return { sentence: 's', entailment, contradiction, exempt };
}

// ─── Scoring math ─────────────────────────────────────────────────────────────

describe('combinedScore', () => {
  it('known weights give a known output', () => {
    // z = [(0.9 − 0.8)/0.1, (1 − 0.5)/0.25] = [1, 2]; t = 0.5 + 2·1 − 1·2 = 0.5
    const r = combinedScore(MODEL, { sbert: 0.9, entity: 1 });
    expect(r.score).toBeCloseTo(1 / (1 + Math.exp(-0.5)), 12);
    expect(r.score).toBeCloseTo(0.6224593312, 9);
    expect(r.contributions.sbert).toBeCloseTo(2, 12);
    expect(r.contributions.entity).toBeCloseTo(-2, 12);
    expect(r.missing).toEqual([]);
  });

  it('a missing feature is scored at its training mean (z = 0)', () => {
    const r = combinedScore(MODEL, { sbert: null, entity: 1 });
    expect(r.missing).toEqual(['sbert']);
    expect(r.contributions.sbert).toBe(0);
    expect(r.score).toBeCloseTo(sigmoid(0.5 - 2), 12);
  });

  it('ignores features the model does not use', () => {
    expect(combinedScore(MODEL, { sbert: 0.9, entity: 1, contra: 0.99 }).score)
      .toBe(combinedScore(MODEL, { sbert: 0.9, entity: 1 }).score);
  });
});

describe('standardise', () => {
  it('(x − mean) / std, with a zero std counted as 1', () => {
    expect(standardise([3, 7, 2], [1, 7, 2], [2, 0, 0.5])).toEqual([1, 0, 0]);
  });
});

describe('sigmoid', () => {
  it('is 0.5 at 0 and symmetric', () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(2) + sigmoid(-2)).toBeCloseTo(1, 12);
  });
});

// ─── Features ─────────────────────────────────────────────────────────────────

describe('feature sets', () => {
  it('LITE candidates use no NLI feature', () => {
    expect(LITE_FEATURES).toEqual(['sbert', 'entity', 'numbers', 'lenRatio']);
    expect(LITE_FEATURES.some(f => NLI_FEATURES.has(f))).toBe(false);
    expect(FEATURES).toHaveLength(8);
    expect(usesNli({ features: ['sbert', 'contra'] })).toBe(true);
    expect(usesNli({ features: LITE_FEATURES })).toBe(false);
  });
});

describe('checkerFeatures', () => {
  const base = { similarity: 0.9, entityRecall: 0.75, mainClaimEntailment: 0.6, keyKept: 0.5, lengthRatio: 0.8 };

  it('min and mean entailment skip exempt sentences; contradiction counts every sentence', () => {
    const f = checkerFeatures({ ...base, sentenceScores: [sentence(0.9, 0.05), sentence(0.5, 0.1), sentence(0.01, 0.7, true)] });
    expect(f).toEqual({
      sbert: 0.9, entity: 0.75, nliMin: 0.5, nliMean: 0.7, contra: 0.7, mainClaim: 0.6, numbers: 0.5, lenRatio: 0.8,
    });
  });

  it('no NLI → every NLI feature but mainClaim is null', () => {
    const f = checkerFeatures({ ...base, sentenceScores: null, mainClaimEntailment: null });
    expect([f.nliMin, f.nliMean, f.contra, f.mainClaim]).toEqual([null, null, null, null]);
    expect(f.sbert).toBe(0.9);
  });

  it('an output with no sentences scores 0; only exempt sentences scores 1', () => {
    expect(checkerFeatures({ ...base, sentenceScores: [] })).toMatchObject({ nliMin: 0, nliMean: 0, contra: 0 });
    expect(checkerFeatures({ ...base, sentenceScores: [sentence(0.1, 0.2, true)] })).toMatchObject({ nliMin: 1, nliMean: 1, contra: 0.2 });
  });

  it('lengthRatioOf counts whitespace words', () => {
    expect(lengthRatioOf('one two three four', 'one two')).toBe(0.5);
    expect(lengthRatioOf('', 'x')).toBe(0);
  });
});

// ─── Which feature hurt ───────────────────────────────────────────────────────

describe('harmfulFeatures / worstFeature', () => {
  it('orders negative contributions, most harmful first', () => {
    const c = { sbert: 0.4, numbers: -1.2, contra: -0.3, entity: -1.2 };
    expect(harmfulFeatures(c)).toEqual(['entity', 'numbers', 'contra']);
    expect(worstFeature(c)).toBe('entity');
  });

  it('worstFeature is the lowest contribution even when none is negative', () => {
    expect(harmfulFeatures({ sbert: 0.4, lenRatio: 0.1 })).toEqual([]);
    expect(worstFeature({ sbert: 0.4, lenRatio: 0.1 })).toBe('lenRatio');
    expect(worstFeature({})).toBeNull();
  });
});
