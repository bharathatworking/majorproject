/**
 * Named-entity detection for prompt building (entities the model must preserve).
 *
 * Uses compromise plus its dates and numbers plugins. Plugin methods are typed
 * by passing their method interfaces to the generic `nlp<…>()` call, since
 * `nlp.plugin()` itself returns `any`. Offsets come from `.out('offset')`.
 * Overlapping matches are resolved by start position, then longest match,
 * then type priority.
 *
 * Clean-up after detection:
 *  - Trailing punctuation is trimmed from each match (compromise returns
 *    "in PST." for "…in PST."), and a date loses a leading in / on / at /
 *    the ("in PST" → "PST"), with the offsets adjusted so they still slice
 *    back to the text.
 *  - A date whose core is only a time-zone abbreviation ("in PST", "UTC",
 *    "PST time zone") is a `timezone`, not a date, so a dropped one is
 *    reported as a time zone. "9am EST" stays a date.
 */

import nlp from 'compromise';
import datePlugin, { type DatesMethods } from 'compromise-dates';
import numberPlugin, { type NumbersMethods } from 'compromise-numbers';
import { isTimeZoneText } from './time-zones';
import type { Entity } from '../../types';

nlp.plugin(datePlugin);
nlp.plugin(numberPlugin);

// ─── Clean-up ─────────────────────────────────────────────────────────────────

const TRAILING_PUNCTUATION = /[\s.,;:!?]+$/;
const LEADING_FILLER = /^(?:(?:in|on|at|the)\s+)+/i;

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
        let found = m.text.replace(TRAILING_PUNCTUATION, '');
        let start = m.offset.start;
        if (type === 'date') {
          const lead = LEADING_FILLER.exec(found)?.[0] ?? '';
          if (lead.length < found.length) {
            found = found.slice(lead.length);
            start += lead.length;
          }
        }
        if (!found) continue;
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
