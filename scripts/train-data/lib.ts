/**
 * Pure logic of the Prompt 10 SFT data builder (scripts/train-data/build-sft.mjs):
 * the dedupe matcher, the A4 filter rules, grade conditioning, the
 * pseudo-paragraph runs, the even grade balance and the split by article.
 *
 * Design decisions:
 *  - No imports, no DOM, no Node APIs: build-sft.mjs loads this file through
 *    Vite's ssrLoadModule and tests/unit/train-data.test.ts imports it
 *    directly, so it is typechecked (the scripts/bakeoff/lib.ts pattern).
 *    Everything that needs the app's own code (FKGL, NER, buildPrompt) lives
 *    in render.ts or in the driver, which pass plain numbers and lists in here.
 *  - The dedupe matcher has a Python twin in training/prepare/dedupe.py.
 *    Both run the cases in dedupe-cases.json, so they cannot drift: the
 *    Python one removes the pairs, this one re-checks every selected example
 *    and aborts the build on a hit.
 *  - Every threshold is a named constant here, so STATS.md and the report
 *    can print exactly what was applied.
 *  - Randomness is mulberry32 (the same generator as the bake-off), seeded
 *    from SFT_SEED, so a rebuild gives byte-identical files.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const SFT_SEED = 42;
/** Dedupe: word n-gram size and the containment share that counts as overlap. */
export const DEDUPE_NGRAM = 8;
export const DEDUPE_OVERLAP_MIN = 0.5;
/** A4 filters. */
export const MIN_SOURCE_WORDS = 8;
export const WORD_RATIO_MIN = 0.4;
export const WORD_RATIO_MAX = 1.3;
export const MIN_FKGL_DROP = 0.5;
/** A5 grade conditioning. */
export const GRADE_MIN = 3;
export const GRADE_MAX = 12;
/** The keep slice is at most this share of all examples. */
export const KEEP_SHARE_MAX = 0.05;
/** Share of paragraph examples wanted inside every grade bucket. */
export const PARA_SHARE = 0.6;
/** Share of the multi-pair runs that go to the paragraph pool (the rest stay sentences). */
export const RUN_PARA_SHARE = 0.5;
export const PARA_MIN_PAIRS = 2;
export const PARA_MAX_PAIRS = 5;
/** System + user + assistant characters; about 1,024 Qwen tokens of English. */
export const MAX_EXAMPLE_CHARS = 3600;
/** Water-filling step of the grade balance (examples per bucket per round). */
export const BALANCE_STEP = 25;

export type ExampleKind = 'para' | 'sent' | 'keep';

export type DropReason =
  | 'short' | 'ratio' | 'fkgl' | 'tooLong' | 'tierNone' | 'addedEntity' | 'lostKeyNumber';

/** The order the filters run in (STATS.md prints the counts in this order). */
export const DROP_REASONS: readonly DropReason[] = [
  'short', 'ratio', 'fkgl', 'tooLong', 'tierNone', 'addedEntity', 'lostKeyNumber',
];

// ─── Random ───────────────────────────────────────────────────────────────────

/** mulberry32: a small seeded generator returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy, driven by `rand`. */
export function shuffleWith<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** An integer in [min, max], driven by `rand`. */
export function randomInt(min: number, max: number, rand: () => number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

// ─── Dedupe ───────────────────────────────────────────────────────────────────

/** NFKC, lowercase, Unicode punctuation and symbols removed, whitespace collapsed. */
export function normaliseForDedupe(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Distinct word n-grams of an already normalised text (none below n words). */
export function wordNgrams(normalised: string, n: number = DEDUPE_NGRAM): Set<string> {
  const words = normalised === '' ? [] : normalised.split(' ');
  const grams = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) grams.add(words.slice(i, i + n).join(' '));
  return grams;
}

export interface ReservedItem {
  source: string;
  text: string;
}

export interface ReservedIndex {
  /** Normalised reserved text → the sources holding it. */
  exact: Map<string, Set<string>>;
  /** 8-gram → indexes into `items`. */
  grams: Map<string, number[]>;
  /** Per reserved item: its source and how many distinct 8-grams it has. */
  items: { source: string; gramCount: number }[];
  /** Per source: every 8-gram of its items. */
  gramsBySource: Map<string, Set<string>>;
}

/** The lookup structure for reservedHits(). */
export function buildReservedIndex(reserved: readonly ReservedItem[]): ReservedIndex {
  const index: ReservedIndex = { exact: new Map(), grams: new Map(), items: [], gramsBySource: new Map() };
  for (const { source, text } of reserved) {
    const norm = normaliseForDedupe(text);
    if (norm === '') continue;
    if (!index.exact.has(norm)) index.exact.set(norm, new Set());
    index.exact.get(norm)!.add(source);
    const grams = wordNgrams(norm);
    const id = index.items.length;
    index.items.push({ source, gramCount: grams.size });
    if (!index.gramsBySource.has(source)) index.gramsBySource.set(source, new Set());
    const bySource = index.gramsBySource.get(source)!;
    for (const g of grams) {
      bySource.add(g);
      const list = index.grams.get(g);
      if (list) list.push(id);
      else index.grams.set(g, [id]);
    }
  }
  return index;
}

/**
 * The reserved sources a text overlaps, sorted: an exact match after
 * normalising, or 8-gram containment ≥ DEDUPE_OVERLAP_MIN in either direction
 * (the share of the text's 8-grams found in one source, or the share of one
 * reserved item's 8-grams found in the text).
 */
export function reservedHits(index: ReservedIndex, text: string): string[] {
  const norm = normaliseForDedupe(text);
  const hits = new Set<string>(index.exact.get(norm) ?? []);
  const grams = wordNgrams(norm);
  if (grams.size > 0) {
    const perItem = new Map<number, number>();
    const perSource = new Map<string, number>();
    for (const g of grams) {
      const ids = index.grams.get(g);
      if (!ids) continue;
      for (const id of ids) perItem.set(id, (perItem.get(id) ?? 0) + 1);
      for (const [source, set] of index.gramsBySource) {
        if (set.has(g)) perSource.set(source, (perSource.get(source) ?? 0) + 1);
      }
    }
    for (const [source, count] of perSource) {
      if (count / grams.size >= DEDUPE_OVERLAP_MIN) hits.add(source);
    }
    for (const [id, count] of perItem) {
      const item = index.items[id];
      if (count / item.gramCount >= DEDUPE_OVERLAP_MIN) hits.add(item.source);
    }
  }
  return [...hits].sort();
}

// ─── Cleaning ─────────────────────────────────────────────────────────────────

/**
 * Removes the pronunciation leftovers of Wikipedia's plain-text dumps on
 * both sides of a pair: "( ; born: 1993)" → "(born: 1993)", empty "( ; )" or
 * "(, )" groups, and spaces before punctuation. Nothing else changes.
 */
export function cleanPairText(text: string): string {
  return text
    .replace(/\s*\(\s*[;,:./\s]*\)/g, '')
    .replace(/\(\s*[;,]+\s*/g, '(')
    .replace(/[ \t]+([,.;:!?)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface CheapMeasures {
  sourceWords: number;
  targetWords: number;
  fkglSource: number;
  fkglTarget: number;
}

/** Simple/source word ratio. */
export function wordRatio(sourceWords: number, targetWords: number): number {
  return sourceWords === 0 ? Infinity : targetWords / sourceWords;
}

/**
 * The first of the cheap A4 rules a simplification pair breaks, or null:
 * source under 8 words, word ratio outside [0.4, 1.3], or FKGL(simple) not
 * at least 0.5 below FKGL(source).
 */
export function cheapDropReason(m: CheapMeasures): DropReason | null {
  if (m.sourceWords < MIN_SOURCE_WORDS) return 'short';
  const ratio = wordRatio(m.sourceWords, m.targetWords);
  if (ratio < WORD_RATIO_MIN || ratio > WORD_RATIO_MAX) return 'ratio';
  if (m.fkglTarget >= m.fkglSource - MIN_FKGL_DROP) return 'fkgl';
  return null;
}

export interface PromptChecks {
  /** System + user + assistant characters. */
  chars: number;
  /** The depth tier buildPrompt used. */
  depthTier: 'none' | 'light' | 'moderate' | 'aggressive';
  kind: ExampleKind;
}

/**
 * Rules on the rendered example: too long for the 1,024-token window, or a
 * simplification whose prompt says "do NOT simplify" (tier 'none'), which
 * would teach the model to ignore the instruction. Keep examples may be 'none'.
 */
export function promptDropReason(c: PromptChecks): DropReason | null {
  if (c.chars > MAX_EXAMPLE_CHARS) return 'tooLong';
  if (c.kind !== 'keep' && c.depthTier === 'none') return 'tierNone';
  return null;
}

/**
 * The entity rules, from lists the driver computes with the app's own NER
 * and matcher: an entity of the simple side missing from the source (an
 * added fact), or a main-claim number / date / time zone of the source
 * missing from the simple side.
 */
export function entityDropReason(addedEntities: readonly string[], lostKeyEntities: readonly string[]): DropReason | null {
  if (addedEntities.length > 0) return 'addedEntity';
  if (lostKeyEntities.length > 0) return 'lostKeyNumber';
  return null;
}

// ─── Grades ───────────────────────────────────────────────────────────────────

export function clampGrade(grade: number): number {
  return Math.min(GRADE_MAX, Math.max(GRADE_MIN, grade));
}

/** The target grade of a simplification: its own FKGL, rounded and clamped to 3–12. */
export function gradeFor(fkglTarget: number): number {
  return clampGrade(Math.round(fkglTarget));
}

/**
 * The target grade of a keep example (target = source): the source FKGL
 * rounded up, so the source is at or below it; null when even grade 12 is
 * below the source.
 */
export function keepGradeFor(fkglSource: number): number | null {
  const g = clampGrade(Math.ceil(fkglSource));
  return fkglSource <= g ? g : null;
}

// ─── Hints ────────────────────────────────────────────────────────────────────

/**
 * The hinted words a target really replaced or removed: a word stays only
 * when no target word shares one of its forms. `formsOf` is the app's
 * wordFormCandidates (lowercase word + suffix-stripped base forms), passed
 * in so this file stays import-free.
 */
export function truthfulHints(
  difficultWords: readonly string[],
  target: string,
  formsOf: (word: string) => string[],
): string[] {
  const targetForms = new Set((target.match(/[A-Za-z]+/g) ?? []).flatMap(formsOf));
  return difficultWords.filter(w => !formsOf(w).some(f => targetForms.has(f)));
}

// ─── Pseudo-paragraphs ────────────────────────────────────────────────────────

export interface AlignedPair {
  id: string;
  articleId: number;
  /** Indexes of the English sentences, in article order. */
  normalIdx: number[];
  /** The English paragraph number, or null when the pair spans paragraphs. */
  paraKey: number | null;
  complex: string;
  simple: string;
}

/**
 * Runs of pairs that follow each other directly in one English paragraph
 * (next pair starts at the sentence after the previous one ends). Input in
 * any order; runs come out by article and position. A pair with no
 * paragraph is a run of its own.
 */
export function contiguousRuns(pairs: readonly AlignedPair[]): AlignedPair[][] {
  const sorted = [...pairs].sort((a, b) => a.articleId - b.articleId || a.normalIdx[0] - b.normalIdx[0]);
  const runs: AlignedPair[][] = [];
  let run: AlignedPair[] = [];
  for (const p of sorted) {
    const prev = run[run.length - 1];
    const joins = prev !== undefined
      && prev.articleId === p.articleId
      && prev.paraKey !== null && prev.paraKey === p.paraKey
      && p.normalIdx[0] === prev.normalIdx[prev.normalIdx.length - 1] + 1;
    if (!joins && run.length > 0) {
      runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** Chunks of 2–5 pairs (random sizes); a last single pair is returned apart. */
export function chunkRun(run: readonly AlignedPair[], rand: () => number): { chunks: AlignedPair[][]; rest: AlignedPair[] } {
  const chunks: AlignedPair[][] = [];
  let i = 0;
  while (run.length - i >= PARA_MIN_PAIRS) {
    const size = Math.min(randomInt(PARA_MIN_PAIRS, PARA_MAX_PAIRS, rand), run.length - i);
    chunks.push(run.slice(i, i + size));
    i += size;
  }
  return { chunks, rest: run.slice(i) };
}

/**
 * Splits the runs into a paragraph pool (RUN_PARA_SHARE of the multi-pair
 * runs, chunked) and a sentence pool (everything else), so no English
 * sentence is in two examples.
 */
export function assignPools(runs: readonly AlignedPair[][], rand: () => number): { paragraphs: AlignedPair[][]; sentences: AlignedPair[] } {
  const paragraphs: AlignedPair[][] = [];
  const sentences: AlignedPair[] = [];
  for (const run of runs) {
    if (run.length >= PARA_MIN_PAIRS && rand() < RUN_PARA_SHARE) {
      const { chunks, rest } = chunkRun(run, rand);
      paragraphs.push(...chunks);
      sentences.push(...rest);
    } else {
      sentences.push(...run);
    }
  }
  return { paragraphs, sentences };
}

/** One example text from a chunk of pairs: each side joined with spaces. */
export function joinChunk(chunk: readonly AlignedPair[]): { complex: string; simple: string } {
  return {
    complex: chunk.map(p => p.complex.trim()).join(' '),
    simple: chunk.map(p => p.simple.trim()).join(' '),
  };
}

// ─── Balance ──────────────────────────────────────────────────────────────────

export interface Bucket<T> {
  grade: number;
  /** Candidates in seeded order, per kind. */
  para: T[];
  sent: T[];
}

export interface BucketResult<T> {
  grade: number;
  accepted: { kind: 'para' | 'sent'; item: T }[];
  /** Candidates the accept test ran on, per kind (for honest drop rates). */
  evaluated: { para: number; sent: number };
  exhausted: boolean;
}

/** The kind to take next so the bucket stays near PARA_SHARE paragraphs. */
export function nextKind(paraTaken: number, total: number, paraLeft: boolean, sentLeft: boolean): 'para' | 'sent' | null {
  if (!paraLeft && !sentLeft) return null;
  if (!paraLeft) return 'sent';
  if (!sentLeft) return 'para';
  return paraTaken < PARA_SHARE * (total + 1) ? 'para' : 'sent';
}

/**
 * Even grade balance by water-filling: raise one cap for every bucket in
 * steps of BALANCE_STEP, pulling candidates through `accept` (the expensive
 * filters, run lazily) until `target` examples are accepted or every bucket
 * is exhausted. A bucket that runs out stays short; every other bucket ends
 * at the same cap, and the overshoot of the last round is trimmed from the
 * fullest buckets, latest first. Inside a bucket nextKind keeps the
 * para / sent mix.
 */
export async function waterFill<T>(
  buckets: readonly Bucket<T>[],
  target: number,
  accept: (item: T, kind: 'para' | 'sent') => Promise<boolean> | boolean,
): Promise<BucketResult<T>[]> {
  const state = buckets.map(b => ({
    bucket: b,
    pos: { para: 0, sent: 0 },
    result: { grade: b.grade, accepted: [], evaluated: { para: 0, sent: 0 }, exhausted: false } as BucketResult<T>,
  }));
  const total = () => state.reduce((n, s) => n + s.result.accepted.length, 0);
  let cap = 0;
  while (total() < target && state.some(s => !s.result.exhausted)) {
    cap += BALANCE_STEP;
    for (const s of state) {
      while (!s.result.exhausted && s.result.accepted.length < cap) {
        const paraTaken = s.result.accepted.filter(a => a.kind === 'para').length;
        const kind = nextKind(
          paraTaken, s.result.accepted.length,
          s.pos.para < s.bucket.para.length, s.pos.sent < s.bucket.sent.length,
        );
        if (kind === null) {
          s.result.exhausted = true;
          break;
        }
        const item = s.bucket[kind][s.pos[kind]++];
        s.result.evaluated[kind]++;
        if (await accept(item, kind)) s.result.accepted.push({ kind, item });
      }
    }
  }
  // Trim the overshoot from the fullest buckets
  let over = total() - target;
  while (over > 0) {
    const fullest = state.reduce((a, b) => (b.result.accepted.length > a.result.accepted.length ? b : a));
    fullest.result.accepted.pop();
    over--;
  }
  return state.map(s => s.result);
}

// ─── Split ────────────────────────────────────────────────────────────────────

/**
 * Train / dev split by article: articles in seeded order go to dev until it
 * has `devSize` examples (an article that would overshoot is cut, and its
 * extra examples are dropped, never put in train), the rest to train, cut
 * to `trainSize`. No article is in both.
 */
export function splitByArticle<T extends { articleId: number }>(
  examples: readonly T[],
  devSize: number,
  trainSize: number,
  rand: () => number,
): { train: T[]; dev: T[]; dropped: number } {
  const byArticle = new Map<number, T[]>();
  for (const e of examples) {
    const list = byArticle.get(e.articleId);
    if (list) list.push(e);
    else byArticle.set(e.articleId, [e]);
  }
  const articles = shuffleWith([...byArticle.keys()].sort((a, b) => a - b), rand);
  const dev: T[] = [];
  const train: T[] = [];
  let dropped = 0;
  for (const id of articles) {
    const list = byArticle.get(id)!;
    if (dev.length < devSize) {
      const room = devSize - dev.length;
      dev.push(...list.slice(0, room));
      dropped += Math.max(0, list.length - room);
    } else {
      train.push(...list);
    }
  }
  dropped += Math.max(0, train.length - trainSize);
  return { train: train.slice(0, trainSize), dev, dropped };
}

// ─── Statistics ───────────────────────────────────────────────────────────────

/** Count per grade 3–12 (always all ten keys, in order). */
export function gradeHistogram(grades: readonly number[]): Map<number, number> {
  const hist = new Map<number, number>();
  for (let g = GRADE_MIN; g <= GRADE_MAX; g++) hist.set(g, 0);
  for (const g of grades) hist.set(g, (hist.get(g) ?? 0) + 1);
  return hist;
}

/** min / median / mean / p95 / max of a list (null when empty). */
export function describe(values: readonly number[]): { min: number; median: number; mean: number; p95: number; max: number } | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
  return { min: s[0], median: at(0.5), mean: s.reduce((a, b) => a + b, 0) / s.length, p95: at(0.95), max: s[s.length - 1] };
}
