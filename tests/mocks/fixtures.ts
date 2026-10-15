/**
 * Shared test fixtures: minimal valid domain objects with overridable fields.
 */

import { CONTRADICTION_MAX, ENTAILMENT_MIN } from '../../src/lib/quality/config';
import type {
  ClarityDocument, EntailmentCheck, MeaningAssessment, ReadabilityReport, RunMeaningSummary,
} from '../../src/types';

// ─── Meaning ──────────────────────────────────────────────────────────────────

/** A fully checked, passing assessment. */
export function makeAssessment(overrides: Partial<MeaningAssessment> = {}): MeaningAssessment {
  return {
    similarity: 0.92,
    entityRecall: 1,
    missingEntities: [],
    minEntailment: 0.95,
    maxContradiction: 0.02,
    nliChecked: true,
    fullyChecked: true,
    passed: true,
    reasons: [],
    failures: [],
    exemptedSentences: [],
    exemptionRate: 0,
    nliMs: 120,
    nliRankMs: 20,
    nliScoreMs: 100,
    nliSentences: 2,
    ...overrides,
  };
}

/**
 * An NLI result where every sentence is supported. Without an explicit
 * `passed`, it passes when no sentence is listed as unsupported or
 * contradicted and both extremes are within the config limits (rule A).
 */
export function makeEntailment(overrides: Partial<EntailmentCheck> = {}): EntailmentCheck {
  const base: Omit<EntailmentCheck, 'passed'> = {
    sentenceScores: [],
    toleratedSentences: [],
    minEntailment: 0.95,
    maxContradiction: 0.02,
    unsupportedSentences: [],
    contradictedSentences: [],
    exemptedSentences: [],
    exemptionRate: 0,
    sentences: 2,
    cachedPairs: 0,
    pairs: 2,
    truncatedPairs: 0,
    ranking: 'all',
    rankMs: 0,
    scoreMs: 100,
    ms: 100,
    ...overrides,
  };
  const passed = overrides.passed ?? (
    base.sentences > 0 &&
    base.unsupportedSentences.length === 0 && base.contradictedSentences.length === 0 &&
    base.minEntailment >= ENTAILMENT_MIN && base.maxContradiction <= CONTRADICTION_MAX
  );
  return { ...base, passed };
}

/** An empty run meaning summary. */
export function makeRunMeaningSummary(overrides: Partial<RunMeaningSummary> = {}): RunMeaningSummary {
  return {
    passed: 0, failed: 0, notFullyChecked: 0, excluded: 0, passRate: null, coverage: null,
    thesisGrade: false, avgNliMs: null, exemptedSentences: 0, exemptionRate: null,
    ...overrides,
  };
}

// ─── Readability report ───────────────────────────────────────────────────────

export function makeReport(overrides: Partial<ReadabilityReport> = {}): ReadabilityReport {
  return {
    fleschReadingEase: 40,
    fleschKincaidGradeLevel: 12,
    gunningFogIndex: 14,
    smogIndex: 12,
    colemanLiauIndex: 12,
    automatedReadabilityIndex: 12,
    daleChallScore: 9,
    avgSentenceLength: 22,
    avgWordLength: 5,
    complexWordPercent: 15,
    longSentencePercent: 30,
    typeTokenRatio: 0.6,
    jargonDensity: 10,
    estimatedGradeLevel: 12,
    ...overrides,
  };
}

// ─── Document input ───────────────────────────────────────────────────────────

/** Input shape accepted by upsertDocument. */
export type DocInput = Omit<ClarityDocument, 'id' | 'createdAt' | 'updatedAt' | 'results' | 'simplifiedReport'>;

export function makeDocInput(hash: string, overrides: Partial<DocInput> = {}): DocInput {
  return {
    source: 'paste',
    title: `Doc ${hash}`,
    contentHash: hash,
    html: '<p>Some text.</p>',
    textContent: 'Some text.',
    report: null,
    ...overrides,
  };
}
