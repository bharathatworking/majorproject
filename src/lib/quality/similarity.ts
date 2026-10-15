/**
 * Meaning-check constants and arithmetic that need no NLP library.
 *
 * Split out of semantic.ts so the Reading page (badge threshold) and the
 * Progress page (average score) don't pull compromise into the main chunk.
 * semantic.ts re-exports everything here, so existing imports keep working.
 */

import type { StoredResult } from '../../types';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum cosine similarity (all-MiniLM-L6-v2) between original and simplified
 * text. Faithful plain-language rewrites of a paragraph typically score about
 * 0.85–0.95; dropped clauses, changed facts or drift into unrelated content
 * fall below about 0.8. Raising it causes more retries on legitimate
 * simplifications (heavy rewording lowers the score); lowering it lets real
 * meaning changes through.
 */
export const SIMILARITY_THRESHOLD = 0.80;

/** Nodes with fewer words than this skip both checks. */
export const MIN_WORDS_FOR_CHECK = 8;

// ─── Arithmetic ───────────────────────────────────────────────────────────────

/** Cosine similarity in [-1, 1]; 0 when either vector is all zeros. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Reporting ────────────────────────────────────────────────────────────────

/** Mean similarity of the done results that were checked; null when none were. */
export function averageSimilarity(results: StoredResult[]): number | null {
  const scores = results
    .filter(r => r.status === 'done' && r.similarity !== undefined)
    .map(r => r.similarity as number);
  if (scores.length === 0) return null;
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}
