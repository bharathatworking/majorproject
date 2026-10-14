/**
 * Shared test fixtures: minimal valid domain objects with overridable fields.
 */

import type { ClarityDocument, ReadabilityReport } from '../../src/types';

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
