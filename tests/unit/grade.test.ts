import { describe, it, expect } from 'vitest';
import {
  buildGradeInstruction, combineRetryInstructions, gradeMiss, pickGradeAware, planRetry,
} from '../../src/lib/quality/grade';
import {
  CALLS_WITHOUT_BEST_OF_N, GRADE_RETRY_ENABLED, GRADE_TOLERANCE, GRADE_WORDING_ENABLED, MAX_MODEL_CALLS_PER_NODE,
} from '../../src/lib/quality/config';
import type { MeaningAssessment, MeaningCandidate } from '../../src/types';
import { makeAssessment } from '../mocks/fixtures';

// ─── Config ───────────────────────────────────────────────────────────────────

describe('grade targeting config', () => {
  it('is off by default until the pre-registered report (PREREG decision rule)', () => {
    expect(GRADE_WORDING_ENABLED).toBe(false);
    expect(GRADE_RETRY_ENABLED).toBe(false);
  });

  it('uses the pre-registered hit tolerance and never raises the call cap', () => {
    expect(GRADE_TOLERANCE).toBe(1);
    expect(CALLS_WITHOUT_BEST_OF_N).toBe(2);
    expect(CALLS_WITHOUT_BEST_OF_N).toBeLessThanOrEqual(MAX_MODEL_CALLS_PER_NODE);
  });
});

// ─── gradeMiss ────────────────────────────────────────────────────────────────

describe('gradeMiss', () => {
  it('is null on target, inclusive of the ±1.0 edges', () => {
    expect(gradeMiss(6, 6)).toBeNull();
    expect(gradeMiss(7, 6)).toBeNull();
    expect(gradeMiss(5, 6)).toBeNull();
  });

  it('is too-hard above the band and too-easy below it', () => {
    expect(gradeMiss(7.01, 6)).toBe('too-hard');
    expect(gradeMiss(12, 4)).toBe('too-hard');
    expect(gradeMiss(4.99, 6)).toBe('too-easy');
    expect(gradeMiss(1, 10)).toBe('too-easy');
  });

  it('is null for a missing or non-finite grade (empty output)', () => {
    expect(gradeMiss(null, 6)).toBeNull();
    expect(gradeMiss(Number.NaN, 6)).toBeNull();
  });
});

// ─── buildGradeInstruction ────────────────────────────────────────────────────

describe('buildGradeInstruction', () => {
  it('too hard: names the measured grade, the target and shorter sentences and commoner words', () => {
    const text = buildGradeInstruction('too-hard', 11.234, 6);
    expect(text).toContain('about grade 11.2');
    expect(text).toContain('harder than the target grade 6');
    expect(text).toContain('shorter sentences');
    expect(text).toContain('commoner, everyday words');
    expect(text).not.toContain('over-simplifying');
  });

  it('too easy: tells the model to stop over-simplifying and keep the detail', () => {
    const text = buildGradeInstruction('too-easy', 2.31, 8);
    expect(text).toContain('about grade 2.3');
    expect(text).toContain('easier than the target grade 8');
    expect(text).toContain('stop over-simplifying');
    expect(text).toContain('keep the detail');
    expect(text).not.toContain('shorter sentences');
  });
});

// ─── planRetry ────────────────────────────────────────────────────────────────

describe('planRetry', () => {
  const base = { meaningRetry: false, miss: null, callsMade: 1, callLimit: CALLS_WITHOUT_BEST_OF_N };

  it('already on target with meaning passing: no retry', () => {
    expect(planRetry(base)).toEqual({ retry: false, meaning: false, grade: null });
  });

  it('too hard: one retry carrying the grade direction only', () => {
    expect(planRetry({ ...base, miss: 'too-hard' })).toEqual({ retry: true, meaning: false, grade: 'too-hard' });
  });

  it('too easy: one retry carrying the grade direction only', () => {
    expect(planRetry({ ...base, miss: 'too-easy' })).toEqual({ retry: true, meaning: false, grade: 'too-easy' });
  });

  it('meaning failure and grade miss share one retry', () => {
    expect(planRetry({ ...base, meaningRetry: true, miss: 'too-hard' }))
      .toEqual({ retry: true, meaning: true, grade: 'too-hard' });
  });

  it('a meaning failure alone keeps the existing meaning retry', () => {
    expect(planRetry({ ...base, meaningRetry: true })).toEqual({ retry: true, meaning: true, grade: null });
  });

  it('budget exhausted: no retry, whatever the reasons', () => {
    expect(planRetry({ ...base, meaningRetry: true, miss: 'too-hard', callsMade: 2 }))
      .toEqual({ retry: false, meaning: false, grade: null });
    expect(planRetry({ ...base, miss: 'too-easy', callsMade: 3, callLimit: MAX_MODEL_CALLS_PER_NODE }))
      .toEqual({ retry: false, meaning: false, grade: null });
  });
});

describe('combineRetryInstructions', () => {
  it('puts the meaning instruction first, then the grade note', () => {
    expect(combineRetryInstructions('M', 'G')).toBe('M\n\nG');
    expect(combineRetryInstructions(null, 'G')).toBe('G');
    expect(combineRetryInstructions('M', null)).toBe('M');
    expect(combineRetryInstructions(null, null)).toBe('');
  });
});

// ─── pickGradeAware ───────────────────────────────────────────────────────────

describe('pickGradeAware', () => {
  type C = MeaningCandidate & { grade: number | null };
  const passing = (overrides: Partial<MeaningAssessment> = {}) => makeAssessment(overrides);
  const failing = () => makeAssessment({ passed: false, reasons: ['drift'] });
  const cand = (grade: number | null, meaning: MeaningAssessment | null = passing()): C =>
    ({ text: `v${grade}`, meaning, grade });
  const gradeOf = (c: C) => c.grade;

  it('a passing version beats a failing one, whatever the grade', () => {
    const first = cand(6, failing());
    const retry = cand(12);
    expect(pickGradeAware(first, retry, 6, gradeOf)).toBe(retry);
    expect(pickGradeAware(retry, first, 6, gradeOf)).toBe(retry);
  });

  it('then a version on target beats one off it', () => {
    const first = cand(10);
    const retry = cand(6.8);
    expect(pickGradeAware(first, retry, 6, gradeOf)).toBe(retry);
  });

  it('then the closer grade wins when both are off target', () => {
    const first = cand(2.3);
    const retry = cand(5.0);
    expect(pickGradeAware(first, retry, 7, gradeOf)).toBe(retry);
  });

  it('then the higher meaningScore; the first version wins ties', () => {
    const first = cand(6, passing({ score: 0.9 }));
    const better = cand(6, passing({ score: 0.95 }));
    const same = cand(6, passing({ score: 0.9 }));
    expect(pickGradeAware(first, better, 6, gradeOf)).toBe(better);
    expect(pickGradeAware(first, same, 6, gradeOf)).toBe(first);
  });

  it('an unmeasurable grade counts as furthest from target', () => {
    const first = cand(null);
    const retry = cand(9);
    expect(pickGradeAware(first, retry, 6, gradeOf)).toBe(retry);
  });
});
