/**
 * Meaning assessment under the thesis standard (pipeline stage 6C): a
 * simplified paragraph keeps its meaning only if
 *   SBERT cosine ≥ SIMILARITY_THRESHOLD
 *   AND every entity of the original is kept
 *   AND no simplified sentence is contradicted (> CONTRADICTION_MAX) or
 *       unsupported (entailment < ENTAILMENT_MIN) by the original (NLI).
 *
 * Design decisions:
 *  - The checks are injected (`deps`), each returning null when unavailable
 *    or failed, so this module is pure and the run loop owns the fallbacks
 *    (missing embedding model, NLI model not loaded). `passed` means every
 *    check that ran passed; `fullyChecked` says whether all three ran, which
 *    the thesis pass rate requires (lib/quality/similarity.ts meaningStats).
 *  - SBERT and NLI run in parallel (Ollama vs the NLI worker).
 *  - Reasons are specific and ordered by how badly they change the meaning:
 *    dropped entities, contradictions, unsupported sentences, then drift. The
 *    retry prompt names the first MAX_RETRY_REASONS of them, so the model
 *    knows exactly what to fix ("You dropped the number 1945.").
 *  - meaningScore is the meaning part of the stage 7 candidate score:
 *    similarity × entity recall × minimum entailment, each part only when
 *    measured.
 */

import { toPlainText } from '../render/format-output';
import {
  CONTRADICTION_MAX, ENTAILMENT_MIN, MAX_RETRY_REASONS, SIMILARITY_THRESHOLD,
} from './config';
import { findMissingEntities } from './semantic';
import type {
  EntailmentCheck, Entity, MeaningAssessment, MeaningCandidate, StoredMeaning,
} from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MeaningDeps {
  /** Cosine of original vs plain simplified text; null when not available. */
  similarity: (original: string, simplifiedPlain: string) => Promise<number | null>;
  /** Sentence-level NLI; null when not available. */
  entail: (original: string, simplified: string, hintedWords: readonly string[]) => Promise<EntailmentCheck | null>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Opening of every retry prompt; the specific reasons follow it. */
export const MEANING_RETRY_INSTRUCTION =
  'Your previous version changed the meaning. Keep every fact, number and name from the original.';

const ENTITY_NOUN: Record<Entity['type'], string | null> = {
  number: 'the number',
  date: 'the date',
  person: 'the name',
  place: 'the place',
  org: 'the organization',
  other: null,
};

// ─── Reasons ──────────────────────────────────────────────────────────────────

/** "You dropped the number 1945." / "You dropped "Magna Carta"." */
export function droppedEntityReason(text: string, type: Entity['type']): string {
  const noun = ENTITY_NOUN[type];
  return noun ? `You dropped ${noun} ${text}.` : `You dropped "${text}".`;
}

export const contradictionReason = (sentence: string) =>
  `This sentence contradicts the original: "${sentence}"`;

export const unsupportedReason = (sentence: string) =>
  `This sentence is not supported by the original: "${sentence}"`;

export const NO_SENTENCES_REASON = 'The simplified version has no sentences to check against the original.';

export const driftReason = (similarity: number) =>
  `The meaning drifted from the original (similarity ${similarity.toFixed(2)}, needs ${SIMILARITY_THRESHOLD.toFixed(2)}).`;

/**
 * Retry prompt prefix naming what to fix. Without reasons it is the plain
 * MEANING_RETRY_INSTRUCTION.
 */
export function buildRetryInstruction(reasons: readonly string[]): string {
  const named = reasons.slice(0, MAX_RETRY_REASONS);
  if (named.length === 0) return MEANING_RETRY_INSTRUCTION;
  return `${MEANING_RETRY_INSTRUCTION} Fix these problems:\n${named.map(r => `- ${r}`).join('\n')}`;
}

// ─── Assessment ───────────────────────────────────────────────────────────────

/** Combines SBERT, entity recall and NLI into one verdict (rules in the file header). */
export async function assessMeaning(
  original: string,
  simplified: string,
  entities: readonly Entity[],
  hintedWords: readonly string[],
  deps: MeaningDeps,
): Promise<MeaningAssessment> {
  const plain = toPlainText(simplified);
  const [similarity, nli] = await Promise.all([
    deps.similarity(original, plain),
    deps.entail(original, simplified, hintedWords),
  ]);

  const missingEntities = findMissingEntities([...entities], plain);
  const distinct = new Set(entities.map(e => e.text)).size;
  const entityRecall = distinct > 0 ? (distinct - missingEntities.length) / distinct : 1;
  const typeOf = new Map(entities.map(e => [e.text, e.type]));

  const reasons: string[] = missingEntities.map(t => droppedEntityReason(t, typeOf.get(t) ?? 'other'));
  if (nli) {
    reasons.push(...nli.contradictedSentences.map(contradictionReason));
    const contradicted = new Set(nli.contradictedSentences);
    reasons.push(...nli.unsupportedSentences.filter(s => !contradicted.has(s)).map(unsupportedReason));
    if (nli.sentences === 0) reasons.push(NO_SENTENCES_REASON);
  }
  if (similarity !== null && similarity < SIMILARITY_THRESHOLD) reasons.push(driftReason(similarity));

  const passed =
    missingEntities.length === 0 &&
    (similarity === null || similarity >= SIMILARITY_THRESHOLD) &&
    (nli === null || (nli.minEntailment >= ENTAILMENT_MIN && nli.maxContradiction <= CONTRADICTION_MAX));

  return {
    similarity,
    entityRecall,
    missingEntities,
    minEntailment: nli?.minEntailment ?? null,
    maxContradiction: nli?.maxContradiction ?? null,
    nliChecked: nli !== null,
    fullyChecked: nli !== null && similarity !== null,
    passed,
    reasons,
    exemptedSentences: nli?.exemptedSentences ?? [],
    exemptionRate: nli?.exemptionRate ?? null,
    nliMs: nli?.ms ?? null,
    nliSentences: nli?.sentences ?? 0,
  };
}

// ─── Scoring and selection ────────────────────────────────────────────────────

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Meaning part (0–1) of the candidate score: the measured parts multiplied. */
export function meaningScore(a: MeaningAssessment): number {
  let score = a.entityRecall;
  if (a.similarity !== null) score *= clamp01(a.similarity);
  if (a.minEntailment !== null) score *= clamp01(a.minEntailment);
  return score;
}

/** A version passes when it was checked and passed, or was not checked at all. */
export function candidatePasses(c: MeaningCandidate): boolean {
  return c.meaning?.passed ?? true;
}

/**
 * Chooses between the first attempt and the retry: a passing version beats a
 * failing one, then the higher meaningScore wins, and the first version wins
 * ties (it was written without the stricter retry instruction).
 */
export function pickBetterVersion<T extends MeaningCandidate>(first: T, retry: T): T {
  const firstPasses = candidatePasses(first);
  if (firstPasses !== candidatePasses(retry)) return firstPasses ? first : retry;
  if (first.meaning && retry.meaning && meaningScore(retry.meaning) > meaningScore(first.meaning)) {
    return retry;
  }
  return first;
}

/** The fields of an assessment that are stored on a result or cache entry. */
export function toStoredMeaning(a: MeaningAssessment): StoredMeaning {
  return {
    ...(a.similarity !== null && { similarity: a.similarity }),
    entityRecall: a.entityRecall,
    ...(a.minEntailment !== null && { minEntailment: a.minEntailment }),
    ...(a.maxContradiction !== null && { maxContradiction: a.maxContradiction }),
    nliChecked: a.nliChecked,
    passed: a.passed,
    reasons: a.reasons,
  };
}
