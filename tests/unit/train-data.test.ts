import { describe, it, expect } from 'vitest';
import cases from '../../scripts/train-data/dedupe-cases.json';
import {
  assignPools, buildReservedIndex, chunkRun, cheapDropReason, cleanPairText, contiguousRuns, entityDropReason,
  gradeFor, gradeHistogram, joinChunk, keepGradeFor, mulberry32, nextKind, normaliseForDedupe, promptDropReason,
  reservedHits, shuffleWith, splitByArticle, truthfulHints, waterFill, wordNgrams,
  BALANCE_STEP, MAX_EXAMPLE_CHARS, PARA_MAX_PAIRS, PARA_MIN_PAIRS,
} from '../../scripts/train-data/lib';
import type { AlignedPair, Bucket } from '../../scripts/train-data/lib';
import { baseWordSet, renderPrompt, wordFormCandidates } from '../../scripts/train-data/render';
import { computeReadabilityReport } from '../../src/lib/metrics/engine';
import { findDifficultWords } from '../../src/lib/metrics/difficult-words';
import { resolveProfile } from '../../src/lib/profile/resolver';
import { buildPrompt } from '../../src/lib/prompt-builder/builder';
import { cleanForModel } from '../../src/lib/segmentation/clutter';
import { detectEntities } from '../../src/lib/segmentation/ner';
import { DEFAULT_PROFILE } from '../../src/lib/storage/settings';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PARAGRAPH =
  'The Treaty of Westphalia, signed in 1648, ended the Thirty Years\' War and established the principle of ' +
  'state sovereignty, which subsequently became a cornerstone of international jurisprudence.[3] ' +
  'Historians frequently characterise the settlement as the foundation of the modern diplomatic order.';

function pair(articleId: number, idx: number, paraKey: number | null = 0): AlignedPair {
  return { id: `wa-${articleId}-${idx}`, articleId, normalIdx: [idx], paraKey, complex: `c${idx}`, simple: `s${idx}` };
}

// ─── Prompt parity ────────────────────────────────────────────────────────────

describe('renderPrompt', () => {
  /** The steps of simplify.ts for one pasted paragraph, written out by hand. */
  function appPrompt(text: string, grade: number, words: 'app' | string[]) {
    const wordSet = baseWordSet();
    const report = computeReadabilityReport(text, wordSet);
    const spec = resolveProfile({ ...DEFAULT_PROFILE, targetGradeLevel: grade }, report.estimatedGradeLevel);
    const modelText = cleanForModel(text);
    const entities = detectEntities(modelText);
    const difficult = words === 'app' ? findDifficultWords(modelText, entities, wordSet) : words;
    return buildPrompt({ id: 'n0', type: 'paragraph', text: modelText, entities }, spec, report, '', difficult);
  }

  it('is byte-identical to buildPrompt with the app hints', () => {
    for (const grade of [4, 6, 8, 10]) {
      const r = renderPrompt(PARAGRAPH, grade, 'app');
      const expected = appPrompt(PARAGRAPH, grade, 'app');
      expect(r.system).toBe(expected.system);
      expect(r.user).toBe(expected.user);
    }
  });

  it('is byte-identical with an exact list and with a chooser', () => {
    const exact = renderPrompt(PARAGRAPH, 6, ['sovereignty']);
    expect(exact.user).toBe(appPrompt(PARAGRAPH, 6, ['sovereignty']).user);
    const chosen = renderPrompt(PARAGRAPH, 6, words => words.slice(0, 1));
    expect(chosen.user).toBe(appPrompt(PARAGRAPH, 6, chosen.difficultWords.slice(0, 1)).user);
    expect(renderPrompt(PARAGRAPH, 6, []).user).not.toContain('These words may be hard');
  });

  it('renders the default profile at the wanted grade and the cleaned text', () => {
    const r = renderPrompt(PARAGRAPH, 6, 'app');
    expect(r.spec.targetGrade).toBe(6);
    expect(r.spec.allowBullets).toBe(false);
    expect(r.system).toContain('grade 6');
    expect(r.user.startsWith('This is a paragraph. Rewrite it as one paragraph of plain sentences.')).toBe(true);
    expect(r.user).toContain(`TEXT TO REWRITE:\n${r.modelText}`);
    expect(r.modelText).not.toContain('[3]');
    expect(r.user).toContain('1648');
    expect(r.hinted.length).toBeGreaterThan(0);
  });

  it('names no hints at tier none', () => {
    const r = renderPrompt('The cat sat on the mat. It was a warm day.', 12, 'app');
    expect(r.spec.depthTier).toBe('none');
    expect(r.hinted).toEqual([]);
  });
});

// ─── Dedupe ───────────────────────────────────────────────────────────────────

describe('dedupe matcher (dedupe-cases.json, shared with dedupe.py)', () => {
  it.each(cases.normalise)('normalises $in', c => {
    expect(normaliseForDedupe(c.in)).toBe(c.out);
  });

  it.each(cases.match)('$why', c => {
    expect(reservedHits(buildReservedIndex(c.reserved), c.text)).toEqual(c.expected);
  });

  it('builds 8-grams only from 8 words up', () => {
    expect(wordNgrams('a b c d e f g').size).toBe(0);
    expect(wordNgrams('a b c d e f g h i').size).toBe(2);
    expect(wordNgrams('').size).toBe(0);
  });
});

// ─── Filters ──────────────────────────────────────────────────────────────────

describe('A4 filter rules', () => {
  const ok = { sourceWords: 20, targetWords: 15, fkglSource: 12, fkglTarget: 9 };

  it('keeps a good pair', () => {
    expect(cheapDropReason(ok)).toBeNull();
  });

  it('drops a source under 8 words', () => {
    expect(cheapDropReason({ ...ok, sourceWords: 7, targetWords: 5 })).toBe('short');
    expect(cheapDropReason({ ...ok, sourceWords: 8, targetWords: 6 })).toBeNull();
  });

  it('drops a word ratio outside [0.4, 1.3]', () => {
    expect(cheapDropReason({ ...ok, targetWords: 7 })).toBe('ratio');
    expect(cheapDropReason({ ...ok, targetWords: 8 })).toBeNull();
    expect(cheapDropReason({ ...ok, targetWords: 26 })).toBeNull();
    expect(cheapDropReason({ ...ok, targetWords: 27 })).toBe('ratio');
  });

  it('drops an FKGL drop under 0.5', () => {
    expect(cheapDropReason({ ...ok, fkglTarget: 11.5 })).toBe('fkgl');
    expect(cheapDropReason({ ...ok, fkglTarget: 11.49 })).toBeNull();
    expect(cheapDropReason({ ...ok, fkglTarget: 13 })).toBe('fkgl');
  });

  it('drops a long example and a simplification prompted with tier none', () => {
    expect(promptDropReason({ chars: MAX_EXAMPLE_CHARS + 1, depthTier: 'light', kind: 'sent' })).toBe('tooLong');
    expect(promptDropReason({ chars: 100, depthTier: 'none', kind: 'para' })).toBe('tierNone');
    expect(promptDropReason({ chars: 100, depthTier: 'none', kind: 'keep' })).toBeNull();
  });

  it('drops an added entity before a lost key number', () => {
    expect(entityDropReason(['Paris'], ['1648'])).toBe('addedEntity');
    expect(entityDropReason([], ['1648'])).toBe('lostKeyNumber');
    expect(entityDropReason([], [])).toBeNull();
  });

  it('cleans Wikipedia pronunciation leftovers only', () => {
    expect(cleanPairText('Lata Mondal ( ; born: 16 January 1993, Dhaka) is a cricketer.'))
      .toBe('Lata Mondal (born: 16 January 1993, Dhaka) is a cricketer.');
    expect(cleanPairText('Paris ( ; ) is big , really.')).toBe('Paris is big, really.');
    expect(cleanPairText('A (B) c.')).toBe('A (B) c.');
  });
});

// ─── Grades and hints ─────────────────────────────────────────────────────────

describe('grade conditioning', () => {
  it('rounds and clamps the target FKGL to 3–12', () => {
    expect(gradeFor(6.49)).toBe(6);
    expect(gradeFor(6.5)).toBe(7);
    expect(gradeFor(1.2)).toBe(3);
    expect(gradeFor(-2)).toBe(3);
    expect(gradeFor(15.7)).toBe(12);
  });

  it('gives a keep example a grade at or above its source', () => {
    expect(keepGradeFor(6.1)).toBe(7);
    expect(keepGradeFor(7)).toBe(7);
    expect(keepGradeFor(1.5)).toBe(3);
    expect(keepGradeFor(12)).toBe(12);
    expect(keepGradeFor(12.3)).toBeNull();
  });

  it('keeps only hinted words the target no longer has (any form)', () => {
    const words = ['jurisprudence', 'characterise', 'sovereignty', 'subsequently'];
    const target = 'Later, it became a key idea in law. Historians often characterised it as the start of modern sovereignty.';
    expect(truthfulHints(words, target, wordFormCandidates)).toEqual(['jurisprudence', 'subsequently']);
    expect(truthfulHints(['Treaties'], 'The treaty ended the war.', wordFormCandidates)).toEqual([]);
    expect(truthfulHints([], 'anything', wordFormCandidates)).toEqual([]);
  });
});

// ─── Pseudo-paragraphs ────────────────────────────────────────────────────────

describe('pseudo-paragraph runs', () => {
  it('joins consecutive sentences of one article paragraph only', () => {
    const pairs = [pair(1, 2), pair(1, 0), pair(1, 1), pair(1, 4), pair(1, 5, 1), pair(2, 6), pair(2, 7, null), pair(2, 8, null)];
    const runs = contiguousRuns(pairs).map(r => r.map(p => p.id));
    expect(runs).toEqual([
      ['wa-1-0', 'wa-1-1', 'wa-1-2'], ['wa-1-4'], ['wa-1-5'], ['wa-2-6'], ['wa-2-7'], ['wa-2-8'],
    ]);
  });

  it('chunks a run into 2–5 pairs and returns a last single pair apart', () => {
    const run = Array.from({ length: 11 }, (_, i) => pair(1, i));
    const { chunks, rest } = chunkRun(run, mulberry32(1));
    for (const c of chunks) {
      expect(c.length).toBeGreaterThanOrEqual(PARA_MIN_PAIRS);
      expect(c.length).toBeLessThanOrEqual(PARA_MAX_PAIRS);
    }
    expect(chunks.flat().length + rest.length).toBe(11);
    expect(rest.length).toBeLessThanOrEqual(1);
  });

  it('puts every pair in exactly one pool', () => {
    const runs = [Array.from({ length: 6 }, (_, i) => pair(1, i)), [pair(2, 0)], Array.from({ length: 3 }, (_, i) => pair(3, i))];
    const { paragraphs, sentences } = assignPools(runs, mulberry32(42));
    const ids = [...paragraphs.flat(), ...sentences].map(p => p.id).sort();
    expect(ids).toEqual(runs.flat().map(p => p.id).sort());
    expect(joinChunk([pair(1, 0), pair(1, 1)])).toEqual({ complex: 'c0 c1', simple: 's0 s1' });
  });
});

// ─── Balance and split ────────────────────────────────────────────────────────

describe('grade balance', () => {
  function bucket(grade: number, para: number, sent: number): Bucket<string> {
    return {
      grade,
      para: Array.from({ length: para }, (_, i) => `g${grade}p${i}`),
      sent: Array.from({ length: sent }, (_, i) => `g${grade}s${i}`),
    };
  }

  it('fills buckets evenly and lets a short bucket stay short', async () => {
    const result = await waterFill([bucket(4, 100, 100), bucket(5, 10, 10), bucket(6, 300, 300)], 220, () => true);
    const sizes = result.map(r => r.accepted.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(220);
    expect(sizes[1]).toBe(20);
    expect(result[1].exhausted).toBe(true);
    expect(Math.abs(sizes[0] - sizes[2])).toBeLessThanOrEqual(BALANCE_STEP);
  });

  it('keeps about 60% paragraphs inside a bucket and fills from the other kind', async () => {
    const [r] = await waterFill([bucket(7, 1000, 1000)], 100, () => true);
    expect(r.accepted.filter(a => a.kind === 'para').length).toBe(60);
    const [short] = await waterFill([bucket(7, 10, 1000)], 100, () => true);
    expect(short.accepted.filter(a => a.kind === 'para').length).toBe(10);
    expect(short.accepted.length).toBe(100);
  });

  it('counts rejected candidates as evaluated', async () => {
    let n = 0;
    const [r] = await waterFill([bucket(8, 100, 100)], 10, () => n++ % 2 === 0);
    expect(r.accepted.length).toBe(10);
    expect(r.evaluated.para + r.evaluated.sent).toBeGreaterThanOrEqual(19);
  });

  it('chooses the next kind by the share', () => {
    expect(nextKind(0, 0, true, true)).toBe('para');
    expect(nextKind(6, 10, true, true)).toBe('para');
    expect(nextKind(7, 10, true, true)).toBe('sent');
    expect(nextKind(0, 0, false, true)).toBe('sent');
    expect(nextKind(0, 0, false, false)).toBeNull();
  });

  it('histograms every grade 3–12', () => {
    const h = gradeHistogram([3, 3, 12, 7]);
    expect([...h.keys()]).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(h.get(3)).toBe(2);
    expect(h.get(5)).toBe(0);
  });
});

describe('split by article', () => {
  const examples = Array.from({ length: 60 }, (_, i) => ({ id: i, articleId: i % 17 }));

  it('never puts an article in both train and dev, and is seeded', () => {
    const a = splitByArticle(examples, 10, 100, mulberry32(42));
    const b = splitByArticle(examples, 10, 100, mulberry32(42));
    expect(a).toEqual(b);
    expect(a.dev.length).toBe(10);
    const devArticles = new Set(a.dev.map(e => e.articleId));
    expect(a.train.some(e => devArticles.has(e.articleId))).toBe(false);
    expect(a.train.length + a.dev.length + a.dropped).toBe(60);
  });

  it('cuts train to its size', () => {
    const s = splitByArticle(examples, 5, 20, mulberry32(1));
    expect(s.train.length).toBe(20);
  });

  it('shuffles deterministically', () => {
    expect(shuffleWith([1, 2, 3, 4, 5], mulberry32(7))).toEqual(shuffleWith([1, 2, 3, 4, 5], mulberry32(7)));
  });
});
