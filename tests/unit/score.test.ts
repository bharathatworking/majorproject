import { describe, it, expect } from 'vitest';
import {
  scoreCandidate, pickBestCandidate, readabilityScore, lengthScore, type ScoredCandidate,
} from '../../src/lib/quality/score';
import {
  WEIGHTS, QUALITY_THRESHOLD, GRADE_GAP_SCALE, BELOW_TARGET_FACTOR, LENGTH_MAX, LENGTH_MIN,
} from '../../src/lib/quality/config';
import { estimateNodeGrade } from '../../src/lib/metrics/node-grade';
import { makeAssessment } from '../mocks/fixtures';
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

/** scoreCandidate input without a meaning assessment (an unchecked node). */
const input = (simplified: string, target: number, original = ORIGINAL) =>
  ({ original, simplified, spec: spec(target), wordSet: words, meaning: null });

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
    expect(scoreCandidate(input(SIMPLE, 4)).gradeGap).toBeCloseTo(grade - 4);
    expect(scoreCandidate(input(SIMPLE, 20)).gradeGap).toBeLessThan(0);
  });

  it('total is the weighted sum of meaning (the assessment), readability and length', () => {
    const meaning = makeAssessment({ similarity: 0.9, entityRecall: 0.75, minEntailment: 0.8, maxContradiction: 0.05 });
    const s = scoreCandidate({ ...input(SIMPLE, 6), meaning });
    expect(s).toMatchObject({ similarity: 0.9, entityRecall: 0.75, minEntailment: 0.8, maxContradiction: 0.05, passed: true });
    expect(s.lengthRatio).toBeCloseTo(11 / 15);
    const expected =
      WEIGHTS.meaning * 0.9 * 0.75 * 0.8 +
      WEIGHTS.readability * readabilityScore(s.gradeGap) +
      WEIGHTS.length * lengthScore(s.lengthRatio);
    expect(s.total).toBeCloseTo(expected);
  });

  it('records a failed assessment', () => {
    expect(scoreCandidate({ ...input(SIMPLE, 6), meaning: makeAssessment({ passed: false }) }).passed).toBe(false);
  });

  it('uses the measured parts only when a check fell back', () => {
    const meaning = makeAssessment({ similarity: null, entityRecall: 0.5, minEntailment: null, maxContradiction: null });
    const s = scoreCandidate({ ...input(SIMPLE, 30), meaning });
    expect(s.similarity).toBeNull();
    expect(s.minEntailment).toBeNull();
    // Far below target 30 still counts half, so compute rather than assume 1
    expect(s.total).toBeCloseTo(
      WEIGHTS.meaning * 0.5 + WEIGHTS.readability * readabilityScore(s.gradeGap) + WEIGHTS.length,
    );
  });

  it('gives an unchecked node full meaning', () => {
    const s = scoreCandidate(input(SIMPLE, 6));
    expect(s).toMatchObject({ similarity: null, entityRecall: 1, minEntailment: null, passed: true });
  });

  it('scores an empty output low', () => {
    const s = scoreCandidate({ ...input('   ', 6), meaning: makeAssessment({ similarity: 0 }) });
    expect(s.lengthRatio).toBe(0);
    expect(s.total).toBe(0);
  });

  it('counts words without bullet markers', () => {
    expect(scoreCandidate(input('- One two.\n- Three four.', 6, 'One two three four.')).lengthRatio).toBe(1);
  });

  it('a faithful, on-level rewrite clears the quality threshold and a drifting one does not', () => {
    const good = scoreCandidate({
      ...input(SIMPLE, estimateNodeGrade(SIMPLE, words)),
      meaning: makeAssessment({ similarity: 0.92, minEntailment: 0.95 }),
    });
    const bad = scoreCandidate({
      ...input('She liked science.', 1),
      meaning: makeAssessment({ similarity: 0.4, entityRecall: 0, minEntailment: 0.1, passed: false }),
    });
    expect(good.total).toBeGreaterThanOrEqual(QUALITY_THRESHOLD);
    expect(bad.total).toBeLessThan(QUALITY_THRESHOLD);
  });

  it('an unsupported sentence lowers the meaning part', () => {
    const supported = scoreCandidate({ ...input(SIMPLE, 6), meaning: makeAssessment({ minEntailment: 0.95 }) });
    const unsupported = scoreCandidate({ ...input(SIMPLE, 6), meaning: makeAssessment({ minEntailment: 0.2 }) });
    expect(unsupported.total).toBeLessThan(supported.total);
  });
});

// ---------------------------------------------------------------------------
// pickBestCandidate
// ---------------------------------------------------------------------------
describe('pickBestCandidate', () => {
  const scores = (total: number): CandidateScores => ({
    gradeGap: 0, similarity: null, entityRecall: 1, lengthRatio: 1,
    minEntailment: null, maxContradiction: null, passed: true, total,
  });
  const cand = (text: string, total: number, passed = true): ScoredCandidate =>
    ({ text, variant: 'standard', meaning: makeAssessment({ passed }), scores: scores(total) });

  it('keeps the highest total', () => {
    const best = pickBestCandidate([cand('a', 0.6), cand('b', 0.9), cand('c', 0.7)]);
    expect(best.text).toBe('b');
  });

  it('prefers a version that passes the meaning checks over a higher-scoring failing one', () => {
    const failing = cand('fails', 0.95, false);
    const alsoFailing = cand('also-fails', 0.9, false);
    const passing = cand('passes', 0.7);
    expect(pickBestCandidate([failing, alsoFailing, passing]).text).toBe('passes');
  });

  it('keeps the first candidate on a tie', () => {
    expect(pickBestCandidate([cand('first', 0.8), cand('second', 0.8)]).text).toBe('first');
  });

  it('picks by total when every candidate fails', () => {
    expect(pickBestCandidate([cand('a', 0.5, false), cand('b', 0.6, false)]).text).toBe('b');
  });

  it('treats an unchecked candidate as passing', () => {
    const unchecked: ScoredCandidate = { text: 'u', variant: 'standard', meaning: null, scores: scores(0.5) };
    expect(pickBestCandidate([cand('fails', 0.9, false), unchecked]).text).toBe('u');
  });

  it('throws on an empty list', () => {
    expect(() => pickBestCandidate([])).toThrow();
  });
});
