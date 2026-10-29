/**
 * Premises for the sentence-level NLI check (thesis standard, stage 6C):
 * which parts of the original each simplified sentence is scored against,
 * and how the per-premise scores become one verdict per sentence.
 *
 * Design decisions:
 *  - SummaC zero-shot strategy (Laban, Schnabel, Bennett & Hearst, 2022,
 *    "SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in
 *    Summarization", TACL 10, 163–177): an NLI model trained on sentence
 *    pairs judges a short hypothesis badly against a whole paragraph, so the
 *    premises are the original's sentences, plus every window of 2 adjacent
 *    sentences (a simplified sentence often merges two). Entailment of a
 *    sentence is the max over its premises: it is supported if any part of
 *    the original supports it.
 *  - Contradiction is the max over the scored premises ('max'), or the
 *    contradiction of the best-entailing premise ('best-entailing'), set by
 *    NLI_CONTRADICTION_AGG in config.ts. 'max' is stricter; the calibration
 *    set (npm run calibrate-nli) shows whether it raises false contradictions.
 *  - Pruning: only the NLI_TOP_PREMISES premises most similar to a sentence
 *    are scored, ranked by all-minilm cosine (the embedding model the
 *    similarity check already uses), or by word overlap when that model is
 *    missing. Fewer, shorter pairs is where the speed-up comes from.
 *  - Pure (config and types only), so the Node calibration script runs the
 *    same code as the extension.
 */

import { toPlainText } from '../render/format-output';
import { splitSentenceText } from '../utils/sentences';
import { cosineSimilarity } from './similarity';
import { NLI_TOP_PREMISES } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The two NLI probabilities the verdict needs. */
export interface PairProbs {
  entailment: number;
  contradiction: number;
}

export type ContradictionAggregation = 'max' | 'best-entailing';

/** One sentence's verdict over its premises. */
export interface SentenceVerdict {
  entailment: number;
  contradiction: number;
  /** Index (into the probs passed to aggregate) of the best-entailing premise. */
  best: number;
}

/** Recorded with every run: how premises are built and pruned. */
export const PREMISE_STRATEGY = `summac-sentences+pairs/top${NLI_TOP_PREMISES}`;

// ─── Sentences ────────────────────────────────────────────────────────────────

/**
 * Sentences of a (possibly bulleted) text: marker-free text split at line
 * breaks and by splitSentenceText (lib/utils/sentences.ts: never inside
 * "10.2%", after "No." before a number, or at a mid-sentence "..."). Trimmed,
 * empty pieces dropped. Used for the hypotheses (model output) and the
 * premises and main claim (original).
 */
export function splitSentences(text: string): string[] {
  return toPlainText(text)
    .split(/\n+/)
    .flatMap(line => splitSentenceText(line));
}

/**
 * The main claim of an original (indexes into its sentences): every sentence
 * when there are at most 2, else the one whose embedding is closest to the
 * whole paragraph's (ties: the first). Without vectors, the first sentence.
 */
export function mainClaimIndexes(
  sentenceCount: number,
  vectors: { sentences: readonly number[][]; paragraph: readonly number[] } | null = null,
): number[] {
  if (sentenceCount <= 2) return Array.from({ length: sentenceCount }, (_, i) => i);
  if (!vectors || vectors.sentences.length !== sentenceCount) return [0];
  const scores = vectors.sentences.map(v => cosineSimilarity([...v], [...vectors.paragraph]));
  let best = 0;
  scores.forEach((s, i) => { if (s > scores[best]) best = i; });
  return [best];
}

// ─── Premises ─────────────────────────────────────────────────────────────────

/**
 * Every original sentence, then every window of 2 adjacent sentences
 * ("s0 s1", "s1 s2", …). A 1-sentence original gives just that sentence.
 */
export function buildPremises(originalSentences: readonly string[]): string[] {
  const sentences = originalSentences.map(s => s.trim()).filter(s => s !== '');
  const windows = sentences.slice(1).map((s, i) => `${sentences[i]} ${s}`);
  return [...sentences, ...windows];
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

/** Indexes of the k highest scores, best first; ties keep the lower index. */
function topK(scores: readonly number[], k: number): number[] {
  return scores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k)
    .map(x => x.i);
}

/** Per hypothesis, the k premises with the highest embedding cosine. */
export function rankPremises(
  premiseVecs: readonly number[][],
  hypothesisVecs: readonly number[][],
  k = NLI_TOP_PREMISES,
): number[][] {
  return hypothesisVecs.map(h => topK(premiseVecs.map(p => cosineSimilarity(p, h)), k));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'has', 'have', 'had', 'its', 'it', 'is', 'of', 'to',
  'in', 'on', 'at', 'by', 'an', 'a', 'or', 'as', 'be', 'this', 'that', 'with', 'from', 'they',
  'their', 'them', 'he', 'she', 'his', 'her', 'we', 'you', 'not', 'but', 'so', 'can', 'will',
]);

/** Lowercase content words and numbers of a text. */
function contentWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/(\d),(?=\d)/g, '$1').split(/[^a-z0-9]+/)
      .filter(w => w !== '' && !STOP_WORDS.has(w) && (w.length > 2 || /\d/.test(w))),
  );
}

/** Per hypothesis, the k premises sharing the most content words (cosine of word sets). */
export function lexicalRank(
  premises: readonly string[],
  hypotheses: readonly string[],
  k = NLI_TOP_PREMISES,
): number[][] {
  const premiseWords = premises.map(contentWords);
  return hypotheses.map(h => {
    const hw = contentWords(h);
    const scores = premiseWords.map(pw => {
      if (pw.size === 0 || hw.size === 0) return 0;
      let shared = 0;
      for (const w of hw) if (pw.has(w)) shared++;
      return shared / Math.sqrt(pw.size * hw.size);
    });
    return topK(scores, k);
  });
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * One sentence's verdict from the probabilities of its premises: entailment
 * is the max; contradiction is the max ('max') or the best-entailing
 * premise's ('best-entailing'). Throws on an empty list.
 */
export function aggregate(probs: readonly PairProbs[], mode: ContradictionAggregation): SentenceVerdict {
  if (probs.length === 0) throw new Error('aggregate needs at least one premise score');
  let best = 0;
  probs.forEach((p, i) => { if (p.entailment > probs[best].entailment) best = i; });
  const contradiction = mode === 'max'
    ? Math.max(...probs.map(p => p.contradiction))
    : probs[best].contradiction;
  return { entailment: probs[best].entailment, contradiction, best };
}
