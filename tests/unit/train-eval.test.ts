import { describe, it, expect } from 'vitest';
import {
  distinctTexts, entityRecall, gradeHit, itemId, itemText, pendingGenerations, selectItems,
  EVAL_MODELS, EVAL_OPTIONS, EVAL_TARGETS, N_PARAGRAPHS, N_SENTENCES, PARA_MAX_ROWS, PARA_MIN_ROWS,
} from '../../scripts/train-eval/lib';

// ─── Selection ────────────────────────────────────────────────────────────────

describe('selectItems', () => {
  const easy = new Set([3, 10, 11, 500, 1999]);
  const pick = () => selectItems(2000, r => !easy.has(r), rows => !rows.includes(42));

  it('draws the pre-registered sizes, seeded', () => {
    const a = pick();
    expect(a).toEqual(pick());
    expect(a.sentences.length).toBe(N_SENTENCES);
    expect(a.paragraphs.length).toBe(N_PARAGRAPHS);
    expect(a.ineligibleSentences).toBe(easy.size);
  });

  it('never picks an ineligible sentence or a rejected window', () => {
    const a = pick();
    expect(a.sentences.some(s => easy.has(s.rows[0]))).toBe(false);
    expect(a.paragraphs.some(p => p.rows.includes(42))).toBe(false);
  });

  it('makes paragraphs of 3–5 consecutive rows that share no row with anything', () => {
    const a = pick();
    const seen = new Set(a.sentences.map(s => s.rows[0]));
    for (const p of a.paragraphs) {
      expect(p.rows.length).toBeGreaterThanOrEqual(PARA_MIN_ROWS);
      expect(p.rows.length).toBeLessThanOrEqual(PARA_MAX_ROWS);
      p.rows.forEach((r, i) => i > 0 && expect(r).toBe(p.rows[i - 1] + 1));
      for (const r of p.rows) {
        expect(seen.has(r)).toBe(false);
        seen.add(r);
      }
    }
  });

  it('throws when the data cannot fill the sample', () => {
    expect(() => selectItems(100, () => true, () => true)).toThrow(/eligible sentences/);
  });

  it('names items and joins their text', () => {
    expect(itemId('sent', [7])).toBe('s-7');
    expect(itemId('para', [7, 8, 9])).toBe('p-7-9');
    expect(itemText({ id: 'p-0-1', kind: 'para', rows: [0, 1] }, [' A. ', 'B.'])).toBe('A. B.');
  });
});

// ─── Measures ─────────────────────────────────────────────────────────────────

describe('measures', () => {
  it('counts a grade hit within one grade', () => {
    expect(gradeHit(7, 8)).toBe(true);
    expect(gradeHit(9, 8)).toBe(true);
    expect(gradeHit(6.99, 8)).toBe(false);
    expect(gradeHit(null, 8)).toBe(false);
  });

  it('computes entity recall over distinct texts, null without entities', () => {
    expect(entityRecall(4, 1)).toBe(0.75);
    expect(entityRecall(0, 0)).toBeNull();
    expect(distinctTexts(['Paris', 'paris', '1945', 'Paris'])).toEqual(['Paris', '1945']);
  });

  it('fixes the pre-registered models, targets and sampling', () => {
    expect(EVAL_MODELS).toEqual(['qwen3:4b-instruct-2507-q4_K_M', 'clarity-simplify']);
    expect(EVAL_TARGETS).toEqual([6, 8]);
    expect(EVAL_OPTIONS).toEqual({ temperature: 0, seed: 42 });
  });
});

// ─── Resume ───────────────────────────────────────────────────────────────────

describe('pendingGenerations', () => {
  const w = (itemId: string, target: number, promptHash = 'h') => ({ model: 'm', itemId, target, promptHash });

  it('skips done generations and keeps the rest', () => {
    expect(pendingGenerations([w('s-1', 6), w('s-1', 8), w('s-2', 6)], [w('s-1', 6)])).toEqual([w('s-1', 8), w('s-2', 6)]);
  });

  it('refuses to mix prompts', () => {
    expect(() => pendingGenerations([w('s-1', 6, 'new')], [w('s-1', 6, 'old')])).toThrow(/prompt changed/);
  });
});
