/**
 * One sentence splitter for the whole app: the NLI premises and hypotheses
 * (lib/quality/premises.ts), the readability metrics (lib/metrics/engine.ts),
 * the rolling context (lib/run/simplify.ts) and the paste/PDF block splitter
 * (lib/input/text-blocks.ts).
 *
 * Design decisions:
 *  - A boundary is ". ! ? …" (or a run of them, then any closing quotes or
 *    brackets) followed by whitespace. A full stop with no whitespace after
 *    it never splits, so decimals and amounts stay whole: "10.2%",
 *    "₹25.01 trillion", "US$3,500", "5.83 per cent".
 *  - Not a boundary (a number in the text must never be cut from its
 *    sentence, eval/checker/NLI_PERF.md Task 2):
 *     - an abbreviation that introduces a number, before a digit: "No. 5",
 *       "Rs. 300", "Vol. 2", "pp. 10";
 *     - a title or name abbreviation, before a capital or digit: "Dr. Rao",
 *       "St. Mary's", "Mt. Everest";
 *     - "e.g.", "i.e.", "vs.", "approx.", "cf.", "ca." before anything;
 *     - an initial or dotted acronym before a capital: "J. Smith",
 *       "U.S. Army" (an acronym that really ends a sentence is merged with
 *       the next one; a rare, harmless loss);
 *     - an ellipsis ("..." or "…") unless a capital letter follows:
 *       "Wait... then" is one sentence, "It ended... Next" is two.
 *  - `requireStart` (the block splitter) also needs the next sentence to
 *    start with a capital, a digit or an opening quote or bracket, as its
 *    old SENTENCE_BREAK did; the other callers split before anything.
 *  - Pure, no imports, so every bundle and the Node scripts can use it.
 */

// ─── Abbreviations ────────────────────────────────────────────────────────────

/** Abbreviations that introduce a number: no boundary before a digit. */
const NUMBER_ABBREVIATIONS = new Set(['no', 'nos', 'rs', 'vol', 'pp', 'p', 'art', 'sec', 'ch', 'fig', 'ref', 'op']);

/** Titles and name parts: no boundary before a capital or digit. */
const TITLE_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'gen', 'col', 'capt', 'lt', 'sgt',
  'rev', 'hon', 'gov', 'sen', 'rep', 'pres', 'inc', 'ltd', 'co', 'corp', 'dept', 'univ',
]);

/** Never end a sentence. */
const INLINE_ABBREVIATIONS = new Set(['e.g', 'i.e', 'vs', 'approx', 'cf', 'ca', 'viz']);

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** Terminal punctuation, closing quotes or brackets, then whitespace. */
const CANDIDATE = /([.!?…]+)(["'”’)\]]*)(\s+)/g;

/** The word right before the terminal punctuation (letters, digits, dots, $ ₹ etc.). */
const WORD_BEFORE = /([^\s"'“‘(\[]*)$/;

/** An initial or dotted acronym before its last dot: "J", "U.S", "U.K". */
const INITIALS = /^(?:[A-Z]\.)*[A-Z]$/;

const UPPER = /\p{Lu}/u;
const DIGIT = /\d/;
const SENTENCE_START = /["'“‘(\[]?[\p{Lu}\d]/u;

// ─── Splitter ─────────────────────────────────────────────────────────────────

export interface SplitOptions {
  /** Only split before a capital, a digit or an opening quote or bracket. */
  requireStart?: boolean;
}

/** True when the punctuation at `match` ends a sentence (see file header). */
function isBoundary(text: string, match: RegExpExecArray, requireStart: boolean): boolean {
  const punct = match[1];
  const nextIndex = match.index + match[0].length;
  const rest = text.slice(nextIndex);
  if (rest === '') return false;
  const next = rest[0];
  const startsSentence = SENTENCE_START.test(rest.slice(0, 2));
  if (requireStart && !startsSentence) return false;

  // Ellipsis: a pause unless a capital follows
  if (punct.includes('…') || punct.startsWith('..')) return UPPER.test(rest.slice(0, 2));
  if (punct !== '.') return true;

  const word = WORD_BEFORE.exec(text.slice(0, match.index))?.[1] ?? '';
  const lower = word.toLowerCase();
  if (INLINE_ABBREVIATIONS.has(lower)) return false;
  if (NUMBER_ABBREVIATIONS.has(lower) && DIGIT.test(next)) return false;
  if (TITLE_ABBREVIATIONS.has(lower) && (UPPER.test(next) || DIGIT.test(next))) return false;
  if (INITIALS.test(word) && UPPER.test(next)) return false;
  return true;
}

/**
 * The sentences of `text` (a single paragraph; line breaks are whitespace),
 * trimmed, each keeping its punctuation; empty pieces dropped.
 */
export function splitSentenceText(text: string, options: SplitOptions = {}): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    if (!isBoundary(text, match as RegExpExecArray, options.requireStart ?? false)) continue;
    const end = (match.index ?? 0) + match[1].length + match[2].length;
    sentences.push(text.slice(start, end));
    start = end;
  }
  sentences.push(text.slice(start));
  return sentences.map(s => s.trim()).filter(s => s !== '');
}

/**
 * How many sentences the readability formulas count: the boundaries, plus
 * one for a last sentence that ends in . ! ? or …; at least 1.
 */
export function countSentenceText(text: string): number {
  const pieces = splitSentenceText(text);
  if (pieces.length === 0) return 1;
  const last = pieces[pieces.length - 1];
  const count = pieces.length - 1 + (/[.!?…]["'”’)\]]*$/.test(last) ? 1 : 0);
  return Math.max(1, count);
}
