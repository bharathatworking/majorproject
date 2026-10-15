/**
 * Semantic preservation (pipeline stage 6C), the embedding and entity parts.
 * lib/quality/meaning.ts combines them with the NLI check (nli.ts) into the
 * thesis verdict, and owns the reasons and the retry pick.
 *
 * Design decisions:
 *  - Meaning: cosine similarity of Sentence-BERT embeddings (all-minilm via
 *    Ollama /api/embed); meaning.ts compares it against SIMILARITY_THRESHOLD.
 *    Entities: every NER entity of the node (names, numbers, dates) must still
 *    appear in the output.
 *  - Pure apart from the injected `embed` function, so tests need no fetch or
 *    provider mocks.
 *  - Entity matching is forgiving about form, not content: case, possessive
 *    's, punctuation and thousands separators are ignored.
 *  - Names (person, org, place) compare on their core tokens: a leading in /
 *    on / at / the is dropped ("The Hague" matches "Hague"). Failing that, a
 *    name is kept when every capitalised word of it is in the output
 *    (titles like Professor don't count), a person's surname is ("Marie
 *    Curie" by "Maria Skłodowska Curie"), or its acronym is, in capitals
 *    ("World Health Organization" by "WHO"). A name the output drops or
 *    replaces ("Cordillera Rumi Cruz" → "a mountain range") still fails.
 *  - Numbers, dates and time zones compare by value (lib/quality/values.ts
 *    valueSignature): every number, number+unit, month, weekday and time
 *    zone of the entity must be in the output, and modifiers don't count.
 *    "for the next 21 years" is kept by "for 21 years", "aged 45" by "at age
 *    45", "three" by "3", "in PST time zone" by "during PST"; "1893" missing
 *    or "21 years" → "21 months" still fails. An entity without a
 *    comparable value ("this week") can't be checked and counts as kept.
 *  - Headings and texts under MIN_WORDS_FOR_CHECK words are not checked:
 *    embeddings of a few words are noisy, and a retry there costs more than it
 *    saves.
 */

import { MIN_WORDS_FOR_CHECK } from './config';
import { cosineSimilarity } from './similarity';
import { signatureKept, valueSignature, type ValueSignature } from './values';
import type { ContentNode, Entity, MeaningCheck } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Batch embedding function, e.g. OllamaProvider.embed. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

// ─── Meaning ──────────────────────────────────────────────────────────────────

/** Embeds both texts in one request and returns their cosine similarity. */
export async function checkMeaning(
  original: string,
  simplified: string,
  embed: EmbedFn,
): Promise<MeaningCheck> {
  const [a, b] = await embed([original, simplified]);
  return { similarity: cosineSimilarity(a, b) };
}

// ─── Entities ─────────────────────────────────────────────────────────────────

/**
 * Lowercase word tokens joined by single spaces, padded for whole-word search.
 * Letters with diacritics are letters ("Apurímac", "Skłodowska").
 */
function normalize(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return ` ${words} `;
}

/** Titles that are not part of a name ("Professor Henri Becquerel" → Henri, Becquerel). */
const NAME_TITLES = new Set([
  'professor', 'prof', 'dr', 'mr', 'mrs', 'ms', 'sir', 'lord', 'lady', 'saint', 'st', 'king', 'queen', 'president',
]);

/** The capitalised words of a name, without titles and possessive 's. */
function nameWords(text: string): string[] {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/'s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => /^\p{Lu}/u.test(w) && !NAME_TITLES.has(w.toLowerCase()));
}

/**
 * A name (person, org, place) is kept when every capitalised word of it is a
 * word of the output ("coast of Queensland, Australia" → Queensland,
 * Australia), a person's surname is ("Marie Curie" by "Maria Skłodowska
 * Curie"), or its acronym is, in capitals ("World Health Organization" by
 * "WHO").
 */
function nameKept(entity: Entity, haystack: string, simplified: string): boolean {
  const words = nameWords(entity.text);
  if (words.length === 0) return false;
  const has = (w: string) => haystack.includes(` ${w.toLowerCase()} `);
  if (words.every(has)) return true;
  if (entity.type === 'person' && words.length >= 2 && has(words[words.length - 1])) return true;
  if (words.length >= 2) {
    const acronym = words.map(w => w[0]).join('');
    if (new RegExp(`(^|[^\\p{L}])${acronym}([^\\p{L}]|$)`, 'u').test(simplified)) return true;
  }
  return false;
}

/** Entity types that are names. */
const NAME_TYPES: ReadonlySet<Entity['type']> = new Set<Entity['type']>(['person', 'org', 'place']);

const LEADING_FILLER = new Set(['in', 'on', 'at', 'the']);

/**
 * normalize() without leading in / on / at / the words, padded the same way.
 * Falls back to the full form when nothing else is left.
 */
export function coreTokens(text: string): string {
  const words = normalize(text).trim().split(' ').filter(Boolean);
  let i = 0;
  while (i < words.length - 1 && LEADING_FILLER.has(words[i])) i++;
  return ` ${words.slice(i).join(' ')} `;
}

/** Entity types compared by value rather than by wording. */
const VALUE_TYPES: ReadonlySet<Entity['type']> = new Set<Entity['type']>(['number', 'date', 'timezone']);

/**
 * Entity texts from the original that the simplified text no longer contains,
 * deduplicated in order of appearance.
 */
export function findMissingEntities(entities: readonly Entity[], simplified: string): string[] {
  const haystack = normalize(simplified);
  let simplifiedValues: ValueSignature | null = null;
  const missing: string[] = [];

  for (const entity of entities) {
    const needle = coreTokens(entity.text);
    if (needle.trim() === '' || haystack.includes(needle)) continue;

    if (VALUE_TYPES.has(entity.type)) {
      const values = valueSignature(entity.text);
      simplifiedValues ??= valueSignature(simplified);
      if (!values.hasValue || signatureKept(values, simplifiedValues)) continue;
    }
    if (NAME_TYPES.has(entity.type) && nameKept(entity, haystack, simplified)) continue;

    if (!missing.includes(entity.text)) missing.push(entity.text);
  }
  return missing;
}

// ─── Selection ────────────────────────────────────────────────────────────────

/** Headings and short texts are not checked (see file header). */
export function shouldCheckNode(node: ContentNode): boolean {
  if (node.type === 'heading') return false;
  return node.text.trim().split(/\s+/).filter(Boolean).length >= MIN_WORDS_FOR_CHECK;
}
