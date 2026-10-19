import { describe, it, expect } from 'vitest';
import {
  averageSimilarity, cosineSimilarity, liteLabel, liteStats, meaningBadge, meaningChips, meaningOverview, meaningStats,
  meaningStatusOf, NOT_VERIFIED_NOTE, passRateLabel, summarizeMeaning,
} from '../../src/lib/quality/similarity';
import { CONTRADICTION_MAX, THESIS_COVERAGE_MIN } from '../../src/lib/quality/config';
import { contradictionReason, droppedEntityReason } from '../../src/lib/quality/meaning';
import type { Entity, StoredMeaning, StoredResult } from '../../src/types';

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

describe('liteStats / liteLabel', () => {
  const LITE: StoredMeaning = { similarity: 0.9, entityRecall: 1, nliChecked: false, lite: true, passed: true, reasons: [] };

  it('counts Lite-checked paragraphs and the ones the Lite check did not pass', () => {
    const results = [
      result(LITE),
      result({ ...LITE, passed: false }),
      result({ ...LITE, passed: false }),
      result(FULL_PASS),
      result(LITE, { skipped: true }),
      result({ ...LITE, passed: false }, { status: 'error' }),
    ];
    expect(liteStats(results)).toEqual({ checked: 3, flagged: 2 });
    expect(liteLabel(liteStats(results))).toBe('Lite check: 2 of 3 flagged');
    expect(meaningOverview(results).lite).toEqual({ checked: 3, flagged: 2 });
  });

  it('keeps the pass rate null for a Lite-only document', () => {
    const results = [result(LITE), result({ ...LITE, passed: false })];
    expect(meaningStats(results).passRate).toBeNull();
    expect(passRateLabel(meaningStats(results))).toBe('—');
  });

  it('has no label when nothing was Lite-checked', () => {
    expect(liteLabel(liteStats([result(FULL_PASS)]))).toBeNull();
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

  it('marks a Lite-mode result as Lite, with the reason in the title', () => {
    const pass = meaningBadge({ ...FULL_PASS, nliChecked: false, lite: true });
    expect(pass?.label).toBe('meaning ✓ 0.91 · Lite');
    expect(pass?.title).toMatch(/Lite mode: sentence check \(NLI\) skipped/);
    const fail = meaningBadge({ ...FULL_PASS, nliChecked: false, lite: true, passed: false, reasons: ['Drifted.'] });
    expect(fail?.label).toBe('Not verified · Lite');
  });

  it('shows a neutral "Not verified" when the kept version did not pass, every reason in the title', () => {
    const badge = meaningBadge({
      ...FULL_PASS, passed: false, reasons: ['You dropped the number 1945.', 'The meaning drifted.'],
    });
    expect(badge).toMatchObject({ label: 'Not verified', warn: false, unverified: true });
    expect(badge?.title.split('\n')[0]).toBe(NOT_VERIFIED_NOTE);
    expect(badge?.title).toContain('You dropped the number 1945.');
    expect(badge?.title).toContain('The meaning drifted.');
    expect(badge?.chips).toEqual([{ kind: 'entity', label: 'missing number', title: 'You dropped the number 1945.' }]);
  });

  it('a passing or legacy result is not unverified and has no chips', () => {
    expect(meaningBadge(FULL_PASS)).toMatchObject({ unverified: false, chips: [] });
    expect(meaningBadge({ similarity: 0.82 })).toMatchObject({ unverified: false, chips: [] });
  });

  it('shows the similarity alone for results checked before the thesis standard', () => {
    expect(meaningBadge({ similarity: 0.82 })).toMatchObject({ label: 'meaning 0.82', warn: true });
  });

  it('shows the combined score and its threshold, without per-check cutoffs', () => {
    const full = meaningBadge({ ...FULL_PASS, score: 0.612, scoreModel: 'full' });
    expect(full?.label).toBe('meaning ✓ 0.91');
    expect(full?.title).toBe('Meaning preserved: meaning score 0.61 (needs 0.57) · similarity 0.91 · entities kept 100% · lowest entailment 0.90 · highest contradiction 0.01');
    expect(meaningBadge({ ...FULL_PASS, score: 0.5, scoreModel: 'lite', passed: false })?.title).toContain('meaning score 0.50 (needs 0.54)');
    expect(meaningBadge(FULL_PASS)?.title).toContain('similarity 0.91 (needs 0.87)');
  });

  it('is null for an unchecked result', () => {
    expect(meaningBadge({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// meaningChips — concrete reasons beside "Not verified"
// ---------------------------------------------------------------------------
describe('meaningChips', () => {
  const FAIL: StoredMeaning = { ...FULL_PASS, passed: false };

  it('one chip per kind of dropped entity; people, places and organizations are names', () => {
    const chips = meaningChips({
      ...FAIL,
      reasons: [
        'You dropped the number 1945.', 'You dropped the date 3 May.', 'You dropped the name Marie Curie.',
        'You dropped the place Paris.', 'You dropped the organization UNESCO.', 'You dropped the time zone UTC.',
      ],
    });
    expect(chips.map(c => c.label)).toEqual(['missing number', 'missing date', 'missing name', 'missing time zone']);
    expect(chips.every(c => c.kind === 'entity')).toBe(true);
    expect(chips[2].title).toBe('You dropped the name Marie Curie.\nYou dropped the place Paris.\nYou dropped the organization UNESCO.');
  });

  it('no chip for an untyped entity, drift, length or an unsupported sentence', () => {
    expect(meaningChips({
      ...FAIL,
      reasons: [
        'You dropped "Magna Carta".', 'The meaning drifted from the original (similarity 0.80).',
        'You left out too much of the original (your version has 40% of its words).',
        'This sentence is not supported by the original: "It rained."',
      ],
    })).toEqual([]);
  });

  it('a contradiction chip only when the contradiction is above CONTRADICTION_MAX', () => {
    const reasons = ['This sentence contradicts the original: "It was built in 1900."'];
    expect(meaningChips({ ...FAIL, reasons, maxContradiction: CONTRADICTION_MAX + 0.3 })).toEqual([
      { kind: 'contradiction', label: 'contradiction', title: reasons[0] },
    ]);
    // The "highest contradiction" fallback reason with a low value is not a concrete contradiction
    expect(meaningChips({ ...FAIL, reasons, maxContradiction: CONTRADICTION_MAX })).toEqual([]);
    expect(meaningChips({ ...FAIL, reasons, maxContradiction: undefined })).toEqual([]);
  });

  it('reads the reason strings meaning.ts actually builds', () => {
    const types: Entity['type'][] = ['number', 'date', 'timezone', 'person', 'place', 'org'];
    const chips = meaningChips({
      ...FAIL,
      reasons: [...types.map(t => droppedEntityReason('X', t)), droppedEntityReason('Y', 'other'), contradictionReason('Z.')],
      maxContradiction: 0.9,
    });
    expect(chips.map(c => c.label)).toEqual(['missing number', 'missing date', 'missing time zone', 'missing name', 'contradiction']);
  });

  it('is empty for a passing, unchecked or legacy result', () => {
    const reasons = ['You dropped the number 1945.'];
    expect(meaningChips({ ...FULL_PASS, reasons })).toEqual([]);
    expect(meaningChips({ reasons })).toEqual([]);
  });
});
