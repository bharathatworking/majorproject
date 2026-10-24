/**
 * Grade targeting at inference time (Prompt 11, eval/grade-targeting/PREREG.md
 * arm C): measure each version's Flesch-Kincaid grade, and when it misses the
 * target by more than GRADE_TOLERANCE, say which way in the retry.
 *
 * Design decisions:
 *  - Pure: the caller measures FKGL (computeReadabilityReport over the plain
 *    output, the measure PREREG scores) and passes it in, so this module has
 *    no metrics import and the tests need no word list.
 *  - The grade correction shares the one existing retry; it never adds a
 *    call. planRetry decides one retry that carries the meaning reasons, the
 *    grade direction, or both. With "Extra quality" the two variants carry
 *    the same instruction instead. Worst-case model calls per node are
 *    therefore unchanged: 2 with Extra quality off, 3 with it on
 *    (MAX_MODEL_CALLS_PER_NODE), 2 in Lite mode (one retry, no best-of-N).
 *  - The meaning retry's skip rule (shouldRetry: unsupported-only failures
 *    are not retried) still holds for the meaning part; a grade miss alone
 *    may still use the retry.
 *  - pickGradeAware keeps the meaning check first (a passing version beats a
 *    failing one), then prefers a version on target, then the closer grade,
 *    then the higher meaningScore; the first version wins ties. Arm A's
 *    pickBetterVersion is untouched.
 *  - The wording names the measured grade and the direction only; the
 *    retry prompt is the original prompt plus this note (the model never sees
 *    its earlier version, as with the meaning retry).
 */

import { GRADE_TOLERANCE } from './config';
import { candidatePasses, meaningScore } from './meaning';
import type { GradeMiss, MeaningCandidate, RetryPlan } from '../../types';

// ─── Measure ──────────────────────────────────────────────────────────────────

/**
 * Which way `fkgl` misses `target`, or null when it is within
 * GRADE_TOLERANCE. A null grade (empty output) is not a grade miss: the
 * meaning check fails such a version on its own.
 */
export function gradeMiss(fkgl: number | null, target: number): GradeMiss | null {
  if (fkgl === null || !Number.isFinite(fkgl)) return null;
  if (fkgl > target + GRADE_TOLERANCE) return 'too-hard';
  if (fkgl < target - GRADE_TOLERANCE) return 'too-easy';
  return null;
}

// ─── Retry ────────────────────────────────────────────────────────────────────

/** The grade note of a retry prompt, naming the measured grade and the direction. */
export function buildGradeInstruction(miss: GradeMiss, fkgl: number, target: number): string {
  const measured = Math.round(fkgl * 10) / 10;
  return miss === 'too-hard'
    ? `Your last version read at about grade ${measured}, harder than the target grade ${target}. ` +
      `Rewrite it at grade ${target}: use shorter sentences and commoner, everyday words.`
    : `Your last version read at about grade ${measured}, easier than the target grade ${target}. ` +
      `Rewrite it at grade ${target}: stop over-simplifying; keep the detail, and join short related sentences.`;
}

export interface RetryInput {
  /** The meaning check failed in a way worth retrying (shouldRetry). */
  meaningRetry: boolean;
  /** gradeMiss of the first version; null when on target or the loop is off. */
  miss: GradeMiss | null;
  /** Model calls already made for this node. */
  callsMade: number;
  /** Calls this node may make in all (2 without best-of-N). */
  callLimit: number;
}

/**
 * The one retry, if any: it happens when the meaning check or the grade asks
 * for it and the budget has a call left. It carries every reason at once,
 * so the two never take separate calls.
 */
export function planRetry({ meaningRetry, miss, callsMade, callLimit }: RetryInput): RetryPlan {
  const wanted = meaningRetry || miss !== null;
  if (!wanted || callsMade >= callLimit) return { retry: false, meaning: false, grade: null };
  return { retry: true, meaning: meaningRetry, grade: miss };
}

/** The retry's prefix: the meaning instruction, then the grade note (either may be absent). */
export function combineRetryInstructions(meaningInstruction: string | null, gradeInstruction: string | null): string {
  return [meaningInstruction, gradeInstruction].filter((s): s is string => s !== null && s !== '').join('\n\n');
}

// ─── Selection ────────────────────────────────────────────────────────────────

/**
 * Chooses between the first version and the retry: a passing version beats a
 * failing one; then one on target beats one off it; then the closer grade;
 * then the higher meaningScore. The first version wins ties.
 */
export function pickGradeAware<T extends MeaningCandidate>(
  first: T,
  retry: T,
  target: number,
  gradeOf: (c: T) => number | null,
): T {
  const firstPasses = candidatePasses(first);
  if (firstPasses !== candidatePasses(retry)) return firstPasses ? first : retry;

  const gap = (c: T) => {
    const g = gradeOf(c);
    return g === null || !Number.isFinite(g) ? Infinity : Math.abs(g - target);
  };
  const firstGap = gap(first);
  const retryGap = gap(retry);
  const firstOn = firstGap <= GRADE_TOLERANCE;
  const retryOn = retryGap <= GRADE_TOLERANCE;
  if (firstOn !== retryOn) return firstOn ? first : retry;
  if (retryGap < firstGap) return retry;
  if (firstGap < retryGap) return first;

  if (first.meaning && retry.meaning && meaningScore(retry.meaning) > meaningScore(first.meaning)) return retry;
  return first;
}
