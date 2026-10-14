/**
 * Named-entity detection for prompt building (entities the model must preserve).
 *
 * Uses compromise plus its dates and numbers plugins. Plugin methods are typed
 * by passing their method interfaces to the generic `nlp<…>()` call, since
 * `nlp.plugin()` itself returns `any`. Offsets come from `.out('offset')`.
 * Overlapping matches are resolved by start position, then longest match,
 * then type priority.
 */

import nlp from 'compromise';
import datePlugin, { type DatesMethods } from 'compromise-dates';
import numberPlugin, { type NumbersMethods } from 'compromise-numbers';
import type { Entity } from '../../types';

nlp.plugin(datePlugin);
nlp.plugin(numberPlugin);

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
        entities.push({ text: m.text, type, start: m.offset.start, end: m.offset.start + m.offset.length });
      }
    };

    collect(doc.people().out('offset'), 'person');
    collect(doc.organizations().out('offset'), 'org');
    collect(doc.places().out('offset'), 'place');
    collect(doc.dates().out('offset'), 'date');
    collect(doc.numbers().out('offset'), 'number');

    // Deduplicate entities (compromise might match a word as multiple things, e.g. a date and a number)
    // We prefer person > org > place > date > number
    const typePriority: Record<string, number> = { 'person': 5, 'org': 4, 'place': 3, 'date': 2, 'number': 1 };

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
