/**
 * Pure logic of the base-model bake-off (Prompt 9.4): text cleaning, output
 * flags, resume, timing statistics, the blind export / unblind round trip,
 * Wilson and McNemar statistics and the pre-registered winner rule.
 *
 * Design decisions:
 *  - No DOM, no Node APIs and no imports: the scripts in scripts/bakeoff/
 *    load this file through Vite's ssrLoadModule (like the app modules), and
 *    tests/unit/bakeoff.test.ts imports it directly, so it is typechecked.
 *  - The shuffle (mulberry32), wordEditRatio, the near-copy rule and the CSV
 *    format are the same as scripts/labels.mjs and scripts/calibrate-meaning.mjs.
 *    They are copied, not imported, because those scripts run their command
 *    on import and .mjs files can't be imported into strict TypeScript.
 *  - Every threshold of the pre-registered rule is a named constant here, so
 *    REPORT.md can print exactly what was applied.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** The three models, in run order (exact Ollama tags; never substituted). */
export const BAKEOFF_MODELS = ['qwen2.5:3b', 'qwen3:4b-instruct-2507-q4_K_M', 'gemma4:e2b-it-qat'] as const;
/** options.seed for every generation call. */
export const GENERATION_SEED = 42;
/** Seed of the blind export shuffle. */
export const SHUFFLE_SEED = 20261016;
/** Near copy: word edit ratio below this, or similarity above NEAR_COPY_SIMILARITY (calibration rule). */
export const NEAR_COPY_EDIT_RATIO = 0.1;
export const NEAR_COPY_SIMILARITY = 0.97;
/** Output/original word ratio outside [LENGTH_RATIO_MIN, LENGTH_RATIO_MAX] is flagged. */
export const LENGTH_RATIO_MIN = 0.4;
export const LENGTH_RATIO_MAX = 1.6;
/** A target-grade hit is an output FKGL within this many grades of the target. */
export const TARGET_HIT_TOLERANCE = 1;
/** Winner rule: eligibility and tie-break. */
export const MIN_FKGL_DROP = 2;
export const MAX_NEAR_COPY_SHARE = 0.1;
export const TIE_MARGIN = 0.03;

export type RunMode = 'gpu' | 'cpu';
export type Label = 'faithful' | 'unfaithful';

// ─── Text ─────────────────────────────────────────────────────────────────────

/**
 * Removes reasoning blocks: every <think>…</think>, an unclosed <think> to
 * the end, and everything before a stray </think> (a template that opens
 * the block itself). `hadThink` is true when any of these was present.
 */
export function stripThink(text: string): { text: string; hadThink: boolean } {
  let out = text;
  let hadThink = false;
  const closed = /<think>[\s\S]*?<\/think>/gi;
  if (closed.test(out)) {
    hadThink = true;
    out = out.replace(closed, '');
  }
  const open = out.search(/<think>/i);
  if (open >= 0) {
    hadThink = true;
    out = out.slice(0, open);
  }
  const stray = out.search(/<\/think>/i);
  if (stray >= 0) {
    hadThink = true;
    out = out.slice(stray + '</think>'.length);
  }
  return { text: out.trim(), hadThink };
}

/** IPA letters and stress marks that never occur in plain English prose. */
const IPA_CHARS = /[ˈˌːəɪʊɛæɒɔʃʒθðŋɑʌɜɐɚɝʔɹɾʎɲɣχʁɕʑ]/u;

/** True when the text still holds IPA (pronunciation) characters. */
export function hasIpa(text: string): boolean {
  return IPA_CHARS.test(text);
}

/** True when the text still holds citation marks like [1], [a] or [citation needed]. */
export function hasCitationMarks(text: string): boolean {
  return /\[(?:\d+|[a-z]|citation needed|note \d+)\]/i.test(text);
}

/**
 * Cleans a Wikipedia plain-text extract: citation marks, parentheses that
 * hold IPA or only leftover punctuation ("( ; )", "(, )"), then spacing.
 */
export function cleanWikiText(text: string): string {
  let out = text.replace(/\[(?:\d+|[a-z]|citation needed|note \d+)\]/gi, '');
  // Innermost parentheses first, so nested pronunciation groups collapse fully
  for (let i = 0; i < 3; i++) {
    out = out.replace(/\s*\(([^()]*)\)/g, (match, inner: string) => {
      if (IPA_CHARS.test(inner) || /^[\s;,:./]*$/.test(inner)) return '';
      if (/^\s*(?:listen|pronunciation|pronounced)\b/i.test(inner)) return '';
      return match;
    });
  }
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:])/g, '$1')
    .replace(/^ +| +$/gm, '')
    .trim();
}

/** Lowercase words (letters and digits), the unit of wordEditRatio. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Word-level edit distance / the longer text's word count. */
export function wordEditRatio(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (x.length === 0 && y.length === 0) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length] / Math.max(x.length, y.length);
}

/** The calibration's near-copy rule; a missing similarity uses the edit ratio alone. */
export function isNearCopy(editRatio: number, similarity: number | null): boolean {
  return editRatio < NEAR_COPY_EDIT_RATIO || (similarity !== null && similarity > NEAR_COPY_SIMILARITY);
}

// ─── Flags ────────────────────────────────────────────────────────────────────

const REFUSAL = /^\s*(?:i'?m sorry|i am sorry|sorry,|i can(?:'|no)t|i cannot|i am unable|i'm unable|as an ai|i won'?t be able)/i;

/** True when the output opens like a refusal. */
export function looksLikeRefusal(text: string): boolean {
  return REFUSAL.test(text.replace(/[’]/g, "'"));
}

/** Below this share of known English words (of 8+ words) an output counts as non-English. */
export const MIN_ENGLISH_WORD_SHARE = 0.4;

/**
 * True when over 20% of letters are non-Latin, or under MIN_ENGLISH_WORD_SHARE
 * of the words are known English words. `isEnglishWord` is the app's
 * isCommonWord (the 5,000-word list with suffix stripping): a stopword test
 * misfires on terse bullet summaries, which drop most function words.
 */
export function looksNonEnglish(text: string, isEnglishWord: (word: string) => boolean): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const nonLatin = letters.filter(c => !/\p{Script=Latin}/u.test(c)).length;
  if (nonLatin / letters.length > 0.2) return true;
  const words = wordsOf(text).filter(w => /^\p{L}+$/u.test(w));
  if (words.length < 8) return false;
  return words.filter(isEnglishWord).length / words.length < MIN_ENGLISH_WORD_SHARE;
}

export interface FlagInput {
  /** Cleaned output (think blocks removed). */
  output: string;
  /** List items in the original (0 for prose). */
  originalListItems: number;
  /** List items in the output, as parseSimplifiedText reads it. */
  outputListItems: number;
  /** Output / original word count. */
  lengthRatio: number;
  editRatio: number;
  /** all-minilm cosine; null until the flag pass has embedded the pair. */
  similarity: number | null;
  /** Known English word test for looksNonEnglish (the app's isCommonWord). */
  isEnglishWord: (word: string) => boolean;
}

export interface OutputFlags {
  empty: boolean;
  refusal: boolean;
  nonEnglish: boolean;
  listLost: boolean;
  nearCopy: boolean;
  lengthOutOfRange: boolean;
}

/** Every per-output flag of the bake-off. */
export function outputFlags(f: FlagInput): OutputFlags {
  const empty = f.output.trim() === '';
  return {
    empty,
    refusal: !empty && looksLikeRefusal(f.output),
    nonEnglish: !empty && looksNonEnglish(f.output, f.isEnglishWord),
    listLost: f.originalListItems > 0 && f.outputListItems < f.originalListItems,
    nearCopy: !empty && isNearCopy(f.editRatio, f.similarity),
    lengthOutOfRange: f.lengthRatio < LENGTH_RATIO_MIN || f.lengthRatio > LENGTH_RATIO_MAX,
  };
}

// ─── Resume ───────────────────────────────────────────────────────────────────

export interface PairKey {
  model: string;
  mode: RunMode;
  paragraphId: string;
  promptHash: string;
}

const keyOf = (p: Pick<PairKey, 'model' | 'mode' | 'paragraphId'>) => `${p.model}|${p.mode}|${p.paragraphId}`;

/**
 * The wanted pairs that have no record yet. Throws when a record exists with
 * another prompt hash: the prompt changed, so mixing old and new outputs
 * would compare different prompts.
 */
export function pendingPairs(wanted: readonly PairKey[], done: readonly PairKey[]): PairKey[] {
  const doneByKey = new Map(done.map(d => [keyOf(d), d]));
  const mismatched = wanted.filter(w => {
    const d = doneByKey.get(keyOf(w));
    return d !== undefined && d.promptHash !== w.promptHash;
  });
  if (mismatched.length > 0) {
    throw new Error(
      `prompt changed for ${mismatched.length} done pair(s), e.g. ${keyOf(mismatched[0])}; ` +
      'move outputs.jsonl aside to start over',
    );
  }
  return wanted.filter(w => !doneByKey.has(keyOf(w)));
}

// ─── Timing ───────────────────────────────────────────────────────────────────

/** Nearest-rank percentile (p in 0..100); null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** Seconds per 100 input words. */
export function secPer100Words(seconds: number, inputWords: number): number {
  return inputWords > 0 ? (seconds * 100) / inputWords : 0;
}

// ─── Blind export ─────────────────────────────────────────────────────────────

/** Deterministic Fisher–Yates shuffle with mulberry32 (same as scripts/labels.mjs). */
export function shuffle<T>(array: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const BLIND_COLUMNS = ['blind_id', 'original', 'simplified', 'my_label', 'note'] as const;

/** B001, B002, … (1-based). */
export function blindId(index: number): string {
  return `B${String(index + 1).padStart(3, '0')}`;
}

export interface BlindSource {
  model: string;
  paragraphId: string;
  original: string;
  simplified: string;
}

export interface BlindKey {
  seed: number;
  rows: Record<string, { model: string; paragraphId: string }>;
}

/** Shuffles the outputs, numbers them after the shuffle, and splits the CSV rows from the key. */
export function makeBlind(sources: readonly BlindSource[], seed: number): { rows: string[][]; key: BlindKey } {
  const shuffled = shuffle(sources, seed);
  const key: BlindKey = { seed, rows: {} };
  const rows = shuffled.map((s, i) => {
    const id = blindId(i);
    key.rows[id] = { model: s.model, paragraphId: s.paragraphId };
    return [id, s.original, s.simplified, '', ''];
  });
  return { rows: [[...BLIND_COLUMNS], ...rows], key };
}

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** RFC 4180 rows with CRLF line ends and a UTF-8 BOM (Excel shows accents). */
export function toCsv(rows: readonly (readonly string[])[], separator = ','): string {
  return '﻿' + rows.map(r => r.map(quote).join(separator)).join('\r\n') + '\r\n';
}

/** Parses RFC 4180 CSV; the separator (, or ;) is read from the header line. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const separator = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === separator) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

/** faithful / unfaithful (f / u, any case); 'unsure' (or ?); null when empty; undefined when unknown. */
export function normalizeLabel(value: string): Label | 'unsure' | null | undefined {
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'f' || v === 'faithful') return 'faithful';
  if (v === 'u' || v === 'unfaithful') return 'unfaithful';
  if (v === 'unsure' || v === '?') return 'unsure';
  return undefined;
}

export interface UnblindedLabel {
  blindId: string;
  model: string;
  paragraphId: string;
  label: Label | 'unsure' | null;
  note: string;
}

/** Joins the labelled CSV with the key. Throws (naming every bad row) on unknown ids or labels. */
export function unblind(csvText: string, key: BlindKey): UnblindedLabel[] {
  const rows = parseCsv(csvText);
  const header = rows[0]?.map(h => h.trim().toLowerCase()) ?? [];
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`labels CSV: no "${name}" column`);
    return i;
  };
  const [idCol, labelCol, noteCol] = [col('blind_id'), col('my_label'), col('note')];
  const errors: string[] = [];
  const seen = new Set<string>();
  const out: UnblindedLabel[] = [];
  rows.slice(1).forEach((r, k) => {
    const rowNo = k + 2;
    const id = (r[idCol] ?? '').trim();
    const entry = key.rows[id];
    if (!entry) { errors.push(`row ${rowNo}: unknown blind_id "${id}"`); return; }
    if (seen.has(id)) { errors.push(`row ${rowNo}: duplicate blind_id "${id}"`); return; }
    seen.add(id);
    const label = normalizeLabel(r[labelCol] ?? '');
    if (label === undefined) {
      errors.push(`row ${rowNo} (${id}): my_label "${r[labelCol]}" is not faithful / unfaithful / unsure / f / u`);
      return;
    }
    out.push({ blindId: id, ...entry, label, note: (r[noteCol] ?? '').trim() });
  });
  if (errors.length > 0) throw new Error(`labels CSV has errors:\n  ${errors.join('\n  ')}`);
  return out;
}

// ─── Statistics ───────────────────────────────────────────────────────────────

/** Wilson score 95% interval of k successes in n, as [low, high]; null for n = 0. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Exact two-sided McNemar test: b and c are the discordant pairs (model A
 * kept meaning and B didn't, and the reverse). p = min(1, 2·P(X ≤ min(b, c)))
 * for X ~ Binomial(b + c, 0.5).
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let term = Math.pow(0.5, n); // C(n, 0) / 2^n
  let tail = term;
  for (let i = 1; i <= k; i++) {
    term = (term * (n - i + 1)) / i;
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

// ─── Winner rule ──────────────────────────────────────────────────────────────

export interface ModelSummary {
  model: string;
  /** Faithful share over labelled non-near-copy outputs; null when none. */
  meaningKept: number | null;
  /** Mean FKGL(original) − FKGL(output); null when no outputs. */
  fkglDrop: number | null;
  /** Near copies / all outputs. */
  nearCopyShare: number;
  /** Median CPU-only seconds per 100 input words; null when not measured. */
  cpuMedian: number | null;
  /** Fine-tunable with Unsloth on a Colab T4 (documented evidence). */
  finetunable: boolean;
}

export interface WinnerResult {
  winner: string | null;
  eligible: string[];
  ineligible: { model: string; reasons: string[] }[];
  /** One line per decision step, for REPORT.md. */
  steps: string[];
}

const pp = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * The pre-registered rule: eligible = FKGL drop ≥ MIN_FKGL_DROP and near
 * copies ≤ MAX_NEAR_COPY_SHARE; the highest meaning kept wins; when the top
 * two are within TIE_MARGIN the faster CPU-only model wins. A winner that is
 * not fine-tunable is dropped and the rule is applied again to the rest.
 */
export function pickWinner(summaries: readonly ModelSummary[]): WinnerResult {
  const steps: string[] = [];
  const ineligible: WinnerResult['ineligible'] = [];
  let pool = summaries.filter(s => {
    const reasons: string[] = [];
    if (s.fkglDrop === null || s.fkglDrop < MIN_FKGL_DROP) {
      reasons.push(`mean FKGL drop ${s.fkglDrop === null ? 'n/a' : s.fkglDrop.toFixed(2)} < ${MIN_FKGL_DROP}`);
    }
    if (s.nearCopyShare > MAX_NEAR_COPY_SHARE) reasons.push(`near copies ${pp(s.nearCopyShare)} > ${pp(MAX_NEAR_COPY_SHARE)}`);
    if (s.meaningKept === null) reasons.push('no labelled outputs');
    if (reasons.length > 0) ineligible.push({ model: s.model, reasons });
    return reasons.length === 0;
  });
  const eligible = pool.map(s => s.model);
  for (const i of ineligible) steps.push(`${i.model} is not eligible: ${i.reasons.join('; ')}.`);
  if (pool.length === 0) {
    steps.push('No model is eligible, so there is no winner.');
    return { winner: null, eligible, ineligible, steps };
  }

  while (pool.length > 0) {
    const ranked = [...pool].sort((a, b) => (b.meaningKept ?? 0) - (a.meaningKept ?? 0));
    let pick = ranked[0];
    if (ranked.length > 1) {
      const [first, second] = ranked;
      const gap = (first.meaningKept ?? 0) - (second.meaningKept ?? 0);
      if (gap <= TIE_MARGIN + 1e-9) {
        const fa = first.cpuMedian ?? Infinity;
        const fb = second.cpuMedian ?? Infinity;
        pick = fb < fa ? second : first;
        steps.push(
          `${first.model} (${pp(first.meaningKept ?? 0)}) and ${second.model} (${pp(second.meaningKept ?? 0)}) ` +
          `are within ${(TIE_MARGIN * 100).toFixed(0)} percentage points; the faster CPU-only model wins: ${pick.model}.`,
        );
      } else {
        steps.push(`${first.model} has the highest meaning kept (${pp(first.meaningKept ?? 0)}), ${(gap * 100).toFixed(1)} percentage points ahead of ${second.model}.`);
      }
    } else {
      steps.push(`${pick.model} is the only eligible model left.`);
    }
    if (pick.finetunable) {
      steps.push(`${pick.model} is fine-tunable with Unsloth on a Colab T4: it is the winner.`);
      return { winner: pick.model, eligible, ineligible, steps };
    }
    steps.push(`${pick.model} is not fine-tunable with Unsloth on a Colab T4, so it is dropped and the rule is applied again.`);
    pool = pool.filter(s => s !== pick);
  }
  steps.push('No eligible model is fine-tunable, so there is no winner.');
  return { winner: null, eligible, ineligible, steps };
}
