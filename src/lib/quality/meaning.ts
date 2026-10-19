/**
 * Meaning assessment under the thesis standard (pipeline stage 6C). Since
 * 2026-10-19 a simplified paragraph keeps its meaning when its COMBINED
 * SCORE reaches the frozen threshold (lib/quality/checker.ts): one logistic
 * regression over SBERT cosine, entity keep ratio, NLI entailment and
 * contradiction, and the length ratio, fit on the calibration set only and
 * pre-registered (eval/checker/PREREG.md, values in config.ts). It replaced
 * the AND of hand-set thresholds (SBERT ≥ 0.87 AND every entity AND NLI rule
 * A), which failed about 4 in 5 faithful calibration paragraphs.
 *
 * Design decisions:
 *  - The checks are injected (`deps`), each returning null when unavailable
 *    or failed, so this module is pure and the run loop owns the fallbacks
 *    (missing embedding model, NLI model not loaded). `fullyChecked` says
 *    whether SBERT and NLI both ran, which the thesis pass rate requires
 *    (lib/quality/similarity.ts meaningStats).
 *  - Model choice: COMBINED_SCORE_FULL when NLI scored the version,
 *    COMBINED_SCORE_LITE (no NLI feature) otherwise: Lite mode, NLI model
 *    missing, or a failed request. nliChecked is true only with FULL. A
 *    missing SBERT value is scored at its training mean (checker.ts).
 *  - SBERT, NLI and the main claim run in parallel (Ollama vs the NLI
 *    worker); the main claim's reverse NLI (mainClaimEntailment) runs only
 *    when the FULL model uses the mainClaim feature.
 *  - Reasons: the features that pulled the score down (negative w·z), worst
 *    first, each named by its existing reason string: dropped entities,
 *    unsupported or contradicted sentences, drift, the lost main point, a
 *    too-short version. The retry prompt names the first MAX_RETRY_REASONS
 *    ("You dropped the number 1945."). `failures` maps those features to
 *    the failure kinds of the run report.
 *  - meaningScore is the combined score: it picks between a first attempt
 *    and its retry, and is the meaning part of the stage 7 candidate total.
 */

import { toPlainText } from '../render/format-output';
import { checkerFeatures, combinedScore, harmfulFeatures, lengthRatioOf, worstFeature } from './checker';
import { COMBINED_SCORE_FULL, COMBINED_SCORE_LITE, MAX_RETRY_REASONS } from './config';
import { mainClaimIndexes, splitSentences } from './premises';
import { findMissingEntities } from './semantic';
import { entityVerdict, MEANING_FAILURES } from './verdict';
import type {
  CheckerFeature, CombinedScoreModel, EntailmentCheck, Entity, MeaningAssessment, MeaningCandidate,
  MeaningFailure, StoredMeaning,
} from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MeaningDeps {
  /** Cosine of original vs plain simplified text; null when not available. */
  similarity: (original: string, simplifiedPlain: string) => Promise<number | null>;
  /** Sentence-level NLI; null when not available. */
  entail: (original: string, simplified: string, hintedWords: readonly string[]) => Promise<EntailmentCheck | null>;
  /**
   * Indexes of the original's main-claim sentences (premises.ts
   * mainClaimIndexes with embeddings); null or absent = without embeddings
   * (every sentence of a 1–2 sentence original, else the first).
   */
  mainClaim?: (original: string, sentences: readonly string[]) => Promise<number[] | null>;
  /**
   * How well the simplified text still entails the original's main claim
   * (nli.ts checkMainClaim); null when unavailable. Called only when the
   * FULL model uses the mainClaim feature.
   */
  mainClaimEntailment?: (
    original: string,
    simplified: string,
    claim: readonly number[],
  ) => Promise<{ entailment: number; weakest: string | null } | null>;
}

/** The frozen score models: FULL with NLI, LITE without. */
export interface ScoreModels {
  full: CombinedScoreModel;
  lite: CombinedScoreModel;
}

export const SCORE_MODELS: ScoreModels = { full: COMBINED_SCORE_FULL, lite: COMBINED_SCORE_LITE };

/** Entity types that are key facts when they sit in the main claim. */
const KEY_TYPES: ReadonlySet<Entity['type']> = new Set<Entity['type']>(['number', 'date', 'timezone']);

// ─── Constants ────────────────────────────────────────────────────────────────

/** Opening of every retry prompt; the specific reasons follow it. */
export const MEANING_RETRY_INSTRUCTION =
  'Your previous version changed the meaning. Keep every fact, number and name from the original.';

const ENTITY_NOUN: Record<Entity['type'], string | null> = {
  number: 'the number',
  date: 'the date',
  timezone: 'the time zone',
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
  `The meaning drifted from the original (similarity ${similarity.toFixed(2)}).`;

export const mainPointReason = (sentence: string) =>
  `You lost the main point of the original: "${sentence}"`;

/** "You left out too much of the original (…)" below a ratio of 1, else "much longer". */
export const lengthReason = (ratio: number) => (ratio < 1
  ? `You left out too much of the original (your version has ${Math.round(ratio * 100)}% of its words).`
  : `Your version is much longer than the original (${Math.round(ratio * 100)}% of its words).`);

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

/**
 * Where each sentence of `original` starts and ends, or null when it can't be
 * found (toPlainText rewrote it). Sentences are searched in order; a trailing
 * period added to a bullet item is ignored.
 */
function sentenceSpans(original: string, sentences: readonly string[]): ({ start: number; end: number } | null)[] {
  let cursor = 0;
  return sentences.map(s => {
    const core = s.replace(/[.!?]+$/, '');
    const start = original.indexOf(core, cursor);
    if (start < 0 || core === '') return null;
    cursor = start + core.length;
    return { start, end: cursor };
  });
}

/**
 * Key entities of an original: the numbers, dates and time zones inside its
 * main-claim sentences (by the entities' offsets). When a main-claim sentence
 * can't be located, every number, date and time zone is key.
 */
export function keyEntityTexts(
  original: string,
  entities: readonly Entity[],
  mainClaim: readonly number[],
  sentences: readonly string[] = splitSentences(original),
): string[] {
  const spans = sentenceSpans(original, sentences);
  const claim = mainClaim.map(i => spans[i] ?? null);
  const all = claim.length === 0 || claim.some(s => s === null);
  return [...new Set(entities
    .filter(e => KEY_TYPES.has(e.type))
    .filter(e => all || claim.some(s => s !== null && e.start >= s.start && e.start < s.end))
    .map(e => e.text))];
}

/** The failure kind each feature stands for in run reports. */
const FEATURE_FAILURE: Record<CheckerFeature, MeaningFailure> = {
  sbert: 'similarity',
  lenRatio: 'similarity',
  entity: 'entities',
  numbers: 'entities',
  nliMin: 'unsupported',
  nliMean: 'unsupported',
  mainClaim: 'unsupported',
  contra: 'contradiction',
};

/** What a version did wrong, for the reason strings. */
interface ReasonContext {
  similarity: number | null;
  lengthRatio: number;
  nli: EntailmentCheck | null;
  mainClaimSentence: string | null;
  missingKey: string[];
  missingMinor: string[];
  typeOf: Map<string, Entity['type']>;
}

/** The reason strings of one harmful feature (empty when there is nothing specific to name). */
function reasonsFor(feature: CheckerFeature, c: ReasonContext): string[] {
  const dropped = (texts: string[]) => texts.map(t => droppedEntityReason(t, c.typeOf.get(t) ?? 'other'));
  const nli = c.nli;
  switch (feature) {
    case 'entity': return dropped([...c.missingKey, ...c.missingMinor]);
    case 'numbers': return dropped(c.missingKey);
    case 'sbert': return c.similarity === null ? [] : [driftReason(c.similarity)];
    case 'lenRatio': return [lengthReason(c.lengthRatio)];
    case 'mainClaim': return c.mainClaimSentence ? [mainPointReason(c.mainClaimSentence)] : [];
    case 'nliMin':
    case 'nliMean': {
      if (!nli) return [];
      if (nli.sentences === 0) return [NO_SENTENCES_REASON];
      const contradicted = new Set(nli.contradictedSentences);
      const named = nli.unsupportedSentences.filter(s => !contradicted.has(s));
      if (named.length > 0) return named.map(unsupportedReason);
      // None below ENTAILMENT_MIN: name the least supported sentence
      const lowest = nli.sentenceScores.filter(s => !s.exempt).sort((x, y) => x.entailment - y.entailment)[0];
      return lowest ? [unsupportedReason(lowest.sentence)] : [];
    }
    case 'contra': {
      if (!nli) return [];
      if (nli.contradictedSentences.length > 0) return nli.contradictedSentences.map(contradictionReason);
      const highest = [...nli.sentenceScores].sort((x, y) => y.contradiction - x.contradiction)[0];
      return highest ? [contradictionReason(highest.sentence)] : [];
    }
  }
}

/** Scores SBERT, entities, NLI and length with the frozen combined score (rules in the file header). */
export async function assessMeaning(
  original: string,
  simplified: string,
  entities: readonly Entity[],
  hintedWords: readonly string[],
  deps: MeaningDeps,
  options: { models?: ScoreModels } = {},
): Promise<MeaningAssessment> {
  const models = options.models ?? SCORE_MODELS;
  const plain = toPlainText(simplified);
  const sentences = splitSentences(original);
  const claimedP = deps.mainClaim ? deps.mainClaim(original, sentences).catch(() => null) : Promise.resolve(null);
  const mainFn = deps.mainClaimEntailment;
  const fullUsesMain = models.full.features.includes('mainClaim');
  const entailP = deps.entail(original, simplified, hintedWords);
  // The reverse NLI only when the forward NLI ran (never in Lite mode); the worker is serial anyway
  const mainP = fullUsesMain && mainFn
    ? Promise.all([entailP, claimedP])
      .then(([n, c]) => (n ? mainFn(original, simplified, c ?? mainClaimIndexes(sentences.length)) : null))
      .catch(() => null)
    : Promise.resolve(null);
  const [similarity, nli, claimed, main] = await Promise.all([
    deps.similarity(original, plain),
    entailP,
    claimedP,
    mainP,
  ]);

  const missingEntities = findMissingEntities([...entities], plain);
  const keyTexts = keyEntityTexts(original, entities, claimed ?? mainClaimIndexes(sentences.length), sentences);
  const entity = entityVerdict({ entityTexts: entities.map(e => e.text), missing: missingEntities, keyTexts });
  const missingSet = new Set(missingEntities);
  const lengthRatio = lengthRatioOf(original, plain);

  const features = checkerFeatures({
    similarity,
    entityRecall: entity.recall,
    nli,
    mainClaimEntailment: main?.entailment ?? null,
    keyKept: keyTexts.length > 0 ? keyTexts.filter(t => !missingSet.has(t)).length / keyTexts.length : 1,
    lengthRatio,
  });
  // FULL needs every NLI feature it uses; otherwise LITE, which uses none
  const model = nli !== null && (!fullUsesMain || main !== null) ? models.full : models.lite;
  const { score, contributions } = combinedScore(model, features);
  const passed = score >= model.threshold;

  let harmful: CheckerFeature[] = [];
  if (!passed) {
    harmful = harmfulFeatures(contributions);
    const worst = worstFeature(contributions);
    if (harmful.length === 0 && worst) harmful = [worst];
  }
  const context: ReasonContext = {
    similarity, lengthRatio, nli, mainClaimSentence: main?.weakest ?? null,
    missingKey: entity.missingKey, missingMinor: entity.missingMinor,
    typeOf: new Map(entities.map(e => [e.text, e.type])),
  };
  const reasons = [...new Set(harmful.flatMap(f => reasonsFor(f, context)))];
  const failures = MEANING_FAILURES.filter(k => harmful.some(f => FEATURE_FAILURE[f] === k));
  const nliChecked = nli !== null && model.id === 'full';

  return {
    similarity,
    entityRecall: entity.recall,
    missingEntities,
    missingKeyEntities: entity.missingKey,
    minEntailment: nli?.minEntailment ?? null,
    maxContradiction: nli?.maxContradiction ?? null,
    nliChecked,
    fullyChecked: nliChecked && similarity !== null,
    passed,
    reasons,
    failures,
    exemptedSentences: nli?.exemptedSentences ?? [],
    exemptionRate: nli?.exemptionRate ?? null,
    nliMs: nli?.ms ?? null,
    nliRankMs: nli?.rankMs ?? null,
    nliScoreMs: nli?.scoreMs ?? null,
    nliSentences: nli?.sentences ?? 0,
    score,
    scoreModel: model.id,
    features,
  };
}

// ─── Scoring and selection ────────────────────────────────────────────────────

/** Meaning part (0–1) of the candidate score: the combined score. */
export function meaningScore(a: MeaningAssessment): number {
  return a.score;
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
    failures: a.failures,
    score: a.score,
    scoreModel: a.scoreModel,
  };
}
