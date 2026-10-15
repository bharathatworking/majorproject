/**
 * Value signatures of numbers, dates, durations and time zones, so the entity
 * check compares what a phrase *says*, not how it is worded: "for the next
 * 21 years" = "for 21 years", "aged 45" = "at age 45", "three" = "3".
 *
 * Design decisions:
 *  - A signature is a set of value tokens:
 *      numbers        "21", "1893", "3" (digits and number words, parsed by
 *                     compromise-numbers; thousands separators ignored)
 *      quantities     "21 year", "30 minute", "45 percent": a number directly
 *                     followed by a unit (singular), so "21 years" ≠ "21 months"
 *      months         "month:june" (full names and abbreviations)
 *      weekdays       "day:monday" (also plurals: "Mondays")
 *      time zones     "tz:pst"
 *  - Everything else is ignored, which drops the modifiers: next, last, the,
 *    about, around, approximately, nearly, almost, over, under, more than,
 *    at least, aged, age, of, for, during, in, on, at, by, some.
 *  - A unit counts only next to a number. "Wednesday hours" is just
 *    Wednesday, and "any hours" or "this week" has no value at all
 *    (hasValue false): such an entity can't be compared, so NER drops it.
 *  - Pure apart from compromise + compromise-numbers (already in the chunks
 *    of both users, lib/segmentation/ner.ts and lib/quality/semantic.ts);
 *    never compromise-dates.
 */

import nlp from 'compromise';
import numberPlugin, { type NumbersMethods } from 'compromise-numbers';
import { TIME_ZONES } from '../segmentation/time-zones';

nlp.plugin(numberPlugin);

// ─── Vocabulary ───────────────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  january: 'january', jan: 'january', february: 'february', feb: 'february', march: 'march', mar: 'march',
  april: 'april', apr: 'april', may: 'may', june: 'june', jun: 'june', july: 'july', jul: 'july',
  august: 'august', aug: 'august', september: 'september', sept: 'september', sep: 'september',
  october: 'october', oct: 'october', november: 'november', nov: 'november', december: 'december', dec: 'december',
};

/** Abbreviations that are also common words, read as months only after a number or before one. */
const AMBIGUOUS_MONTHS = new Set(['may', 'march', 'mar', 'jan', 'jun', 'jul', 'sep', 'dec', 'oct', 'nov', 'aug', 'apr', 'feb']);

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Unit words (and plurals / abbreviations) → canonical singular. */
const UNITS: Record<string, string> = {};
const unit = (canonical: string, ...forms: string[]) => {
  for (const f of [canonical, ...forms]) UNITS[f] = canonical;
};
unit('year', 'years', 'yr', 'yrs');
unit('month', 'months');
unit('week', 'weeks', 'wk', 'wks');
unit('day', 'days');
unit('hour', 'hours', 'hr', 'hrs', 'h');
unit('minute', 'minutes', 'min', 'mins');
unit('second', 'seconds', 'sec', 'secs');
unit('decade', 'decades');
unit('century', 'centuries');
unit('percent', 'per cent', '%', 'pct');
unit('km', 'kilometre', 'kilometres', 'kilometer', 'kilometers');
unit('m', 'metre', 'metres', 'meter', 'meters');
unit('cm', 'centimetre', 'centimetres', 'centimeter', 'centimeters');
unit('mile', 'miles', 'mi');
unit('kg', 'kilogram', 'kilograms', 'kilo', 'kilos');
unit('g', 'gram', 'grams');
unit('pound', 'pounds', 'lb', 'lbs');
unit('dollar', 'dollars', '$', 'usd');
unit('euro', 'euros', '€', 'eur');
unit('people', 'person', 'persons');

/** A number in digits, optionally with decimals; thousands separators removed first. */
const DIGITS = /\d+(?:\.\d+)?/g;

/** After a number: optional hyphen or space, then a unit word or symbol. */
const UNIT_AFTER = /^\s*-?\s*(per cent|%|[a-z$€]+)/i;

// ─── Signature ────────────────────────────────────────────────────────────────

export interface ValueSignature {
  tokens: Set<string>;
  /** Has a number, month, weekday or time zone (units alone don't count). */
  hasValue: boolean;
}

/** Canonical number text: "21", "1.5", "1500" (no trailing zeros). */
const numberToken = (n: number) => String(Number(n.toFixed(6)));

/** Shape of compromise's `.out('offset')` items. */
interface OffsetMatch {
  text: string;
  offset: { start: number; length: number };
}

/**
 * Parsed number matches of a text with where each ends; never throws.
 * compromise-numbers reads digits and words ("twenty-one", "1.5 million");
 * plain digits outside its matches are added, so a parse miss never hides a
 * number.
 */
function numberMatches(text: string): { value: number; end: number }[] {
  const found: { value: number; start: number; end: number }[] = [];
  try {
    const view = nlp<NumbersMethods>(text).numbers();
    const raw: unknown = view.get();
    // get() returns { ptrs: [] } (not an array) when nothing parses
    const values = Array.isArray(raw) ? raw : [];
    const offsets = view.out('offset') as OffsetMatch[];
    if (values.length === offsets.length) {
      values.forEach((v, i) => {
        if (typeof v === 'number' && Number.isFinite(v)) {
          const { start, length } = offsets[i].offset;
          found.push({ value: v, start, end: start + length });
        }
      });
    }
  } catch {
    // Digits below still apply
  }
  const parsed = [...found];
  for (const m of text.matchAll(DIGITS)) {
    const start = m.index ?? 0;
    if (parsed.some(p => start >= p.start && start < p.end)) continue;
    found.push({ value: Number(m[0]), start, end: start + m[0].length });
  }
  return found;
}

/** The unit right after `end`, canonical, or null. */
function unitAfter(text: string, end: number): string | null {
  const m = UNIT_AFTER.exec(text.slice(end));
  if (!m) return null;
  return UNITS[m[1].toLowerCase()] ?? null;
}

/** Value tokens of a text (see file header). */
export function valueSignature(text: string): ValueSignature {
  const clean = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const tokens = new Set<string>();
  let hasValue = false;

  for (const { value, end } of numberMatches(clean)) {
    const n = numberToken(value);
    tokens.add(n);
    hasValue = true;
    // compromise counts a "%" right after the digits as part of the number
    const u = clean[end - 1] === '%' ? 'percent' : unitAfter(clean, end);
    if (u) tokens.add(`${n} ${u}`);
  }

  const lower = clean.toLowerCase();
  for (const w of new Set(lower.split(/[^a-z]+/).filter(Boolean))) {
    const month = MONTHS[w];
    // "may", "march", "jan" … are months only next to a number ("May 5", "5 Mar 2020")
    if (month && (!AMBIGUOUS_MONTHS.has(w) || new RegExp(`\\d\\s*${w}\\b|\\b${w}\\.?\\s*\\d`).test(lower))) {
      tokens.add(`month:${month}`);
      hasValue = true;
    }
    const day = WEEKDAYS.find(d => w === d || w === `${d}s`);
    if (day) {
      tokens.add(`day:${day}`);
      hasValue = true;
    }
    if (TIME_ZONES.has(w)) {
      tokens.add(`tz:${w}`);
      hasValue = true;
    }
  }

  return { tokens, hasValue };
}

/** True when every value token of `needle` is in `haystack`. */
export function signatureKept(needle: ValueSignature, haystack: ValueSignature): boolean {
  for (const t of needle.tokens) if (!haystack.tokens.has(t)) return false;
  return true;
}
