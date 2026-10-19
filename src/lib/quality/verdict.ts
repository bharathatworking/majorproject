/**
 * The NLI paragraph rule and the failure kinds of the meaning standard, as
 * pure functions shared by the extension (lib/quality/nli.ts, meaning.ts) and
 * the calibration scripts (scripts/calibrate-meaning.mjs), so the thresholds
 * a script chooses are judged by exactly the rule the app runs.
 *
 * Design decisions:
 *  - The thresholds are parameters (defaults from config.ts), so calibration
 *    can sweep them over stored sentence scores without re-running the model.
 *  - Rule 'A': every non-exempt sentence has entailment ≥ entailmentMin.
 *    Rule 'B': the same, but one neutral sentence (unsupported and not
 *    contradicted) is tolerated when the output has neutralMinSentences or
 *    more sentences. Under both, any sentence (exempt or not) above
 *    contradictionMax fails the paragraph, and an output with no sentences
 *    fails.
 *  - Import-light (config + types), so UI chunks may use it.
 */

import {
  CONTRADICTION_MAX, ENTAILMENT_MIN, ENTITY_RECALL_MIN, NLI_NEUTRAL_MIN_SENTENCES, NLI_PARAGRAPH_RULE,
} from './config';
import type { FailureBreakdown, MeaningFailure, NliParagraphRule, SentenceScore } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NliThresholds {
  entailmentMin: number;
  contradictionMax: number;
  rule: NliParagraphRule;
  neutralMinSentences: number;
}

export const DEFAULT_NLI_THRESHOLDS: NliThresholds = {
  entailmentMin: ENTAILMENT_MIN,
  contradictionMax: CONTRADICTION_MAX,
  rule: NLI_PARAGRAPH_RULE,
  neutralMinSentences: NLI_NEUTRAL_MIN_SENTENCES,
};

export interface NliVerdict {
  passed: boolean;
  /** Non-exempt sentences below entailmentMin that the rule did not tolerate. */
  unsupported: string[];
  /** Sentences above contradictionMax. */
  contradicted: string[];
  /** Neutral sentences rule B tolerated. */
  tolerated: string[];
}

/** Every MeaningFailure, in the order reports list them. */
export const MEANING_FAILURES: readonly MeaningFailure[] = ['similarity', 'entities', 'unsupported', 'contradiction', 'echo'];

// ─── NLI rule ─────────────────────────────────────────────────────────────────

/** The paragraph verdict of a version's sentence scores (rules in the file header). */
export function nliVerdict(
  scores: readonly SentenceScore[],
  thresholds: Partial<NliThresholds> = {},
): NliVerdict {
  const t = { ...DEFAULT_NLI_THRESHOLDS, ...thresholds };
  const contradicted = scores.filter(s => s.contradiction > t.contradictionMax).map(s => s.sentence);
  const contradictedSet = new Set(contradicted);
  const below = scores.filter(s => !s.exempt && s.entailment < t.entailmentMin).map(s => s.sentence);
  const neutral = below.filter(s => !contradictedSet.has(s));

  const tolerate = t.rule === 'B' && scores.length >= t.neutralMinSentences && neutral.length === 1;
  const tolerated = tolerate ? neutral : [];
  const unsupported = tolerate ? below.filter(s => contradictedSet.has(s)) : below;

  return {
    passed: scores.length > 0 && contradicted.length === 0 && unsupported.length === 0,
    unsupported,
    contradicted,
    tolerated,
  };
}

// ─── Entity rule ──────────────────────────────────────────────────────────────

export interface EntityVerdict {
  passed: boolean;
  /** Share of the original's distinct entity texts still present (1 when it has none). */
  recall: number;
  /** Dropped key entities (numbers, dates, time zones of the main claim), in order. */
  missingKey: string[];
  /** Dropped other entities, in order. */
  missingMinor: string[];
}

/**
 * The entity rule: passes when no key entity is missing and the share of
 * entities kept is at least `recallMin` (ENTITY_RECALL_MIN). Key entities are
 * the numbers, dates and time zones of the original's main claim (meaning.ts
 * keyEntityTexts); names and the other numbers may drop within the share.
 */
export function entityVerdict(args: {
  entityTexts: readonly string[];
  missing: readonly string[];
  keyTexts: readonly string[];
  recallMin?: number;
}): EntityVerdict {
  const recallMin = args.recallMin ?? ENTITY_RECALL_MIN;
  const distinct = new Set(args.entityTexts).size;
  const recall = distinct > 0 ? (distinct - new Set(args.missing).size) / distinct : 1;
  const key = new Set(args.keyTexts);
  const missingKey = args.missing.filter(t => key.has(t));
  const missingMinor = args.missing.filter(t => !key.has(t));
  return { passed: missingKey.length === 0 && recall >= recallMin - 1e-9, recall, missingKey, missingMinor };
}

// ─── Failure breakdown ────────────────────────────────────────────────────────

/** Counts failure kinds over the failure lists of failed versions. */
export function failureBreakdown(failureLists: readonly (readonly MeaningFailure[])[]): FailureBreakdown {
  const counts: FailureBreakdown = { similarity: 0, entities: 0, unsupported: 0, contradiction: 0, echo: 0, failedParagraphs: 0 };
  for (const list of failureLists) {
    if (list.length === 0) continue;
    counts.failedParagraphs++;
    for (const kind of new Set(list)) counts[kind]++;
  }
  return counts;
}

/**
 * "similarity 4, entities 5, unsupported 5, contradiction 0, echo 0 (of 9
 * failed)"; a kind missing from an older log counts 0.
 */
export function formatFailureBreakdown(b: FailureBreakdown): string {
  return `${MEANING_FAILURES.map(k => `${k} ${b[k] ?? 0}`).join(', ')} (of ${b.failedParagraphs} failed)`;
}

/**
 * Failure kinds of a stored or logged version from its reason strings, for
 * run reports written before `failures` existed (clarity-run-report/2).
 */
export function failuresFromReasons(reasons: readonly string[]): MeaningFailure[] {
  const kinds = new Set<MeaningFailure>();
  for (const r of reasons) {
    if (r.startsWith('You dropped')) kinds.add('entities');
    else if (r.startsWith('This sentence contradicts')) kinds.add('contradiction');
    else if (r.startsWith('This sentence is not supported') || r.startsWith('The simplified version has no sentences')) kinds.add('unsupported');
    else if (r.startsWith('The meaning drifted')) kinds.add('similarity');
    else if (r.startsWith('Your version has a line that only lists') || r.startsWith('Your version repeats the instructions')) kinds.add('echo');
  }
  return MEANING_FAILURES.filter(k => kinds.has(k));
}
