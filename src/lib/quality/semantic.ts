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
 *    's, punctuation and thousands separators are ignored, and number entities
 *    also match by parsed value ("three" = "3", "1,500" = "1500").
 *  - Headings and texts under MIN_WORDS_FOR_CHECK words are not checked:
 *    embeddings of a few words are noisy, and a retry there costs more than it
 *    saves.
 */

import nlp from 'compromise';
import numberPlugin, { type NumbersMethods } from 'compromise-numbers';
import { MIN_WORDS_FOR_CHECK } from './config';
import { cosineSimilarity } from './similarity';
import type { ContentNode, Entity, MeaningCheck } from '../../types';

nlp.plugin(numberPlugin);

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

/** Parsed numeric values in a text ("three apples and 1,500 pears" → [3, 1500]). */
function numberValues(text: string): number[] {
  const values = nlp<NumbersMethods>(text).numbers().get();
  return Array.isArray(values) ? values : [values];
}

/**
 * Entity texts from the original that the simplified text no longer contains,
 * deduplicated in order of appearance.
 */
export function findMissingEntities(entities: readonly Entity[], simplified: string): string[] {
  const haystack = normalize(simplified);
  let simplifiedNumbers: Set<number> | null = null;
  const missing: string[] = [];

  for (const entity of entities) {
    const needle = normalize(entity.text);
    if (needle.trim() === '' || haystack.includes(needle)) continue;

    if (entity.type === 'number') {
      const values = numberValues(entity.text);
      simplifiedNumbers ??= new Set(numberValues(simplified));
      const found = simplifiedNumbers;
      if (values.length > 0 && values.every(v => found.has(v))) continue;
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
