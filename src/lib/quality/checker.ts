/**
 * The combined meaning score: one logistic regression over at most 6
 * features of a simplified version, fit on the calibration set only
 * (scripts/checker/fit.mjs) and frozen in config.ts (eval/checker/PREREG.md).
 *
 * Design decisions:
 *  - Pure (types only), so the app (meaning.ts), the fit script and the
 *    held-out test all run exactly this math: z = (x − mean) / std with the
 *    training means and stds, score = sigmoid(w·z + b).
 *  - Positive class = faithful: a high score means the meaning was kept, and
 *    a version passes when score ≥ the frozen threshold.
 *  - Features that need the NLI model (NLI_FEATURES) are never in a 'lite'
 *    model; a version without NLI is scored with the LITE values. A missing
 *    non-NLI feature (embedding model not pulled) is set to its training
 *    mean (z = 0), so it neither helps nor hurts; the assessment is then not
 *    fully checked, as before.
 *  - contributions (w_j·z_j) say which feature pulled the score down most;
 *    meaning.ts names that feature's problem first in the retry prompt.
 *  - lenRatio counts words the way score.ts does (whitespace split).
 */

import type { CheckerFeature, CheckerFeatures, CombinedScoreModel, EntailmentCheck } from '../../types';

// ─── Features ─────────────────────────────────────────────────────────────────

/** Every candidate feature, in a fixed order (CSV columns, elimination ties). */
export const FEATURES: readonly CheckerFeature[] = [
  'sbert', 'entity', 'nliMin', 'nliMean', 'contra', 'mainClaim', 'numbers', 'lenRatio',
];

/** Features that need the NLI model; a 'lite' model uses none of them. */
export const NLI_FEATURES: ReadonlySet<CheckerFeature> = new Set<CheckerFeature>(['nliMin', 'nliMean', 'contra', 'mainClaim']);

/** Candidate features of a 'lite' model. */
export const LITE_FEATURES: readonly CheckerFeature[] = FEATURES.filter(f => !NLI_FEATURES.has(f));

/** The measured parts a feature vector is built from; null = not measured. */
export interface CheckerParts {
  similarity: number | null;
  entityRecall: number;
  /** The NLI check (null when NLI did not run). */
  nli: Pick<EntailmentCheck, 'minEntailment' | 'maxContradiction' | 'sentenceScores'> | null;
  /** Entailment of the original's main claim by the simplified text. */
  mainClaimEntailment: number | null;
  /** Share of the main claim's numbers, dates and time zones kept (1 when there are none). */
  keyKept: number;
  lengthRatio: number;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Simplified words / original words (0 for an empty original), as score.ts counts them. */
export function lengthRatioOf(original: string, simplifiedPlain: string): number {
  const inWords = wordCount(original);
  return inWords > 0 ? wordCount(simplifiedPlain) / inWords : 0;
}

/**
 * The feature vector of one version. NLI features: checkEntailment's
 * minEntailment (lowest over the non-exempt sentences; 0 for an output with
 * no sentences, 1 when every sentence is exempt) and maxContradiction (over
 * every sentence), and the mean entailment over the non-exempt sentences
 * (minEntailment when there are none).
 */
export function checkerFeatures(parts: CheckerParts): CheckerFeatures {
  const nli = parts.nli;
  let nliMean: number | null = null;
  if (nli) {
    const scored = nli.sentenceScores.filter(s => !s.exempt).map(s => s.entailment);
    nliMean = scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : nli.minEntailment;
  }
  return {
    sbert: parts.similarity,
    entity: parts.entityRecall,
    nliMin: nli ? nli.minEntailment : null,
    nliMean,
    contra: nli ? nli.maxContradiction : null,
    mainClaim: parts.mainClaimEntailment,
    numbers: parts.keyKept,
    lenRatio: parts.lengthRatio,
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

export const sigmoid = (t: number): number => 1 / (1 + Math.exp(-t));

/** (x − mean) / std per value; a std of 0 counts as 1 (a constant feature). */
export function standardise(values: readonly number[], means: readonly number[], stds: readonly number[]): number[] {
  return values.map((x, j) => (x - means[j]) / (stds[j] > 0 ? stds[j] : 1));
}

/** True when the model uses a feature that needs NLI. */
export function usesNli(model: Pick<CombinedScoreModel, 'features'>): boolean {
  return model.features.some(f => NLI_FEATURES.has(f));
}

export interface CombinedScore {
  /** sigmoid(w·z + b): the probability the meaning was kept. */
  score: number;
  /** w_j·z_j per model feature (0 for a missing one). */
  contributions: Partial<Record<CheckerFeature, number>>;
  /** Model features that were null (scored at their training mean). */
  missing: CheckerFeature[];
}

/** The model's score of a feature vector (rules in the file header). */
export function combinedScore(
  model: Omit<CombinedScoreModel, 'id' | 'threshold'>,
  features: Partial<CheckerFeatures>,
): CombinedScore {
  const missing: CheckerFeature[] = [];
  const values = model.features.map((f, j) => {
    const x = features[f];
    if (x === null || x === undefined || Number.isNaN(x)) {
      missing.push(f);
      return model.means[j];
    }
    return x;
  });
  const z = standardise(values, model.means, model.stds);
  const contributions: Partial<Record<CheckerFeature, number>> = {};
  let t = model.bias;
  model.features.forEach((f, j) => {
    const c = model.weights[j] * z[j];
    contributions[f] = c;
    t += c;
  });
  return { score: sigmoid(t), contributions, missing };
}

/** Features that lowered the score (negative contribution), the most harmful first. */
export function harmfulFeatures(contributions: Partial<Record<CheckerFeature, number>>): CheckerFeature[] {
  return (Object.entries(contributions) as [CheckerFeature, number][])
    .filter(([, c]) => c < 0)
    .sort((a, b) => a[1] - b[1] || FEATURES.indexOf(a[0]) - FEATURES.indexOf(b[0]))
    .map(([f]) => f);
}

/** The feature with the lowest contribution (ties: FEATURES order); null for an empty model. */
export function worstFeature(contributions: Partial<Record<CheckerFeature, number>>): CheckerFeature | null {
  const entries = (Object.entries(contributions) as [CheckerFeature, number][])
    .sort((a, b) => a[1] - b[1] || FEATURES.indexOf(a[0]) - FEATURES.indexOf(b[0]));
  return entries[0]?.[0] ?? null;
}
