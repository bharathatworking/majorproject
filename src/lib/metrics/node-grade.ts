/**
 * Per-node grade estimate, used to skip nodes that are already easy enough.
 *
 * Design decisions:
 *  - Reuses the document metrics engine (the average of five grade formulas),
 *    so a node is judged on the same scale as the document report and the
 *    target grade.
 *  - "Already simple" means at or below the target grade. Short texts with
 *    long words (e.g. a one-word heading like "Photosynthesis") score high
 *    and still go to the model, which is the safe direction.
 *  - Imports the common word list via engine.ts, so like the rest of
 *    lib/metrics it must never be imported from the background or content
 *    scripts.
 */

import { computeReadabilityReport } from './engine';

// ─── Estimate ─────────────────────────────────────────────────────────────────

/** Estimated grade level of one node's text. */
export function estimateNodeGrade(text: string, wordSet: Set<string>): number {
  return computeReadabilityReport(text, wordSet).estimatedGradeLevel;
}

/** True when the text already reads at or below `targetGrade`. */
export function isAlreadySimple(text: string, targetGrade: number, wordSet: Set<string>): boolean {
  return estimateNodeGrade(text, wordSet) <= targetGrade;
}
