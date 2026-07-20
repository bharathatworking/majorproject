import nlp from 'compromise';
import datePlugin from 'compromise-dates';
import numberPlugin from 'compromise-numbers';
import type { Entity } from '../../types';

nlp.plugin(datePlugin);
nlp.plugin(numberPlugin);

export function detectEntities(text: string): Entity[] {
  try {
    const doc = nlp(text);
    const entities: Entity[] = [];

    // Persons
    const people = doc.people().out('offsets');
    people.forEach((p: any) => entities.push({ text: p.text, type: 'person', start: p.offset.start, end: p.offset.start + p.offset.length }));

    // Organizations
    const orgs = doc.organizations().out('offsets');
    orgs.forEach((o: any) => entities.push({ text: o.text, type: 'org', start: o.offset.start, end: o.offset.start + o.offset.length }));

    // Places
    const places = doc.places().out('offsets');
    places.forEach((p: any) => entities.push({ text: p.text, type: 'place', start: p.offset.start, end: p.offset.start + p.offset.length }));

    // Dates
    const dates = doc.dates().out('offsets');
    dates.forEach((d: any) => entities.push({ text: d.text, type: 'date', start: d.offset.start, end: d.offset.start + d.offset.length }));

    // Numbers (values)
    const numbers = doc.numbers().out('offsets');
    numbers.forEach((n: any) => entities.push({ text: n.text, type: 'number', start: n.offset.start, end: n.offset.start + n.offset.length }));

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
    console.error('NER detection failed', e);
    return [];
  }
}
