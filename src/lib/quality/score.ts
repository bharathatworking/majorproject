/**
 * Candidate scoring (pipeline stage 7, prompt optimization): one number per
 * simplified version, so the run can tell whether to try other prompt
 * variants and which version to keep.
 *
 * Design decisions:
 *  - total = WEIGHTS.meaning · meaning + WEIGHTS.readability · readability
 *          + WEIGHTS.length · length, each part in 0–1:
 *      meaning (0.5)     meaningScore of the thesis assessment
 *                        (lib/quality/meaning.ts): the combined meaning score
 *                        (since 2026-10-19; before, similarity × entity
 *                        recall × minimum NLI entailment). Keeping the
 *                        content right matters most, so it carries half the
 *                        weight. A node that is not checked (heading, short
 *                        text) scores 1 here. The frozen score is strongly
 *                        regularised and stays roughly in 0.35–0.7, so this
 *                        part is lower than with the old product.
 *      readability (0.3) how close the output's grade is to the target:
 *                        1 − |gap| / GRADE_GAP_SCALE, floored at 0. A gap
 *                        below the target counts BELOW_TARGET_FACTOR times,
 *                        since simpler than asked is the smaller fault.
 *      length (0.2)      a length/fluency proxy: output words / original
 *                        words. 1 inside LENGTH_IDEAL; falls linearly to 0 at
 *                        LENGTH_MIN (the model dropped content or stopped
 *                        early) and LENGTH_MAX (it padded or explained
 *                        itself). Empty output scores 0.
 *  - QUALITY_THRESHOLD (0.718) decides when "Extra quality" tries the other
 *    variants. It was 0.75 for the old meaning part and was rescaled for the
 *    combined score by quantile matching on the calibration items (config.ts,
 *    npm run checker:rescale), so the same share of versions is retried.
 *    Worked examples with a good length: combined score 0.65 and a 1-grade
 *    gap give 0.325 + 0.25 + 0.20 = 0.775 (kept); 0.55 and a 2-grade gap
 *    give 0.275 + 0.20 + 0.20 = 0.675 (retried). A version that fails the
 *    stage 6C checks is retried whatever its total.
 *  - Pure and synchronous: the run loop runs assessMeaning and passes the
 *    assessment in. All constants live in config.ts.
 *  - Imports the metrics engine and, through meaning.ts, compromise, so only
 *    the run module may import it.
 */

import { estimateNodeGrade } from '../metrics/node-grade';
import { toPlainText } from '../render/format-output';
import {
  BELOW_TARGET_FACTOR, GRADE_GAP_SCALE, LENGTH_IDEAL, LENGTH_MAX, LENGTH_MIN, WEIGHTS,
} from './config';
import { candidatePasses, meaningScore } from './meaning';
import type {
  CandidateScores, MeaningAssessment, MeaningCandidate, PromptVariantId, SimplificationSpec,
} from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScoreInput {
  original: string;
  /** Raw model output (bullet markers allowed). */
  simplified: string;
  spec: SimplificationSpec;
  /** Common words for the grade estimate (lib/metrics/word-set.ts). */
  wordSet: Set<string>;
  /** Thesis meaning assessment of this version; null when the node is not checked. */
  meaning: MeaningAssessment | null;
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
  const m = input.meaning;
  const lengthRatio = inWords > 0 ? outWords / inWords : 0;

  const meaning = m ? meaningScore(m) : 1;
  const readability = outWords > 0 ? readabilityScore(gradeGap) : 0;
  const total =
    WEIGHTS.meaning * meaning +
    WEIGHTS.readability * readability +
    WEIGHTS.length * lengthScore(lengthRatio);

  return {
    gradeGap,
    similarity: m?.similarity ?? null,
    entityRecall: m?.entityRecall ?? 1,
    lengthRatio,
    minEntailment: m?.minEntailment ?? null,
    maxContradiction: m?.maxContradiction ?? null,
    passed: m?.passed ?? true,
    total,
  };
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
    const bestPasses = candidatePasses(best);
    const cPasses = candidatePasses(c);
    if (cPasses !== bestPasses) {
      if (cPasses) best = c;
      continue;
    }
    if (c.scores.total > best.scores.total) best = c;
  }
  return best;
}
