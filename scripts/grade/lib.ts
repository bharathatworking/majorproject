/**
 * Pure logic of the Prompt 11 grade-targeting evaluation
 * (scripts/grade/run-arm.mjs and report.mjs): the pre-registered item draw,
 * the per-output measures that are new here, the paired bootstrap and the
 * pre-registered criteria (eval/grade-targeting/PREREG.md).
 *
 * Design decisions:
 *  - No DOM, no src/ imports, and no Node API but node:path (for the run
 *    files, below): the drivers load this file
 *    through Vite's ssrLoadModule and tests/unit/grade-eval.test.ts imports
 *    it directly. The seeded generator and shuffle come from
 *    scripts/train-data/lib.ts (the same mulberry32 as Prompt 10), not a copy.
 *    Grade hit, entity recall and item text are scripts/train-eval/lib.ts's
 *    (same definitions as Prompt 10); the drivers import them from there.
 *  - These are evaluation constants, not app quality constants, so they live
 *    here and not in src/lib/quality/config.ts (the Prompt 10 pattern).
 *    Every number of the pre-registration is a named constant.
 *  - Selection fills the targets from the highest grade down (10, 8, 6, 4):
 *    a row that is already simple at grade 10 can still serve grade 4, but a
 *    hard row taken by grade 4 first would be lost to grade 10.
 *  - The bootstrap resamples items (pairs), percentile interval with
 *    linear interpolation (numpy's default quantile).
 *  - Run files: run-arm.mjs (writer) and report.mjs (reader) take the runs
 *    directory and the arm-<X>.jsonl name only from runsDir / runFilePath, so
 *    the two can't disagree. Paths resolve from the repository root the
 *    caller passes (nli-node.mjs ROOT, from import.meta.url), never from
 *    process.cwd(); a test checks writer and reader give the same path.
 */

import { isAbsolute, join, normalize } from 'node:path';
import { mulberry32, randomInt, shuffleWith } from '../train-data/lib';

// ─── Constants ────────────────────────────────────────────────────────────────

export const GRADE_SEED = 42;
export const GRADE_TARGETS = [4, 6, 8, 10] as const;
/** Targets in the order selection fills them (hardest first, see header). */
export const FILL_ORDER = [10, 8, 6, 4] as const;
export const SENTENCES_PER_TARGET = 30;
export const PARAGRAPHS_PER_TARGET = 20;
export const PARA_MIN_ROWS = 3;
export const PARA_MAX_ROWS = 5;
/** Sentences need this many words, so every item is meaning-checked (shouldCheckNode). */
export const MIN_ITEM_WORDS = 8;
/** Sampling for every arm. */
export const EVAL_OPTIONS = { temperature: 0, seed: 42 } as const;
/** The one chat model of the evaluation (the app's DEFAULT_LLM_MODEL on 2026-10-23). */
export const GRADE_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
export const ARMS = ['A', 'B', 'C'] as const;
export const ITEMS_FORMAT = 'clarity-grade-items/1';
export const RUN_FORMAT = 'clarity-grade-run/1';

/** Near copy: word-level normalised edit distance from the source below this. */
export const NEAR_COPY_EDIT_MAX = 0.1;
export const BOOTSTRAP_RESAMPLES = 10_000;
export const CI_LEVEL = 0.95;

/** Pre-registered criteria, C vs A. Rates are fractions (0.15 = 15 points). */
export const CRITERIA = {
  minHitGain: 0.15,
  maxMeaningDrop: 0.03,
  maxEntityDrop: 0.02,
  maxNearCopyRate: 0.05,
  maxMedianTimeRise: 0.6,
} as const;

export type Arm = (typeof ARMS)[number];
export type ItemKind = 'sent' | 'para';

export interface GradeItemDraw {
  id: string;
  kind: ItemKind;
  /** ASSET validation row indexes, in order. */
  rows: number[];
  target: number;
}

// ─── Selection ────────────────────────────────────────────────────────────────

export function gradeItemId(kind: ItemKind, rows: readonly number[], target: number): string {
  const base = kind === 'sent' ? `s-${rows[0]}` : `p-${rows[0]}-${rows[rows.length - 1]}`;
  return `g${target}-${base}`;
}

export interface SelectionInput {
  rowCount: number;
  /** Row may be used at all (not a Prompt 10 row, no overlap with a reserved set). */
  inPool: (row: number) => boolean;
  /** Row is long enough to be a sentence item. */
  sentenceLongEnough: (row: number) => boolean;
  /** A joined window overlaps a reserved set (8-gram check on the joined text). */
  windowOverlaps: (rows: number[]) => boolean;
  /** The app would skip this text at this target (isAlreadySimple). */
  alreadySimple: (rows: number[], target: number) => boolean;
  seed?: number;
  sentencesPerTarget?: number;
  paragraphsPerTarget?: number;
}

export interface SelectionResult {
  items: GradeItemDraw[];
  /** Per target: sentence candidates rejected as already simple. */
  alreadySimpleSentences: Record<number, number>;
  /** Per target: paragraph windows rejected as already simple. */
  alreadySimpleParagraphs: Record<number, number>;
  /** Windows rejected because the joined text overlaps a reserved set. */
  overlappingWindows: number;
}

/**
 * The pre-registered draw (PREREG.md "Sampling procedure"): one shuffle of
 * all rows for sentences and one for paragraph starts, both seeded; then per
 * target in FILL_ORDER, first the sentences, then windows of 3–5 rows
 * (size drawn per visited start) that share no row with any item.
 * Throws when a bucket can't be filled.
 */
export function selectGradeItems(input: SelectionInput): SelectionResult {
  const nSent = input.sentencesPerTarget ?? SENTENCES_PER_TARGET;
  const nPara = input.paragraphsPerTarget ?? PARAGRAPHS_PER_TARGET;
  const rand = mulberry32(input.seed ?? GRADE_SEED);
  const all = Array.from({ length: input.rowCount }, (_, i) => i);
  const sentenceOrder = shuffleWith(all, rand);
  const paragraphOrder = shuffleWith(all, rand);
  const used = new Set<number>();
  const items: GradeItemDraw[] = [];
  const alreadySimpleSentences: Record<number, number> = {};
  const alreadySimpleParagraphs: Record<number, number> = {};
  let overlappingWindows = 0;

  for (const target of FILL_ORDER) {
    alreadySimpleSentences[target] = 0;
    alreadySimpleParagraphs[target] = 0;

    let sentences = 0;
    for (const row of sentenceOrder) {
      if (sentences >= nSent) break;
      if (used.has(row) || !input.inPool(row) || !input.sentenceLongEnough(row)) continue;
      if (input.alreadySimple([row], target)) {
        alreadySimpleSentences[target]++;
        continue;
      }
      used.add(row);
      items.push({ id: gradeItemId('sent', [row], target), kind: 'sent', rows: [row], target });
      sentences++;
    }
    if (sentences < nSent) throw new Error(`only ${sentences} sentences for grade ${target} (need ${nSent})`);

    let paragraphs = 0;
    for (const start of paragraphOrder) {
      if (paragraphs >= nPara) break;
      const size = randomInt(PARA_MIN_ROWS, PARA_MAX_ROWS, rand);
      const rows = Array.from({ length: size }, (_, i) => start + i);
      if (rows[rows.length - 1] >= input.rowCount) continue;
      if (rows.some(r => used.has(r) || !input.inPool(r))) continue;
      if (input.windowOverlaps(rows)) {
        overlappingWindows++;
        continue;
      }
      if (input.alreadySimple(rows, target)) {
        alreadySimpleParagraphs[target]++;
        continue;
      }
      rows.forEach(r => used.add(r));
      items.push({ id: gradeItemId('para', rows, target), kind: 'para', rows, target });
      paragraphs++;
    }
    if (paragraphs < nPara) throw new Error(`only ${paragraphs} paragraphs for grade ${target} (need ${nPara})`);
  }

  // File order: by target, then sentences before paragraphs, then by first row
  const kindRank = (k: ItemKind) => (k === 'sent' ? 0 : 1);
  items.sort((a, b) => a.target - b.target || kindRank(a.kind) - kindRank(b.kind) || a.rows[0] - b.rows[0]);
  return { items, alreadySimpleSentences, alreadySimpleParagraphs, overlappingWindows };
}

// ─── Measures ─────────────────────────────────────────────────────────────────

/** Near copy as pre-registered: normalised word edit distance from the source < 0.10. */
export function isNearCopyEdit(editRatio: number): boolean {
  return editRatio < NEAR_COPY_EDIT_MAX;
}

// ─── Statistics ───────────────────────────────────────────────────────────────

/** Quantile of sorted values with linear interpolation (numpy's default). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: readonly number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

export interface BootstrapResult {
  n: number;
  mean: number;
  lo: number;
  hi: number;
}

/**
 * Paired bootstrap of the mean of per-item differences: resamples items with
 * replacement `resamples` times (mulberry32 seeded) and takes the percentile
 * interval at CI_LEVEL.
 */
export function pairedBootstrap(
  diffs: readonly number[],
  resamples: number = BOOTSTRAP_RESAMPLES,
  seed: number = GRADE_SEED,
): BootstrapResult {
  const n = diffs.length;
  if (n === 0) return { n, mean: NaN, lo: NaN, hi: NaN };
  const rand = mulberry32(seed);
  const means = new Array<number>(resamples);
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)];
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  const tail = (1 - CI_LEVEL) / 2;
  return { n, mean: mean(diffs), lo: quantile(means, tail), hi: quantile(means, 1 - tail) };
}

// ─── Criteria ─────────────────────────────────────────────────────────────────

export interface CriteriaInput {
  /** hit(C) − hit(A) per item, bootstrapped (fractions). */
  hitDiff: BootstrapResult;
  /** meaningPass(C) − meaningPass(A) over items fully checked in both arms. */
  meaningDiff: BootstrapResult;
  /** entitiesKept(C) − entitiesKept(A) over items with at least one entity. */
  entityDiff: BootstrapResult;
  nearCopyRateC: number;
  medianSecondsA: number;
  medianSecondsC: number;
}

export interface CriterionResult {
  id: 'primary' | 'meaning' | 'entities' | 'nearCopy' | 'time';
  label: string;
  value: number;
  met: boolean;
}

export interface CriteriaVerdict {
  criteria: CriterionResult[];
  primaryMet: boolean;
  guardrailsMet: boolean;
  /** Enable the retry loop by default only when everything holds. */
  adopt: boolean;
}

/** The pre-registered decision (PREREG.md "Decision rule"). */
export function evaluateCriteria(c: CriteriaInput): CriteriaVerdict {
  const timeRise = c.medianSecondsC / c.medianSecondsA - 1;
  const criteria: CriterionResult[] = [
    {
      id: 'primary',
      label: `Grade hit C − A ≥ +${CRITERIA.minHitGain * 100} points and 95% CI lower bound > 0`,
      value: c.hitDiff.mean,
      met: c.hitDiff.mean >= CRITERIA.minHitGain - 1e-12 && c.hitDiff.lo > 0,
    },
    {
      id: 'meaning',
      label: `Meaning pass rate falls by ≤ ${CRITERIA.maxMeaningDrop * 100} points`,
      value: c.meaningDiff.mean,
      met: c.meaningDiff.mean >= -CRITERIA.maxMeaningDrop - 1e-12,
    },
    {
      id: 'entities',
      label: `Entities kept falls by ≤ ${CRITERIA.maxEntityDrop * 100} points`,
      value: c.entityDiff.mean,
      met: c.entityDiff.mean >= -CRITERIA.maxEntityDrop - 1e-12,
    },
    {
      id: 'nearCopy',
      label: `Arm C near-copy rate ≤ ${CRITERIA.maxNearCopyRate * 100}%`,
      value: c.nearCopyRateC,
      met: c.nearCopyRateC <= CRITERIA.maxNearCopyRate + 1e-12,
    },
    {
      id: 'time',
      label: `Median seconds per node rises by ≤ ${CRITERIA.maxMedianTimeRise * 100}%`,
      value: timeRise,
      met: timeRise <= CRITERIA.maxMedianTimeRise + 1e-12,
    },
  ];
  const primaryMet = criteria[0].met;
  const guardrailsMet = criteria.slice(1).every(r => r.met);
  return { criteria, primaryMet, guardrailsMet, adopt: primaryMet && guardrailsMet };
}

// ─── Run files ────────────────────────────────────────────────────────────────

/** The one name of an arm's run file. */
export function runFileName(arm: Arm): string {
  return `arm-${arm}.jsonl`;
}

export interface RunsDirOptions {
  /** A --limit smoke run: runs/smoke/ instead of the pre-registered runs/. */
  smoke?: boolean;
  /** report.mjs --runs: absolute, or relative to the repository root (not the working directory). */
  runs?: string | null;
}

/** Absolute runs directory, for the writer and the reader alike. */
export function runsDir(root: string, opts: RunsDirOptions = {}): string {
  if (opts.runs) return isAbsolute(opts.runs) ? normalize(opts.runs) : join(root, opts.runs);
  const base = join(root, 'eval', 'grade-targeting', 'runs');
  return opts.smoke ? join(base, 'smoke') : base;
}

export function runFilePath(dir: string, arm: Arm): string {
  return join(dir, runFileName(arm));
}

// ─── Resume ───────────────────────────────────────────────────────────────────

export interface RunKey {
  arm: string;
  itemId: string;
  promptHash: string;
}

/**
 * The wanted items not yet in `done` for this arm. A done one whose first
 * prompt hash differs means the prompt changed mid-run: an error, never a
 * silent mix.
 */
export function pendingItems<T extends RunKey>(wanted: readonly T[], done: readonly RunKey[]): T[] {
  const byKey = new Map(done.map(d => [`${d.arm}|${d.itemId}`, d.promptHash]));
  return wanted.filter(w => {
    const hash = byKey.get(`${w.arm}|${w.itemId}`);
    if (hash === undefined) return true;
    if (hash !== w.promptHash) throw new Error(`prompt changed for arm ${w.arm} item ${w.itemId}; outputs would mix prompts`);
    return false;
  });
}
