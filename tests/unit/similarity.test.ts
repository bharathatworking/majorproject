import { describe, it, expect } from 'vitest';
import {
  averageSimilarity, cosineSimilarity, meaningBadge, meaningOverview, meaningStats, meaningStatusOf,
  passRateLabel, summarizeMeaning,
} from '../../src/lib/quality/similarity';
import { THESIS_COVERAGE_MIN } from '../../src/lib/quality/config';
import type { StoredMeaning, StoredResult } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FULL_PASS: StoredMeaning = {
  similarity: 0.91, entityRecall: 1, minEntailment: 0.9, maxContradiction: 0.01,
  nliChecked: true, passed: true, reasons: [],
};

function result(meaning: StoredMeaning = {}, overrides: Partial<StoredResult> = {}): StoredResult {
  return {
    nodeId: 'n0', originalText: 'o', simplifiedText: 's', status: 'done', type: 'paragraph',
    ...meaning, ...overrides,
  };
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
// meaningStatusOf — thesis categories
// ---------------------------------------------------------------------------
describe('meaningStatusOf', () => {
  it('is passed or failed only when SBERT and NLI both ran', () => {
    expect(meaningStatusOf(FULL_PASS)).toBe('passed');
    expect(meaningStatusOf({ ...FULL_PASS, passed: false })).toBe('failed');
  });

  it('is not-fully-checked when NLI or the embedding model was missing', () => {
    expect(meaningStatusOf({ ...FULL_PASS, nliChecked: false })).toBe('not-fully-checked');
    expect(meaningStatusOf({ ...FULL_PASS, similarity: undefined })).toBe('not-fully-checked');
  });

  it('is excluded when unchecked or stored before the thesis standard', () => {
    expect(meaningStatusOf(null)).toBe('excluded');
    expect(meaningStatusOf(undefined)).toBe('excluded');
    expect(meaningStatusOf({ similarity: 0.9 })).toBe('excluded');
  });
});

// ---------------------------------------------------------------------------
// summarizeMeaning / meaningStats — pass rate and coverage
// ---------------------------------------------------------------------------
describe('summarizeMeaning', () => {
  it('pass rate is over fully checked nodes; coverage is fully checked / eligible', () => {
    const s = summarizeMeaning(['passed', 'passed', 'passed', 'failed', 'not-fully-checked', 'excluded', 'error']);
    expect(s).toMatchObject({ passed: 3, failed: 1, notFullyChecked: 1, excluded: 1 });
    expect(s.passRate).toBeCloseTo(0.75);
    expect(s.coverage).toBeCloseTo(0.8);
    expect(s.thesisGrade).toBe(false);
  });

  it('is thesis-grade at the coverage minimum', () => {
    expect(THESIS_COVERAGE_MIN).toBe(0.9);
    const statuses = [...Array(9).fill('passed'), 'not-fully-checked'] as const;
    expect(summarizeMeaning(statuses).thesisGrade).toBe(true);
  });

  it('a high pass rate cannot hide a low coverage', () => {
    const s = summarizeMeaning(['passed', 'not-fully-checked', 'not-fully-checked']);
    expect(s.passRate).toBe(1);
    expect(s.coverage).toBeCloseTo(1 / 3);
    expect(s.thesisGrade).toBe(false);
  });

  it('is null-safe with nothing eligible', () => {
    expect(summarizeMeaning(['excluded'])).toMatchObject({ passRate: null, coverage: null, thesisGrade: false });
  });
});

describe('meaningStats', () => {
  it('counts done results; skipped ones are excluded and errors are ignored', () => {
    const s = meaningStats([
      result(FULL_PASS),
      result({ ...FULL_PASS, passed: false }),
      result({ ...FULL_PASS, nliChecked: false }),
      result(FULL_PASS, { skipped: true }),
      result({}, { type: 'heading' }),
      result(FULL_PASS, { status: 'error' }),
    ]);
    expect(s).toMatchObject({ passed: 1, failed: 1, notFullyChecked: 1, excluded: 2 });
    expect(s.passRate).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// averageSimilarity
// ---------------------------------------------------------------------------
describe('averageSimilarity', () => {
  it('averages done results that were checked', () => {
    const avg = averageSimilarity([
      result({ similarity: 0.9 }), result({ similarity: 0.8 }), result(), result({ similarity: 0.1 }, { status: 'error' }),
    ]);
    expect(avg).toBeCloseTo(0.85);
  });

  it('returns null when nothing was checked', () => {
    expect(averageSimilarity([])).toBeNull();
    expect(averageSimilarity([result()])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// meaningOverview / passRateLabel — the Progress card and table
// ---------------------------------------------------------------------------
describe('meaningOverview', () => {
  it('returns the table stats and the average similarity from the same results', () => {
    const results = [
      result({ ...FULL_PASS, similarity: 0.9 }),
      result({ ...FULL_PASS, similarity: 0.84, passed: false }),
      result({ ...FULL_PASS, similarity: 0.88, passed: false }),
    ];
    const o = meaningOverview(results);
    expect(o.stats).toEqual(meaningStats(results));
    expect(o.avgSimilarity).toBe(averageSimilarity(results));
  });

  it('can show a high similarity next to a 0% pass rate (the Chrome case)', () => {
    const results = Array.from({ length: 9 }, () => result({ ...FULL_PASS, similarity: 0.87, passed: false }));
    const o = meaningOverview(results);
    expect(o.avgSimilarity!.toFixed(2)).toBe('0.87');
    expect(passRateLabel(o.stats)).toBe('0% (0/9)');
  });
});

describe('passRateLabel', () => {
  it('shows percent and passed / fully checked', () => {
    expect(passRateLabel(meaningStats([
      result(FULL_PASS), result(FULL_PASS), result({ ...FULL_PASS, passed: false }),
      result({ ...FULL_PASS, nliChecked: false }),
    ]))).toBe('67% (2/3)');
  });

  it('shows a dash when nothing was fully checked', () => {
    expect(passRateLabel(meaningStats([]))).toBe('—');
    expect(passRateLabel(meaningStats([result({ ...FULL_PASS, nliChecked: false })]))).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// meaningBadge — Reading page text
// ---------------------------------------------------------------------------
describe('meaningBadge', () => {
  it('shows a tick and the similarity when the meaning was preserved', () => {
    expect(meaningBadge(FULL_PASS)).toMatchObject({ label: 'meaning ✓ 0.91', warn: false });
  });

  it('marks a pass without NLI', () => {
    expect(meaningBadge({ ...FULL_PASS, nliChecked: false })?.label).toBe('meaning ✓ 0.91 · no NLI');
  });

  it('shows the first reason when it failed, and every reason in the title', () => {
    const badge = meaningBadge({
      ...FULL_PASS, passed: false, reasons: ['You dropped the number 1945.', 'The meaning drifted.'],
    });
    expect(badge?.label).toBe('meaning ⚠ You dropped the number 1945.');
    expect(badge?.warn).toBe(true);
    expect(badge?.title).toContain('The meaning drifted.');
  });

  it('shows the similarity alone for results checked before the thesis standard', () => {
    expect(meaningBadge({ similarity: 0.82 })).toMatchObject({ label: 'meaning 0.82', warn: true });
  });

  it('is null for an unchecked result', () => {
    expect(meaningBadge({})).toBeNull();
  });
});
