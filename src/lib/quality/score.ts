/**
 * Candidate scoring (pipeline stage 7, prompt optimization): one number per
 * simplified version, so the run can tell whether to try other prompt
 * variants and which version to keep.
 *
 * Design decisions:
 *  - total = WEIGHTS.meaning · meaning + WEIGHTS.readability · readability
 *          + WEIGHTS.length · length, each part in 0–1:
 *      meaning (0.5)     similarity × entityRecall. Keeping the content right
 *                        matters most, so it carries half the weight. Without
 *                        a similarity (embedding model missing) it is the
 *                        entity recall alone.
 *      readability (0.3) how close the output's grade is to the target:
 *                        1 − |gap| / GRADE_GAP_SCALE, floored at 0. A gap
 *                        below the target counts BELOW_TARGET_FACTOR times,
 *                        since simpler than asked is the smaller fault.
 *      length (0.2)      a length/fluency proxy: output words / original
 *                        words. 1 inside LENGTH_IDEAL; falls linearly to 0 at
 *                        LENGTH_MIN (the model dropped content or stopped
 *                        early) and LENGTH_MAX (it padded or explained
 *                        itself). Empty output scores 0.
 *  - QUALITY_THRESHOLD (0.75) decides when "Extra quality" tries the other
 *    variants. Worked examples with a good length: similarity 0.90 and a
 *    1-grade gap give 0.45 + 0.25 + 0.20 = 0.90 (kept); similarity 0.85 and a
 *    3-grade gap give 0.425 + 0.15 + 0.20 = 0.775 (kept, just); similarity
 *    0.85 with a 5-grade gap gives 0.425 + 0.05 + 0.20 = 0.675 (retried).
 *    A version that fails the stage 6C checks is retried whatever its total.
 *  - Pure and synchronous: the run loop measures the similarity and the
 *    missing entities (lib/quality/semantic.ts) and passes them in.
 *  - Imports the metrics engine and, through semantic.ts, compromise, so only
 *    the run module may import it; UI code reads the constants from the run
 *    log instead.
 */

import { estimateNodeGrade } from '../metrics/node-grade';
import { toPlainText } from '../render/format-output';
import { passesChecks } from './semantic';
import type { CandidateScores, MeaningCandidate, PromptVariantId, SimplificationSpec } from '../../types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Weights of the three parts of `total`; they sum to 1. */
export const WEIGHTS = { meaning: 0.5, readability: 0.3, length: 0.2 } as const;

/** Below this total, "Extra quality" tries the other prompt variants. */
export const QUALITY_THRESHOLD = 0.75;

/** Never more model calls than this for one node (first attempt included). */
export const MAX_MODEL_CALLS_PER_NODE = 3;

/** Grade gap at which the readability part reaches 0. */
export const GRADE_GAP_SCALE = 6;

/** Weight of a gap below the target, relative to one above it. */
export const BELOW_TARGET_FACTOR = 0.5;

/** Length ratios scoring 1, and where the score reaches 0 on either side. */
export const LENGTH_IDEAL = { min: 0.5, max: 1.3 } as const;
export const LENGTH_MIN = 0.15;
export const LENGTH_MAX = 2.0;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScoreInput {
  original: string;
  /** Raw model output (bullet markers allowed). */
  simplified: string;
  spec: SimplificationSpec;
  /** Common words for the grade estimate (lib/metrics/word-set.ts). */
  wordSet: Set<string>;
  /** Embedding cosine vs the original; omit when not measured. */
  similarity?: number;
  /** Entities in the original. */
  entityCount?: number;
  /** Entities the output dropped. */
  missingEntityCount?: number;
}

/** A version the run may keep, with its scores. */
export interface ScoredCandidate extends MeaningCandidate {
  variant: PromptVariantId;
  scores: CandidateScores;
}

// ─── Parts ────────────────────────────────────────────────────────────────────

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Readability part (0–1) from a signed grade gap. */
export function readabilityScore(gradeGap: number): number {
  const effective = gradeGap < 0 ? -gradeGap * BELOW_TARGET_FACTOR : gradeGap;
  return clamp01(1 - effective / GRADE_GAP_SCALE);
}

/** Length/fluency part (0–1) from output words / original words. */
export function lengthScore(ratio: number): number {
  if (ratio <= 0) return 0;
  if (ratio < LENGTH_IDEAL.min) return clamp01((ratio - LENGTH_MIN) / (LENGTH_IDEAL.min - LENGTH_MIN));
  if (ratio > LENGTH_IDEAL.max) return clamp01((LENGTH_MAX - ratio) / (LENGTH_MAX - LENGTH_IDEAL.max));
  return 1;
}

// ─── Score ────────────────────────────────────────────────────────────────────

export function scoreCandidate(input: ScoreInput): CandidateScores {
  const plain = toPlainText(input.simplified);
  const outWords = wordCount(plain);
  const inWords = wordCount(input.original);

  const gradeGap = outWords > 0
    ? estimateNodeGrade(plain, input.wordSet) - input.spec.targetGrade
    : 0;
  const similarity = input.similarity ?? null;
  const entityCount = input.entityCount ?? 0;
  const missing = Math.min(input.missingEntityCount ?? 0, entityCount);
  const entityRecall = entityCount > 0 ? (entityCount - missing) / entityCount : 1;
  const lengthRatio = inWords > 0 ? outWords / inWords : 0;

  const meaning = similarity === null ? entityRecall : clamp01(similarity) * entityRecall;
  const readability = outWords > 0 ? readabilityScore(gradeGap) : 0;
  const total =
    WEIGHTS.meaning * meaning +
    WEIGHTS.readability * readability +
    WEIGHTS.length * lengthScore(lengthRatio);

  return { gradeGap, similarity, entityRecall, lengthRatio, total };
}

// ─── Selection ────────────────────────────────────────────────────────────────

/**
 * The version to keep: one that passes the stage 6C checks beats one that
 * fails; otherwise the highest total wins, and the earliest wins ties (the
 * standard prompt comes first). Throws on an empty list.
 */
export function pickBestCandidate<T extends ScoredCandidate>(candidates: T[]): T {
  if (candidates.length === 0) throw new Error('pickBestCandidate: no candidates');
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    const bestPasses = passesChecks(best);
    const cPasses = passesChecks(c);
    if (cPasses !== bestPasses) {
      if (cPasses) best = c;
      continue;
    }
    if (c.scores.total > best.scores.total) best = c;
  }
  return best;
}
