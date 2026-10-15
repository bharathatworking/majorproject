import { describe, it, expect } from 'vitest';
import {
  scoreCandidate, pickBestCandidate, readabilityScore, lengthScore,
  WEIGHTS, QUALITY_THRESHOLD, GRADE_GAP_SCALE, BELOW_TARGET_FACTOR, LENGTH_MAX, LENGTH_MIN,
  type ScoredCandidate,
} from '../../src/lib/quality/score';
import { estimateNodeGrade } from '../../src/lib/metrics/node-grade';
import type { CandidateScores, SimplificationSpec } from '../../src/types';

const words = new Set<string>();

function spec(targetGrade: number): SimplificationSpec {
  return {
    targetGrade, depthTier: 'moderate', style: 'plain', preserveEntities: true,
    maxSentenceLength: 16, allowBullets: false, tone: '', explainTerms: false,
    keepTerms: false, avoidIdioms: false, oneIdeaPerSentence: false,
  };
}

const ORIGINAL =
  'Marie Curie received the Nobel Prize in Physics in 1903 for her research on radiation.';
const SIMPLE = 'Marie Curie won the Nobel Prize in 1903. She studied radiation.';

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------
describe('readabilityScore', () => {
  it('is 1 on target and falls to 0 at GRADE_GAP_SCALE grades too hard', () => {
    expect(readabilityScore(0)).toBe(1);
    expect(readabilityScore(GRADE_GAP_SCALE / 2)).toBeCloseTo(0.5);
    expect(readabilityScore(GRADE_GAP_SCALE)).toBe(0);
    expect(readabilityScore(GRADE_GAP_SCALE * 3)).toBe(0);
  });

  it('penalizes a gap below the target less than one above it', () => {
    expect(readabilityScore(-2)).toBeCloseTo(1 - (2 * BELOW_TARGET_FACTOR) / GRADE_GAP_SCALE);
    expect(readabilityScore(-2)).toBeGreaterThan(readabilityScore(2));
  });
});

describe('lengthScore', () => {
  it('is 1 in the ideal band', () => {
    expect(lengthScore(0.5)).toBe(1);
    expect(lengthScore(1)).toBe(1);
    expect(lengthScore(1.3)).toBe(1);
  });

  it('falls to 0 for outputs far too short or too long, and for empty output', () => {
    expect(lengthScore(LENGTH_MIN)).toBe(0);
    expect(lengthScore(LENGTH_MAX)).toBe(0);
    expect(lengthScore(3)).toBe(0);
    expect(lengthScore(0)).toBe(0);
    expect(lengthScore(0.3)).toBeGreaterThan(0);
    expect(lengthScore(0.3)).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate
// ---------------------------------------------------------------------------
describe('scoreCandidate', () => {
  it('weights sum to 1', () => {
    expect(WEIGHTS.meaning + WEIGHTS.readability + WEIGHTS.length).toBeCloseTo(1);
  });

  it('reports a signed grade gap against the target', () => {
    const grade = estimateNodeGrade(SIMPLE, words);
    const s = scoreCandidate({ original: ORIGINAL, simplified: SIMPLE, spec: spec(4), wordSet: words });
    expect(s.gradeGap).toBeCloseTo(grade - 4);
    const easyTarget = scoreCandidate({ original: ORIGINAL, simplified: SIMPLE, spec: spec(20), wordSet: words });
    expect(easyTarget.gradeGap).toBeLessThan(0);
  });

  it('total is the weighted sum of meaning, readability and length', () => {
    const target = 6;
    const s = scoreCandidate({
      original: ORIGINAL, simplified: SIMPLE, spec: spec(target), wordSet: words,
      similarity: 0.9, entityCount: 4, missingEntityCount: 1,
    });
    expect(s.similarity).toBe(0.9);
    expect(s.entityRecall).toBe(0.75);
    expect(s.lengthRatio).toBeCloseTo(11 / 15);
    const expected =
      WEIGHTS.meaning * 0.9 * 0.75 +
      WEIGHTS.readability * readabilityScore(s.gradeGap) +
      WEIGHTS.length * lengthScore(s.lengthRatio);
    expect(s.total).toBeCloseTo(expected);
  });

  it('uses entity recall alone for meaning when the similarity is unmeasured', () => {
    const s = scoreCandidate({
      original: ORIGINAL, simplified: SIMPLE, spec: spec(30), wordSet: words,
      entityCount: 2, missingEntityCount: 1,
    });
    expect(s.similarity).toBeNull();
    expect(s.entityRecall).toBe(0.5);
    // Far below target 30 still counts half, so compute rather than assume 1
    expect(s.total).toBeCloseTo(
      WEIGHTS.meaning * 0.5 + WEIGHTS.readability * readabilityScore(s.gradeGap) + WEIGHTS.length,
    );
  });

  it('gives full entity recall when the original has no entities', () => {
    const s = scoreCandidate({ original: ORIGINAL, simplified: SIMPLE, spec: spec(6), wordSet: words });
    expect(s.entityRecall).toBe(1);
  });

  it('scores an empty output low', () => {
    const s = scoreCandidate({
      original: ORIGINAL, simplified: '   ', spec: spec(6), wordSet: words, similarity: 0,
    });
    expect(s.lengthRatio).toBe(0);
    expect(s.total).toBe(0);
  });

  it('counts words without bullet markers', () => {
    const bullets = scoreCandidate({
      original: 'One two three four.', simplified: '- One two.\n- Three four.', spec: spec(6), wordSet: words,
    });
    expect(bullets.lengthRatio).toBe(1);
  });

  it('a faithful, on-level rewrite clears the quality threshold and a drifting one does not', () => {
    const good = scoreCandidate({
      original: ORIGINAL, simplified: SIMPLE, spec: spec(estimateNodeGrade(SIMPLE, words)), wordSet: words,
      similarity: 0.92, entityCount: 1, missingEntityCount: 0,
    });
    const bad = scoreCandidate({
      original: ORIGINAL, simplified: 'She liked science.', spec: spec(1), wordSet: words,
      similarity: 0.4, entityCount: 1, missingEntityCount: 1,
    });
    expect(good.total).toBeGreaterThanOrEqual(QUALITY_THRESHOLD);
    expect(bad.total).toBeLessThan(QUALITY_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// pickBestCandidate
// ---------------------------------------------------------------------------
describe('pickBestCandidate', () => {
  const scores = (total: number): CandidateScores =>
    ({ gradeGap: 0, similarity: null, entityRecall: 1, lengthRatio: 1, total });
  const cand = (
    text: string, total: number, extra: Partial<ScoredCandidate> = {},
  ): ScoredCandidate => ({ text, variant: 'standard', missingEntities: [], scores: scores(total), ...extra });

  it('keeps the highest total', () => {
    const best = pickBestCandidate([cand('a', 0.6), cand('b', 0.9), cand('c', 0.7)]);
    expect(best.text).toBe('b');
  });

  it('prefers a version that passes the 6C checks over a higher-scoring failing one', () => {
    const failing = cand('fails', 0.95, { missingEntities: ['Marie Curie'] });
    const lowSim = cand('low-sim', 0.9, { similarity: 0.5 });
    const passing = cand('passes', 0.7, { similarity: 0.85 });
    expect(pickBestCandidate([failing, lowSim, passing]).text).toBe('passes');
  });

  it('keeps the first candidate on a tie', () => {
    expect(pickBestCandidate([cand('first', 0.8), cand('second', 0.8)]).text).toBe('first');
  });

  it('picks by total when every candidate fails', () => {
    const a = cand('a', 0.5, { similarity: 0.6 });
    const b = cand('b', 0.6, { similarity: 0.7 });
    expect(pickBestCandidate([a, b]).text).toBe('b');
  });

  it('throws on an empty list', () => {
    expect(() => pickBestCandidate([])).toThrow();
  });
});
