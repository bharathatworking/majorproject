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
 *      centuries      "century:17" for "17th century", "seventeenth
 *                     century", "17th-century" and "1600s" (a multiple of
 *                     100 then "s"), so the two ways of naming a century
 *                     match (eval/fixtures UK run: "Over the 17th century"
 *                     → "In the 1600s" was reported as dropped). The
 *                     number tokens that only spell the century ("17",
 *                     "17 century", "1600") are `centuryParts`: kept in the
 *                     signature, so "19th century" still keeps a "19th",
 *                     but not required when the needle names the century.
 *                     Decades ("1920s") are unchanged.
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

/** "17th century", "17th-century", "21st centuries". */
const CENTURY_DIGITS = /\b(\d{1,2})(?:st|nd|rd|th)[\s-]+centur(?:y|ies)\b/gi;
/** "seventeenth century", "twenty-first-century". */
const CENTURY_WORDS =
  /\b((?:twenty[\s-])?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth))[\s-]+centur(?:y|ies)\b/gi;
/** "1600s": the century after 16 hundred. */
const HUNDREDS = /\b(\d{1,2})00s\b/g;

const ORDINAL_VALUES: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20,
};

/** Value of "seventeenth" or "twenty-first"; null when not an ordinal word. */
function ordinalWordValue(text: string): number | null {
  const words = text.toLowerCase().split(/[\s-]+/);
  if (words.length === 2 && words[0] === 'twenty') {
    const unit = ORDINAL_VALUES[words[1]];
    return unit !== undefined && unit < 10 ? 20 + unit : null;
  }
  return words.length === 1 ? ORDINAL_VALUES[words[0]] ?? null : null;
}

/** Where a century is named, and which one (see file header). */
function centurySpans(text: string): { start: number; end: number; century: number }[] {
  const spans: { start: number; end: number; century: number }[] = [];
  for (const m of text.matchAll(CENTURY_DIGITS)) {
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, century: Number(m[1]) });
  }
  for (const m of text.matchAll(CENTURY_WORDS)) {
    const century = ordinalWordValue(m[1]);
    if (century !== null) spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, century });
  }
  for (const m of text.matchAll(HUNDREDS)) {
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, century: Number(m[1]) + 1 });
  }
  return spans;
}

// ─── Signature ────────────────────────────────────────────────────────────────

export interface ValueSignature {
  tokens: Set<string>;
  /** Has a number, month, weekday, time zone or century (units alone don't count). */
  hasValue: boolean;
  /** Number tokens that only spell a named century ("17", "17 century", "1600"). */
  centuryParts: Set<string>;
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
function numberMatches(text: string): { value: number; start: number; end: number }[] {
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
  const centuryParts = new Set<string>();
  let hasValue = false;

  const centuries = centurySpans(clean);
  for (const c of centuries) {
    tokens.add(`century:${c.century}`);
    hasValue = true;
  }

  for (const { value, start, end } of numberMatches(clean)) {
    const n = numberToken(value);
    tokens.add(n);
    hasValue = true;
    // compromise counts a "%" right after the digits as part of the number
    const u = clean[end - 1] === '%' ? 'percent' : unitAfter(clean, end);
    if (u) tokens.add(`${n} ${u}`);
    if (centuries.some(c => start >= c.start && start < c.end)) {
      centuryParts.add(n);
      if (u) centuryParts.add(`${n} ${u}`);
    }
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

  return { tokens, hasValue, centuryParts };
}

/**
 * True when every value token of `needle` is in `haystack`. In a date with a
 * number, the weekday is redundant ("Sunday 2 September 1666" is kept by
 * "Sep 2, 1666"); alone it counts ("on Monday"). The number tokens that only
 * spell a named century are redundant too: "17th century" is kept by
 * "1600s" and the other way round (both are "century:17").
 */
export function signatureKept(needle: ValueSignature, haystack: ValueSignature): boolean {
  const hasNumber = [...needle.tokens].some(t => /^\d/.test(t));
  for (const t of needle.tokens) {
    if (hasNumber && t.startsWith('day:')) continue;
    if (needle.centuryParts.has(t)) continue;
    if (!haystack.tokens.has(t)) return false;
  }
  return true;
}
