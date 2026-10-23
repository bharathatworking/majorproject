import { describe, it, expect } from 'vitest';
import {
  evaluateCriteria, gradeItemId, isNearCopyEdit, median, pairedBootstrap, pendingItems, quantile, selectGradeItems,
  BOOTSTRAP_RESAMPLES, CRITERIA, EVAL_OPTIONS, FILL_ORDER, GRADE_TARGETS, PARA_MAX_ROWS, PARA_MIN_ROWS,
  PARAGRAPHS_PER_TARGET, SENTENCES_PER_TARGET,
  type BootstrapResult, type SelectionInput,
} from '../../scripts/grade/lib';

// ─── Selection ────────────────────────────────────────────────────────────────

describe('selectGradeItems', () => {
  // Row r "reads at grade" r % 13; rows 0–99 are out of the pool (Prompt 10)
  const gradeOf = (rows: number[]) => Math.max(...rows.map(r => r % 13));
  const input: SelectionInput = {
    rowCount: 2000,
    inPool: r => r >= 100,
    sentenceLongEnough: r => r % 17 !== 0,
    windowOverlaps: rows => rows.includes(1500),
    alreadySimple: (rows, target) => gradeOf(rows) <= target,
  };

  it('fills every target with the pre-registered mix, seeded', () => {
    const a = selectGradeItems(input);
    expect(a).toEqual(selectGradeItems(input));
    expect(a.items).toHaveLength(GRADE_TARGETS.length * (SENTENCES_PER_TARGET + PARAGRAPHS_PER_TARGET));
    for (const t of GRADE_TARGETS) {
      expect(a.items.filter(i => i.target === t && i.kind === 'sent')).toHaveLength(SENTENCES_PER_TARGET);
      expect(a.items.filter(i => i.target === t && i.kind === 'para')).toHaveLength(PARAGRAPHS_PER_TARGET);
    }
  });

  it('never uses a row twice, a row outside the pool, a short sentence or an overlapping window', () => {
    const seen = new Set<number>();
    for (const item of selectGradeItems(input).items) {
      for (const r of item.rows) {
        expect(seen.has(r)).toBe(false);
        expect(r).toBeGreaterThanOrEqual(100);
        seen.add(r);
      }
      if (item.kind === 'sent') expect(item.rows[0] % 17).not.toBe(0);
      else expect(item.rows).not.toContain(1500);
    }
  });

  it('keeps only items above their target and counts the already simple ones', () => {
    const a = selectGradeItems(input);
    for (const item of a.items) expect(gradeOf(item.rows)).toBeGreaterThan(item.target);
    expect(Object.keys(a.alreadySimpleSentences).map(Number).sort((x, y) => x - y)).toEqual([...GRADE_TARGETS]);
    expect(a.alreadySimpleSentences[10]).toBeGreaterThan(0);
  });

  it('makes paragraphs of 3–5 consecutive rows', () => {
    for (const p of selectGradeItems(input).items.filter(i => i.kind === 'para')) {
      expect(p.rows.length).toBeGreaterThanOrEqual(PARA_MIN_ROWS);
      expect(p.rows.length).toBeLessThanOrEqual(PARA_MAX_ROWS);
      p.rows.forEach((r, i) => i > 0 && expect(r).toBe(p.rows[i - 1] + 1));
    }
  });

  it('fills the highest target first and throws when a bucket cannot be filled', () => {
    expect(FILL_ORDER[0]).toBe(10);
    expect(() => selectGradeItems({ ...input, alreadySimple: (_, t) => t >= 10 })).toThrow(/grade 10/);
  });

  it('names items by target, kind and rows', () => {
    expect(gradeItemId('sent', [7], 4)).toBe('g4-s-7');
    expect(gradeItemId('para', [7, 8, 9], 10)).toBe('g10-p-7-9');
  });
});

// ─── Measures ─────────────────────────────────────────────────────────────────

describe('measures', () => {
  it('calls an edit distance below 0.10 a near copy', () => {
    expect(isNearCopyEdit(0.0999)).toBe(true);
    expect(isNearCopyEdit(0.1)).toBe(false);
  });

  it('samples at temperature 0, seed 42', () => {
    expect(EVAL_OPTIONS).toEqual({ temperature: 0, seed: 42 });
  });
});

// ─── Statistics ───────────────────────────────────────────────────────────────

describe('statistics', () => {
  it('interpolates quantiles like numpy', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
  });

  it('bootstraps deterministically, with the mean inside the interval', () => {
    const diffs = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 1 : i % 7 === 0 ? -1 : 0));
    const a = pairedBootstrap(diffs);
    expect(a).toEqual(pairedBootstrap(diffs));
    expect(a.n).toBe(200);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
    expect(a.lo).toBeGreaterThan(0);
    expect(BOOTSTRAP_RESAMPLES).toBe(10_000);
  });

  it('gives a zero-width interval for constant differences', () => {
    const r = pairedBootstrap([0.5, 0.5, 0.5], 50);
    expect(r).toEqual({ n: 3, mean: 0.5, lo: 0.5, hi: 0.5 });
  });
});

// ─── Criteria ─────────────────────────────────────────────────────────────────

describe('evaluateCriteria', () => {
  const b = (mean: number, lo = mean, hi = mean): BootstrapResult => ({ n: 200, mean, lo, hi });
  const good = {
    hitDiff: b(0.2, 0.1, 0.3),
    meaningDiff: b(-0.03),
    entityDiff: b(-0.02),
    nearCopyRateC: 0.05,
    medianSecondsA: 10,
    medianSecondsC: 16,
  };

  it('adopts when every criterion holds, boundaries included', () => {
    const v = evaluateCriteria({ ...good, hitDiff: b(CRITERIA.minHitGain, 0.01, 0.3) });
    expect(v.criteria.every(c => c.met)).toBe(true);
    expect(v.adopt).toBe(true);
  });

  it('fails the primary criterion on a small gain or a CI touching 0', () => {
    expect(evaluateCriteria({ ...good, hitDiff: b(0.149, 0.05, 0.25) }).primaryMet).toBe(false);
    const v = evaluateCriteria({ ...good, hitDiff: b(0.2, 0, 0.4) });
    expect(v.primaryMet).toBe(false);
    expect(v.adopt).toBe(false);
  });

  it('fails each guardrail on its own', () => {
    const failed = (patch: Partial<typeof good>) =>
      evaluateCriteria({ ...good, ...patch }).criteria.filter(c => !c.met).map(c => c.id);
    expect(failed({ meaningDiff: b(-0.031) })).toEqual(['meaning']);
    expect(failed({ entityDiff: b(-0.021) })).toEqual(['entities']);
    expect(failed({ nearCopyRateC: 0.051 })).toEqual(['nearCopy']);
    expect(failed({ medianSecondsC: 16.1 })).toEqual(['time']);
    const v = evaluateCriteria({ ...good, nearCopyRateC: 0.2 });
    expect(v.primaryMet).toBe(true);
    expect(v.guardrailsMet).toBe(false);
    expect(v.adopt).toBe(false);
  });
});

// ─── Resume ───────────────────────────────────────────────────────────────────

describe('pendingItems', () => {
  it('skips done items of the same arm and refuses a changed prompt', () => {
    const wanted = [
      { arm: 'A', itemId: 'g4-s-1', promptHash: 'h1' },
      { arm: 'A', itemId: 'g4-s-2', promptHash: 'h2' },
    ];
    expect(pendingItems(wanted, [{ arm: 'A', itemId: 'g4-s-1', promptHash: 'h1' }])).toEqual([wanted[1]]);
    expect(pendingItems(wanted, [{ arm: 'C', itemId: 'g4-s-1', promptHash: 'x' }])).toEqual(wanted);
    expect(() => pendingItems(wanted, [{ arm: 'A', itemId: 'g4-s-2', promptHash: 'old' }])).toThrow(/prompt changed/);
  });
});
