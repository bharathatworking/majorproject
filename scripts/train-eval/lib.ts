/**
 * Pure logic of the Prompt 10 Part C evaluation (scripts/train-eval/generate.mjs):
 * the pre-registered item selection on ASSET validation, the per-output
 * measures and the resume rule.
 *
 * Design decisions:
 *  - No imports (the scripts/bakeoff/lib.ts pattern): generate.mjs loads it
 *    through Vite and tests/unit/train-eval.test.ts imports it directly.
 *  - Items come only from ASSET **validation**. ASSET test and TurkCorpus
 *    are reserved for the final benchmark; download.py stores them without
 *    references, and generate.mjs refuses any other source file.
 *  - Selection (author's decision): only items the app would send to the
 *    model at grade 8 (isAlreadySimple false at ELIGIBILITY_GRADE, so also
 *    at 6). 300 sentences, then 100 pseudo-paragraphs of 3–5 consecutive
 *    validation rows that share no row with the sentences or each other.
 *    The same items run at both targets. items.json holds row indexes only.
 *  - Every number of the pre-registration is a named constant here.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const EVAL_SEED = 42;
/** Exact Ollama tags: the base model and the fine-tune (never substituted). */
export const EVAL_MODELS = ['qwen3:4b-instruct-2507-q4_K_M', 'clarity-simplify'] as const;
export const EVAL_TARGETS = [6, 8] as const;
export const N_SENTENCES = 300;
export const N_PARAGRAPHS = 100;
export const PARA_MIN_ROWS = 3;
export const PARA_MAX_ROWS = 5;
/** Items must not be already simple at this grade (the app would skip them). */
export const ELIGIBILITY_GRADE = 8;
/** A grade hit is an output FKGL within this many grades of the target. */
export const GRADE_HIT_TOLERANCE = 1;
/** Sampling for both models; the app's own request has no temperature yet (Prompt 11). */
export const EVAL_OPTIONS = { temperature: 0, seed: 42 } as const;
export const ITEMS_FORMAT = 'clarity-lora-eval-items/1';

export type ItemKind = 'sent' | 'para';

export interface EvalItem {
  id: string;
  kind: ItemKind;
  /** ASSET validation row indexes, in order. */
  rows: number[];
}

// ─── Random ───────────────────────────────────────────────────────────────────

/** mulberry32, the same generator as scripts/train-data/lib.ts. */
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

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Selection ────────────────────────────────────────────────────────────────

export function itemId(kind: ItemKind, rows: readonly number[]): string {
  return kind === 'sent' ? `s-${rows[0]}` : `p-${rows[0]}-${rows[rows.length - 1]}`;
}

/**
 * The pre-registered sample: `nSentences` eligible rows, then `nParagraphs`
 * windows of 3–5 consecutive rows (eligible as a joined text) that share no
 * row with anything chosen before. Throws when the data can't fill it.
 */
export function selectItems(
  rowCount: number,
  sentenceOk: (row: number) => boolean,
  paragraphOk: (rows: number[]) => boolean,
  seed: number = EVAL_SEED,
  nSentences: number = N_SENTENCES,
  nParagraphs: number = N_PARAGRAPHS,
): { sentences: EvalItem[]; paragraphs: EvalItem[]; ineligibleSentences: number; rejectedParagraphs: number } {
  const rand = mulberry32(seed);
  const all = Array.from({ length: rowCount }, (_, i) => i);
  const eligible = all.filter(sentenceOk);
  if (eligible.length < nSentences) throw new Error(`only ${eligible.length} eligible sentences for ${nSentences}`);
  const sentenceRows = shuffled(eligible, rand).slice(0, nSentences).sort((a, b) => a - b);
  const used = new Set(sentenceRows);

  const paragraphs: EvalItem[] = [];
  let rejected = 0;
  for (const start of shuffled(all, rand)) {
    if (paragraphs.length >= nParagraphs) break;
    const size = PARA_MIN_ROWS + Math.floor(rand() * (PARA_MAX_ROWS - PARA_MIN_ROWS + 1));
    const rows = Array.from({ length: size }, (_, i) => start + i);
    if (rows[rows.length - 1] >= rowCount || rows.some(r => used.has(r))) continue;
    if (!paragraphOk(rows)) {
      rejected++;
      continue;
    }
    rows.forEach(r => used.add(r));
    paragraphs.push({ id: itemId('para', rows), kind: 'para', rows });
  }
  if (paragraphs.length < nParagraphs) throw new Error(`only ${paragraphs.length} paragraphs for ${nParagraphs}`);
  paragraphs.sort((a, b) => a.rows[0] - b.rows[0]);
  return {
    sentences: sentenceRows.map(r => ({ id: itemId('sent', [r]), kind: 'sent', rows: [r] })),
    paragraphs,
    ineligibleSentences: rowCount - eligible.length,
    rejectedParagraphs: rejected,
  };
}

/** The text of an item: its rows' originals joined with a space. */
export function itemText(item: EvalItem, originals: readonly string[]): string {
  return item.rows.map(r => originals[r].trim()).join(' ');
}

// ─── Measures ─────────────────────────────────────────────────────────────────

export function gradeHit(fkgl: number | null, target: number): boolean {
  return fkgl !== null && Math.abs(fkgl - target) <= GRADE_HIT_TOLERANCE;
}

/** Share of the source's distinct entity texts still present; null without entities. */
export function entityRecall(distinctEntities: number, missing: number): number | null {
  return distinctEntities === 0 ? null : (distinctEntities - missing) / distinctEntities;
}

/** Distinct entity texts, case-insensitive (first form kept). */
export function distinctTexts(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  return texts.filter(t => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Resume ───────────────────────────────────────────────────────────────────

export interface GenerationKey {
  model: string;
  itemId: string;
  target: number;
  promptHash: string;
}

export function generationKey(k: Omit<GenerationKey, 'promptHash'>): string {
  return `${k.model}|${k.itemId}|${k.target}`;
}

/**
 * The wanted generations not yet in `done`. A done one whose prompt hash
 * differs means the prompt changed after outputs were made: that is an
 * error, never a silent mix.
 */
export function pendingGenerations<T extends GenerationKey>(wanted: readonly T[], done: readonly GenerationKey[]): T[] {
  const byKey = new Map(done.map(d => [generationKey(d), d.promptHash]));
  return wanted.filter(w => {
    const hash = byKey.get(generationKey(w));
    if (hash === undefined) return true;
    if (hash !== w.promptHash) throw new Error(`prompt changed for ${generationKey(w)}; outputs would mix prompts`);
    return false;
  });
}
