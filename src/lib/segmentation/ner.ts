/**
 * Named-entity detection for prompt building (entities the model must preserve).
 *
 * Uses compromise plus its dates and numbers plugins. Plugin methods are typed
 * by passing their method interfaces to the generic `nlp<…>()` call, since
 * `nlp.plugin()` itself returns `any`. Offsets come from `.out('offset')`.
 * Overlapping matches are resolved by start position, then longest match,
 * then type priority.
 *
 * Clean-up after detection (offsets are adjusted so every entity still
 * slices back to the text). Each rule removes a junk entity seen in a real
 * run, which the prompt asked the model to keep and the entity check then
 * reported as dropped:
 *  - Leading opening brackets and quotes and trailing punctuation, closing
 *    brackets, quotes and dashes are trimmed ("(Ricky)" → "Ricky",
 *    "Annika—" → "Annika", "30-" → "30").
 *  - A match is cut at a sentence end or an opening bracket: compromise
 *    runs names across them ("Team Cal. The other" → "Team Cal",
 *    "TeamCal (Google" → "TeamCal").
 *  - A date loses leading prepositions and "the" (in, on, at, during,
 *    over, throughout, through, around, about, by, since, from, until,
 *    before, after, within, for): "during PST" → "PST", "Over the 17th
 *    century" → "17th century" (eval/fixtures UK run).
 *  - A capitalised ordinal word (First … Twentieth) directly followed by a
 *    capitalised word is part of a name, not a number: "Second World War",
 *    "First Minister" (the UK run reported "You dropped the number
 *    Second.").
 *  - A date whose core is only a time-zone abbreviation ("in PST", "UTC",
 *    "PST time zone") is a `timezone`, not a date, so a dropped one is
 *    reported as a time zone. "9am EST" stays a date.
 *  - Numbers and dates without a comparable value (lib/quality/values.ts:
 *    no number, month, weekday or time zone) are dropped: "an" read as a
 *    number, "week", "any hours", "(over".
 *  - A unit conversion in brackets right after a quantity is not a fact of
 *    its own: "2,300 kilometres (1,400 mi)" keeps 2,300 only.
 *  - A list marker is not a number: digits followed by "." or ")" and a
 *    capital, at the start of the text, a line or a sentence, or after ":"
 *    ("Objectives: 1. Formative").
 *  - Names (person, org, place) need a capital letter after clean-up
 *    ("zone). Find" → "zone" is dropped), and a name directly followed by
 *    ":" is a label, not a name ("Common Meeting Times: …").
 */

import nlp from 'compromise';
import datePlugin, { type DatesMethods } from 'compromise-dates';
import numberPlugin, { type NumbersMethods } from 'compromise-numbers';
import { isTimeZoneText } from './time-zones';
import { valueSignature } from '../quality/values';
import type { Entity } from '../../types';

nlp.plugin(datePlugin);
nlp.plugin(numberPlugin);

// ─── Clean-up ─────────────────────────────────────────────────────────────────

const LEADING_OPENERS = /^[\s(["'“‘]+/;
const TRAILING_PUNCTUATION = /[\s.,;:!?)\]"'”’—–-]+$/;
const LEADING_FILLER =
  /^(?:(?:in|on|at|the|during|over|throughout|through|around|about|by|since|from|until|before|after|within|for)\s+)+/i;
/** A capitalised ordinal word ("Second" of "Second World War"). */
const ORDINAL_WORD =
  /^(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth|Fourteenth|Fifteenth|Sixteenth|Seventeenth|Eighteenth|Nineteenth|Twentieth)$/;
/** A sentence end inside a match, or an opening bracket: the match is cut there. */
const BOUNDARY = /[.!?]["'”’)\]]*\s+|\s+[([]/;
/** Digits then "." or ")" then a capital: a list marker when it starts a line, a sentence or follows ":". */
const LIST_MARKER_AFTER = /^[.)]\s+["'“‘(]?[A-Z]/;
/** A quantity and its unit, then "(" right before a number: "2,300 kilometres (". */
const UNIT_CONVERSION_BEFORE = /\d[\d,.]*\s*(?:[\p{L}°%²³]+\.?\s*){1,2}\(\s*(?:about\s+|approximately\s+|~)?$/u;
const LIST_MARKER_BEFORE =/(?:^|[\n:.!?]["'”’)]*)\s*$/;

type NameType = 'person' | 'org' | 'place';
const NAME_TYPES: ReadonlySet<Entity['type']> = new Set<NameType>(['person', 'org', 'place']);

/**
 * One cleaned match (rules in the file header), or null when it is junk.
 * `source` is the whole text, for the context checks.
 */
function cleanMatch(
  source: string,
  matchText: string,
  matchStart: number,
  type: Entity['type'],
): { text: string; start: number } | null {
  let text = matchText.replace(LEADING_OPENERS, '');
  const cut = BOUNDARY.exec(text);
  if (cut) text = text.slice(0, cut.index);
  text = text.replace(TRAILING_PUNCTUATION, '');
  if (type === 'date') {
    const lead = LEADING_FILLER.exec(text)?.[0] ?? '';
    if (lead.length < text.length) text = text.slice(lead.length);
  }
  if (!text) return null;
  // compromise's offset can skip leading punctuation its text includes, so
  // find the cleaned text in the source near the match
  const start = source.indexOf(text, Math.max(0, matchStart - 2));
  if (start < 0 || start > matchStart + matchText.length) return null;

  if (NAME_TYPES.has(type)) {
    if (!/[A-Z]/.test(text)) return null;
    if (/^\s*:/.test(source.slice(start + text.length))) return null;
    return { text, start };
  }
  if ((type === 'number' || type === 'date') && !valueSignature(text).hasValue) return null;
  if ((type === 'number' || type === 'date') && ORDINAL_WORD.test(text)
    && /^\s+[A-Z]/.test(source.slice(start + text.length))) {
    return null;
  }
  if (type === 'number' && UNIT_CONVERSION_BEFORE.test(source.slice(0, start))) return null;
  if (type === 'number' && /^\d{1,3}$/.test(text)
    && LIST_MARKER_AFTER.test(source.slice(start + text.length))
    && LIST_MARKER_BEFORE.test(source.slice(0, start))) {
    return null;
  }
  return { text, start };
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Shape of each item returned by compromise's `.out('offset')`. */
interface OffsetMatch {
  text: string;
  offset: { start: number; length: number };
}

// ─── Detection ────────────────────────────────────────────────────────────────

export function detectEntities(text: string): Entity[] {
  try {
    const doc = nlp<DatesMethods & NumbersMethods>(text);
    const entities: Entity[] = [];

    const collect = (matches: OffsetMatch[], type: Entity['type']) => {
      for (const m of matches) {
        const cleaned = cleanMatch(text, m.text, m.offset.start, type);
        if (!cleaned) continue;
        const { text: found, start } = cleaned;
        const kind = type === 'date' && isTimeZoneText(found) ? 'timezone' : type;
        entities.push({ text: found, type: kind, start, end: start + found.length });
      }
    };

    collect(doc.people().out('offset'), 'person');
    collect(doc.organizations().out('offset'), 'org');
    collect(doc.places().out('offset'), 'place');
    collect(doc.dates().out('offset'), 'date');
    collect(doc.numbers().out('offset'), 'number');

    // Deduplicate entities (compromise might match a word as multiple things, e.g. a date and a number)
    // We prefer person > org > place > date > number
    const typePriority: Record<string, number> = { 'person': 5, 'org': 4, 'place': 3, 'timezone': 2, 'date': 2, 'number': 1 };

    // Sort by start position, then by priority
    entities.sort((a, b) => {
      if (a.start === b.start) {
        if (a.end === b.end) {
          return typePriority[b.type] - typePriority[a.type];
        }
        return b.end - a.end; // longest match wins
      }
      return a.start - b.start;
    });

    const filtered: Entity[] = [];
    let lastEnd = -1;
    for (const ent of entities) {
      // If it overlaps with an already accepted entity (which is higher priority or longer), skip it
      if (ent.start < lastEnd) continue;
      filtered.push(ent);
      lastEnd = ent.end;
    }

    return filtered;
  } catch (e) {
    console.error('[Clarity] NER detection failed', e);
    return [];
  }
}
