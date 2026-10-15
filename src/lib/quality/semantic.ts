/**
 * Semantic preservation (pipeline stage 6C): checks that a simplified node
 * still says what the original said.
 *
 * Design decisions:
 *  - Two independent checks. Meaning: cosine similarity of Sentence-BERT
 *    embeddings (all-minilm via Ollama /api/embed) against SIMILARITY_THRESHOLD.
 *    Entities: every NER entity of the node (names, numbers, dates) must still
 *    appear in the output. Failing either check fails the version.
 *  - Pure apart from the injected `embed` function, so tests need no fetch or
 *    provider mocks. The run loop (lib/run/simplify.ts) owns the retry.
 *  - Entity matching is forgiving about form, not content: case, possessive
 *    's, punctuation and thousands separators are ignored, and number entities
 *    also match by parsed value ("three" = "3", "1,500" = "1500").
 *  - Headings and texts under MIN_WORDS_FOR_CHECK words are not checked:
 *    embeddings of a few words are noisy, and a retry there costs more than it
 *    saves.
 *  - Retry pick: a version that passes beats one that fails; otherwise the
 *    higher similarity wins, then fewer missing entities, and the original
 *    wins ties (it was produced without the stronger, more literal retry
 *    instruction).
 */

import nlp from 'compromise';
import numberPlugin, { type NumbersMethods } from 'compromise-numbers';
import { cosineSimilarity, MIN_WORDS_FOR_CHECK, SIMILARITY_THRESHOLD } from './similarity';
import type { ContentNode, Entity, MeaningCandidate, MeaningCheck } from '../../types';

// Compromise-free parts live in similarity.ts; re-exported for existing callers
export { averageSimilarity, cosineSimilarity, MIN_WORDS_FOR_CHECK, SIMILARITY_THRESHOLD } from './similarity';

nlp.plugin(numberPlugin);

// ─── Constants ────────────────────────────────────────────────────────────────

/** Prepended to the user prompt when a node is retried after failing a check. */
export const MEANING_RETRY_INSTRUCTION =
  'Your previous version changed the meaning. Keep every fact, number and name from the original.';

/** Batch embedding function, e.g. OllamaProvider.embed. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

// ─── Meaning ──────────────────────────────────────────────────────────────────

/** Embeds both texts in one request and compares them against the threshold. */
export async function checkMeaning(
  original: string,
  simplified: string,
  embed: EmbedFn,
): Promise<MeaningCheck> {
  const [a, b] = await embed([original, simplified]);
  const similarity = cosineSimilarity(a, b);
  return { similarity, passed: similarity >= SIMILARITY_THRESHOLD };
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
export function findMissingEntities(entities: Entity[], simplified: string): string[] {
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

/** True when no entity is missing and the similarity (if measured) meets the threshold. */
export function passesChecks(candidate: MeaningCandidate): boolean {
  return (
    candidate.missingEntities.length === 0 &&
    (candidate.similarity === undefined || candidate.similarity >= SIMILARITY_THRESHOLD)
  );
}

/** Chooses between the first attempt and the retry (rule in the file header). */
export function pickBetterVersion(
  original: MeaningCandidate,
  retry: MeaningCandidate,
): MeaningCandidate {
  const originalPasses = passesChecks(original);
  if (originalPasses !== passesChecks(retry)) return originalPasses ? original : retry;

  if (
    original.similarity !== undefined &&
    retry.similarity !== undefined &&
    original.similarity !== retry.similarity
  ) {
    return retry.similarity > original.similarity ? retry : original;
  }

  return retry.missingEntities.length < original.missingEntities.length ? retry : original;
}
