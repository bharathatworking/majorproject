/**
 * Time-zone abbreviations, shared by NER (lib/segmentation/ner.ts, which
 * classifies them) and the entity check (lib/quality/semantic.ts, which
 * matches them).
 *
 * Kept in its own import-free module so the entity check doesn't pull the
 * compromise dates plugin in through ner.ts.
 */

// ─── Time zones ───────────────────────────────────────────────────────────────

/** Time-zone abbreviations, lowercase. */
export const TIME_ZONES: ReadonlySet<string> = new Set([
  'pst', 'pdt', 'est', 'edt', 'cst', 'cdt', 'mst', 'mdt', 'ist', 'utc', 'gmt', 'bst', 'cet', 'cest',
]);

/** Words around a time zone that don't change what it names. */
const TIME_ZONE_FILLER = new Set(['in', 'on', 'at', 'the', 'time', 'zone', 'timezone']);

/** True when every word is filler and at least one is a time-zone abbreviation ("PST time zone"). */
export function isTimeZoneText(text: string): boolean {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.some(w => TIME_ZONES.has(w)) && words.every(w => TIME_ZONES.has(w) || TIME_ZONE_FILLER.has(w));
}
