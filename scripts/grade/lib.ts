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
 *  - Provenance is a field on every record, not a file header: an appended
 *    record stays self-describing, and a file that mixes systems is visible
 *    record by record. run-arm.mjs refuses to append when any field of
 *    PROVENANCE_FIELDS differs from a record already in the file (planRunFile;
 *    --new-run starts a fresh file instead), and report.mjs never pools an arm
 *    whose records hold more than one provenance (provenanceGroups).
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
/** /2: every record carries its provenance (see "Provenance" below). */
export const RUN_FORMAT = 'clarity-grade-run/2';
/** Every arm runs the app's Full quality mode (NLI on, no Lite fallback). */
export const GRADE_QUALITY_MODE = 'full';

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

// ─── Provenance ───────────────────────────────────────────────────────────────

/** What produced a run record; every field must match for a resume to append. */
export interface RunProvenance {
  arm: string;
  /** git rev-parse HEAD. */
  commit: string;
  /** Uncommitted changes outside the harness outputs (runs/, REPORT.md). */
  dirty: boolean;
  /** sha256 of the uncommitted changes (diff plus untracked files); null when clean. */
  worktreeSha256: string | null;
  ollamaVersion: string;
  /** The exact Ollama tag. */
  model: string;
  modelDigest: string;
  temperature: number;
  seed: number;
  /** The `think` value sent (thinkSetting), null when none is sent. */
  think: boolean | null;
  qualityMode: string;
  nliModel: string;
  /** sha256 of the raw bytes of eval/grade-targeting/items.jsonl. */
  itemsSha256: string;
}

export const PROVENANCE_FIELDS = [
  'arm', 'commit', 'dirty', 'worktreeSha256', 'ollamaVersion', 'model', 'modelDigest',
  'temperature', 'seed', 'think', 'qualityMode', 'nliModel', 'itemsSha256',
] as const satisfies readonly (keyof RunProvenance)[];

/** A run record as far as provenance goes; records before RUN_FORMAT /2 have none. */
export interface ProvenancedRecord {
  provenance?: RunProvenance | null;
}

export interface ProvenanceMismatch {
  /** A PROVENANCE_FIELDS name, or 'provenance' for a record that has none. */
  field: string;
  file: string;
  current: string;
}

const NOT_RECORDED = '(not recorded)';
const show = (v: unknown) => (v === undefined ? NOT_RECORDED : JSON.stringify(v));

/**
 * Paths from `git status --porcelain=v1 -z`. A rename or copy entry is
 * followed by its original path as a separate field, which is skipped.
 */
export function dirtyFilesFromPorcelain(z: string): string[] {
  const fields = z.split('\0');
  const files: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return files;
}

/**
 * Every field where `current` differs from a provenance already in the file,
 * once per distinct file value. A record without provenance is one mismatch
 * on 'provenance': its conditions can't be compared, so it can't be extended.
 */
export function provenanceMismatches(current: RunProvenance, records: readonly ProvenancedRecord[]): ProvenanceMismatch[] {
  const out: ProvenanceMismatch[] = [];
  const seen = new Set<string>();
  const add = (m: ProvenanceMismatch) => {
    const key = `${m.field}|${m.file}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  };
  for (const r of records) {
    if (!r.provenance) {
      add({ field: 'provenance', file: NOT_RECORDED, current: 'recorded' });
      continue;
    }
    for (const f of PROVENANCE_FIELDS) {
      if (r.provenance[f] !== current[f]) add({ field: f, file: show(r.provenance[f]), current: show(current[f]) });
    }
  }
  return out;
}

export function formatMismatches(mismatches: readonly ProvenanceMismatch[]): string {
  return mismatches.map(m => `  ${m.field}: file ${m.file}, now ${m.current}`).join('\n');
}

export type RunFilePlan<T> =
  | { action: 'fresh'; archive: boolean }
  | { action: 'append'; done: T[] }
  | { action: 'refuse'; mismatches: ProvenanceMismatch[] };

/**
 * What a run does with its run file. `existing` is null when there is no
 * file. --new-run always starts fresh (the caller moves an existing file
 * aside, never deletes it); otherwise the records must all share `current`.
 */
export function planRunFile<T extends ProvenancedRecord>(
  existing: readonly T[] | null,
  current: RunProvenance,
  newRun: boolean,
): RunFilePlan<T> {
  if (newRun) return { action: 'fresh', archive: existing !== null };
  if (existing === null) return { action: 'fresh', archive: false };
  const mismatches = provenanceMismatches(current, existing);
  return mismatches.length > 0 ? { action: 'refuse', mismatches } : { action: 'append', done: [...existing] };
}

/** Where --new-run moves an existing run file (same directory; report.mjs never reads it). */
export function supersededFileName(arm: Arm, stamp: string): string {
  return `arm-${arm}.superseded-${stamp.replace(/[:.]/g, '-')}.jsonl`;
}

export interface ProvenanceGroup {
  /** null for records written before provenance was recorded. */
  provenance: RunProvenance | null;
  count: number;
}

/** The distinct provenances of an arm's records, in first-seen order. */
export function provenanceGroups(records: readonly ProvenancedRecord[]): ProvenanceGroup[] {
  const groups = new Map<string, ProvenanceGroup>();
  for (const r of records) {
    const p = r.provenance ?? null;
    const key = p === null ? '' : JSON.stringify(PROVENANCE_FIELDS.map(f => p[f]));
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { provenance: p, count: 1 });
  }
  return [...groups.values()];
}

export function isMixed(groups: readonly ProvenanceGroup[]): boolean {
  return groups.length > 1;
}

/**
 * The REPORT.md provenance section: which system produced each arm's
 * numbers, and a loud warning for every arm whose file mixes provenances
 * (report.mjs leaves such an arm out of every table and the verdict).
 */
export function provenanceReportLines(byArm: ReadonlyArray<{ arm: string; groups: readonly ProvenanceGroup[] }>): string[] {
  const short = (s: string | null) => (s === null ? '–' : `\`${s.slice(0, 12)}\``);
  const lines = ['## Provenance', ''];
  for (const { arm, groups } of byArm) {
    if (isMixed(groups)) {
      lines.push(
        `> **⚠ MIXED PROVENANCE: arm ${arm}'s run file holds records from ${groups.length} different provenances ` +
        `(${groups.map(g => g.count).join(' + ')} records). They were not produced by one system, so arm ${arm} is NOT pooled: ` +
        `it is left out of every table and the verdict below. Re-run it with --new-run.**`,
        '',
      );
    } else if (groups[0]?.provenance === null) {
      lines.push(`> Arm ${arm}'s records carry no provenance (written before the resume guard); the system that produced them can't be stated.`, '');
    }
  }
  lines.push(
    '| Arm | Records | Commit | Dirty | Model | Digest | Ollama | Temperature | Seed | Think | Quality mode | NLI model | items.jsonl sha256 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const { arm, groups } of byArm) {
    for (const { provenance: p, count } of groups) {
      if (p === null) {
        lines.push(`| ${arm} | ${count} | ${NOT_RECORDED} |  |  |  |  |  |  |  |  |  |  |`);
        continue;
      }
      const dirty = p.dirty ? `**yes** (changes ${short(p.worktreeSha256)})` : 'no';
      lines.push(
        `| ${arm} | ${count} | ${short(p.commit)} | ${dirty} | \`${p.model}\` | ${short(p.modelDigest)} | ${p.ollamaVersion} | ` +
        `${p.temperature} | ${p.seed} | ${p.think === null ? '–' : p.think} | ${p.qualityMode} | \`${p.nliModel}\` | ${short(p.itemsSha256)} |`,
      );
    }
  }
  lines.push('');
  return lines;
}
