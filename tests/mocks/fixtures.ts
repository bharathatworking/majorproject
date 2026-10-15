/**
 * Shared test fixtures: minimal valid domain objects with overridable fields.
 */

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
    exemptedSentences: [],
    exemptionRate: 0,
    nliMs: 120,
    nliSentences: 2,
    ...overrides,
  };
}

/** An NLI result where every sentence is supported. */
export function makeEntailment(overrides: Partial<EntailmentCheck> = {}): EntailmentCheck {
  return {
    minEntailment: 0.95,
    maxContradiction: 0.02,
    unsupportedSentences: [],
    contradictedSentences: [],
    exemptedSentences: [],
    exemptionRate: 0,
    sentences: 2,
    cachedPairs: 0,
    ms: 100,
    ...overrides,
  };
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
