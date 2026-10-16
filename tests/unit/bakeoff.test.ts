import { describe, it, expect } from 'vitest';
import {
  BAKEOFF_MODELS, BLIND_COLUMNS, blindId, cleanWikiText, hasCitationMarks, hasIpa, isNearCopy,
  looksLikeRefusal, looksNonEnglish, makeBlind, mcnemarExact, outputFlags, parseCsv, pendingPairs,
  percentile, pickWinner, secPer100Words, shuffle, stripThink, toCsv, unblind, wilson, wordEditRatio,
} from '../../scripts/bakeoff/lib';
import type { BlindSource, FlagInput, ModelSummary, PairKey } from '../../scripts/bakeoff/lib';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function sources(): BlindSource[] {
  return BAKEOFF_MODELS.flatMap(model =>
    ['p1', 'p2', 'p3', 'p4'].map(paragraphId => ({
      model, paragraphId, original: `Original ${paragraphId}, "quoted", with comma`, simplified: `- ${paragraphId} by a model\n- second item`,
    })),
  );
}

const ENGLISH = new Set(
  'the cat sat on mat and it was happy with warm sun in room high blood pressure is common world a risk for heart limit info shared online change privacy settings no location keep apps updated make strong passwords use'.split(' '),
);
const isEnglishWord = (word: string) => ENGLISH.has(word);

function flagInput(overrides: Partial<FlagInput> = {}): FlagInput {
  return {
    output: 'The cat sat on the mat and it was happy with the warm sun in the room.',
    originalListItems: 0, outputListItems: 0, lengthRatio: 0.8, editRatio: 0.5, similarity: 0.9, isEnglishWord, ...overrides,
  };
}

function summary(model: string, overrides: Partial<ModelSummary> = {}): ModelSummary {
  return { model, meaningKept: 0.8, fkglDrop: 4, nearCopyShare: 0, cpuMedian: 10, finetunable: true, ...overrides };
}

// ─── Blind export ─────────────────────────────────────────────────────────────

describe('shuffle and blind ids', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(shuffle(items, 42)).toEqual(shuffle(items, 42));
    expect(shuffle(items, 42)).not.toEqual(shuffle(items, 43));
    expect([...shuffle(items, 42)].sort((a, b) => a - b)).toEqual(items);
  });

  it('numbers rows B001… after the shuffle and keeps every model out of the rows', () => {
    const { rows, key } = makeBlind(sources(), 7);
    expect(rows[0]).toEqual([...BLIND_COLUMNS]);
    expect(rows.slice(1).map(r => r[0])).toEqual(Array.from({ length: 12 }, (_, i) => blindId(i)));
    expect(blindId(0)).toBe('B001');
    expect(blindId(119)).toBe('B120');
    const csv = toCsv(rows);
    for (const model of BAKEOFF_MODELS) expect(csv).not.toContain(model);
    expect(csv).not.toMatch(/qwen|gemma/i);
    expect(Object.keys(key.rows)).toHaveLength(12);
  });

  it('gives the same rows and key for the same seed', () => {
    expect(makeBlind(sources(), 7)).toEqual(makeBlind(sources(), 7));
  });
});

describe('CSV and unblind round trip', () => {
  it('maps every label back to its model and paragraph', () => {
    const { rows, key } = makeBlind(sources(), 99);
    const labelled = rows.map((r, i) => (i === 0 ? r : [r[0], r[1], r[2], i % 2 ? 'F' : 'unfaithful', i === 3 ? 'note, "x"' : '']));
    const back = unblind(toCsv(labelled, ';'), key);
    expect(back).toHaveLength(12);
    for (const [i, r] of labelled.slice(1).entries()) {
      const entry = back.find(b => b.blindId === r[0]);
      expect(entry).toMatchObject({ ...key.rows[r[0]], label: (i + 1) % 2 ? 'faithful' : 'unfaithful' });
    }
    expect(back.find(b => b.blindId === labelled[3][0])?.note).toBe('note, "x"');
  });

  it('keeps multi-line fields intact', () => {
    const rows = [['a', 'line one\n- item "two"', 'x'], ['b', 'Skłodowska; Apurímac', '']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it('reads empty labels as null and unsure as unsure', () => {
    const { rows, key } = makeBlind(sources().slice(0, 2), 1);
    const labelled = [rows[0], [...rows[1].slice(0, 3), '', ''], [...rows[2].slice(0, 3), '?', '']];
    expect(unblind(toCsv(labelled), key).map(l => l.label)).toEqual([null, 'unsure']);
  });

  it('rejects unknown labels, unknown ids and duplicates, naming the rows', () => {
    const { rows, key } = makeBlind(sources().slice(0, 2), 1);
    expect(() => unblind(toCsv([rows[0], [...rows[1].slice(0, 3), 'maybe', '']]), key)).toThrow(/row 2 .*maybe/);
    expect(() => unblind(toCsv([rows[0], ['B999', '', '', 'f', '']]), key)).toThrow(/unknown blind_id "B999"/);
    expect(() => unblind(toCsv([rows[0], [...rows[1].slice(0, 3), 'f', ''], [...rows[1].slice(0, 3), 'u', '']]), key)).toThrow(/duplicate/);
  });
});

// ─── Text ─────────────────────────────────────────────────────────────────────

describe('stripThink', () => {
  it('removes one or several closed blocks, any case', () => {
    expect(stripThink('<think>plan</think>\nAnswer.')).toEqual({ text: 'Answer.', hadThink: true });
    expect(stripThink('<THINK>a</THINK>One. <think>b</think>Two.')).toEqual({ text: 'One. Two.', hadThink: true });
  });

  it('drops an unclosed block to the end and text before a stray closing tag', () => {
    expect(stripThink('Answer.<think>still thinking')).toEqual({ text: 'Answer.', hadThink: true });
    expect(stripThink('reasoning without opener</think>\nAnswer.')).toEqual({ text: 'Answer.', hadThink: true });
  });

  it('leaves plain output alone', () => {
    expect(stripThink('  - Item one\n- Item two  ')).toEqual({ text: '- Item one\n- Item two', hadThink: false });
  });
});

describe('cleanWikiText', () => {
  it('removes citations, IPA and empty pronunciation parentheses', () => {
    const raw = 'Cholera ( ; ) is an infection[1] of the gut (/ˈkɒlərə/) caused by Vibrio cholerae.[a]';
    const clean = cleanWikiText(raw);
    expect(clean).toBe('Cholera is an infection of the gut caused by Vibrio cholerae.');
    expect(hasIpa(clean)).toBe(false);
    expect(hasCitationMarks(clean)).toBe(false);
  });

  it('keeps ordinary parentheses', () => {
    expect(cleanWikiText('The Global Positioning System (GPS) is owned (since 2019) by the USSF.')).toBe(
      'The Global Positioning System (GPS) is owned (since 2019) by the USSF.',
    );
  });
});

describe('near copies', () => {
  it('uses the word edit ratio below 10%', () => {
    const original = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    const oneChange = original.replace('w5', 'x5'); // 1 / 20 = 5%
    const threeChanges = original.replace('w1', 'x').replace('w2', 'y').replace('w3', 'z'); // 15%
    expect(wordEditRatio(original, oneChange)).toBeCloseTo(0.05);
    expect(isNearCopy(wordEditRatio(original, oneChange), 0.5)).toBe(true);
    expect(isNearCopy(wordEditRatio(original, threeChanges), 0.5)).toBe(false);
    expect(isNearCopy(0.0999, null)).toBe(true);
    expect(isNearCopy(0.1, null)).toBe(false);
  });

  it('uses similarity above 0.97 (exclusive)', () => {
    expect(isNearCopy(0.5, 0.97)).toBe(false);
    expect(isNearCopy(0.5, 0.971)).toBe(true);
  });
});

describe('outputFlags', () => {
  it('flags nothing on a normal output', () => {
    expect(Object.values(outputFlags(flagInput())).some(Boolean)).toBe(false);
  });

  it('flags empty, refusal, non-English and length', () => {
    expect(outputFlags(flagInput({ output: '  ', lengthRatio: 0 }))).toMatchObject({ empty: true, refusal: false, lengthOutOfRange: true });
    expect(looksLikeRefusal('I’m sorry, but I can’t help with that.')).toBe(true);
    expect(looksLikeRefusal('Sorry is a word some people say a lot.')).toBe(false);
    expect(looksNonEnglish('高血压是一种长期的医学疾病，血压持续升高。', isEnglishWord)).toBe(true);
    expect(looksNonEnglish('La presión arterial alta es una enfermedad crónica muy común entre adultos mayores.', isEnglishWord)).toBe(true);
    expect(looksNonEnglish('High blood pressure is common in the world and it is a risk for the heart.', isEnglishWord)).toBe(false);
    // Terse bullets drop function words but are still English
    const terse = '- Limit info shared online.\n- Change privacy settings, no location.\n- Keep apps updated.\n- Make strong passwords.';
    expect(looksNonEnglish(terse, isEnglishWord)).toBe(false);
    expect(outputFlags(flagInput({ lengthRatio: 1.61 })).lengthOutOfRange).toBe(true);
    expect(outputFlags(flagInput({ lengthRatio: 0.4 })).lengthOutOfRange).toBe(false);
  });

  it('flags a list that became prose or lost items', () => {
    expect(outputFlags(flagInput({ originalListItems: 5, outputListItems: 0 })).listLost).toBe(true);
    expect(outputFlags(flagInput({ originalListItems: 5, outputListItems: 4 })).listLost).toBe(true);
    expect(outputFlags(flagInput({ originalListItems: 5, outputListItems: 6 })).listLost).toBe(false);
    expect(outputFlags(flagInput({ originalListItems: 0, outputListItems: 0 })).listLost).toBe(false);
  });

  it('flags a near copy', () => {
    expect(outputFlags(flagInput({ editRatio: 0.05 })).nearCopy).toBe(true);
    expect(outputFlags(flagInput({ similarity: 0.99 })).nearCopy).toBe(true);
  });
});

// ─── Resume and timing ────────────────────────────────────────────────────────

describe('pendingPairs', () => {
  const pair = (paragraphId: string, promptHash = 'h', mode: PairKey['mode'] = 'gpu'): PairKey =>
    ({ model: 'qwen2.5:3b', mode, paragraphId, promptHash });

  it('skips pairs already done, per model and mode', () => {
    const wanted = [pair('p1'), pair('p2'), pair('p3'), pair('p1', 'h', 'cpu')];
    expect(pendingPairs(wanted, [pair('p2')])).toEqual([pair('p1'), pair('p3'), pair('p1', 'h', 'cpu')]);
    expect(pendingPairs(wanted, wanted)).toEqual([]);
    expect(pendingPairs(wanted, [{ ...pair('p1'), model: 'gemma4:e2b-it-qat' }])).toHaveLength(4);
  });

  it('stops on a changed prompt hash', () => {
    expect(() => pendingPairs([pair('p1', 'new')], [pair('p1', 'old')])).toThrow(/prompt changed/);
  });
});

describe('timing statistics', () => {
  it('computes nearest-rank percentiles', () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 90)).toBe(9);
    expect(percentile([3], 90)).toBe(3);
    expect(percentile([], 50)).toBeNull();
  });

  it('normalises to 100 input words', () => {
    expect(secPer100Words(3, 150)).toBeCloseTo(2);
    expect(secPer100Words(3, 0)).toBe(0);
  });
});

// ─── Statistics ───────────────────────────────────────────────────────────────

describe('wilson', () => {
  it('matches known intervals', () => {
    const [low, high] = wilson(8, 10) ?? [NaN, NaN];
    expect(low).toBeCloseTo(0.4902, 4);
    expect(high).toBeCloseTo(0.9433, 4);
    expect(wilson(0, 10)?.[0]).toBe(0);
    expect(wilson(10, 10)?.[1]).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe('mcnemarExact', () => {
  it('matches exact binomial values', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(5, 5)).toBe(1);
    expect(mcnemarExact(1, 9)).toBeCloseTo(0.021484375, 9);
    expect(mcnemarExact(9, 1)).toBeCloseTo(0.021484375, 9);
    expect(mcnemarExact(0, 5)).toBeCloseTo(0.0625, 9);
    expect(mcnemarExact(2, 8)).toBeCloseTo(0.109375, 9);
  });
});

// ─── Winner rule ──────────────────────────────────────────────────────────────

describe('pickWinner', () => {
  it('picks the highest meaning kept among eligible models', () => {
    const result = pickWinner([summary('a', { meaningKept: 0.7 }), summary('b', { meaningKept: 0.9 }), summary('c', { meaningKept: 0.8 })]);
    expect(result.winner).toBe('b');
    expect(result.eligible).toEqual(['a', 'b', 'c']);
  });

  it('excludes models with too small an FKGL drop or too many near copies', () => {
    const result = pickWinner([
      summary('a', { meaningKept: 0.95, fkglDrop: 1.9 }),
      summary('b', { meaningKept: 0.94, nearCopyShare: 0.125 }),
      summary('c', { meaningKept: 0.6, fkglDrop: 2, nearCopyShare: 0.1 }),
    ]);
    expect(result.winner).toBe('c');
    expect(result.ineligible.map(i => i.model)).toEqual(['a', 'b']);
  });

  it('gives a tie within 3 points to the faster CPU model', () => {
    const tie = [summary('a', { meaningKept: 0.85, cpuMedian: 20 }), summary('b', { meaningKept: 0.82, cpuMedian: 12 })];
    expect(pickWinner(tie).winner).toBe('b');
    const gap = [summary('a', { meaningKept: 0.86, cpuMedian: 20 }), summary('b', { meaningKept: 0.82, cpuMedian: 12 })];
    expect(pickWinner(gap).winner).toBe('a');
  });

  it('drops a winner that is not fine-tunable and applies the rule again', () => {
    const result = pickWinner([
      summary('a', { meaningKept: 0.9, finetunable: false }),
      summary('b', { meaningKept: 0.8 }),
      summary('c', { meaningKept: 0.7 }),
    ]);
    expect(result.winner).toBe('b');
    expect(result.steps.join(' ')).toMatch(/a is not fine-tunable/);
  });

  it('has no winner when no model is eligible', () => {
    expect(pickWinner([summary('a', { fkglDrop: 1 })]).winner).toBeNull();
  });
});
