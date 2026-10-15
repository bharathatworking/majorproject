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
 *    on / at / the is dropped ("The Hague" matches "Hague").
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

/** Lowercase word tokens joined by single spaces, padded for whole-word search. */
function normalize(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ` ${words} `;
}

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
