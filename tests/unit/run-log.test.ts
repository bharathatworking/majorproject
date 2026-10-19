import { describe, it, expect } from 'vitest';
import {
  appendRunLog, buildRunReport, runReportFileName, MAX_RUN_LOGS, RUN_REPORT_FORMAT,
} from '../../src/lib/run/run-log';
import { makeRunMeaningSummary } from '../mocks/fixtures';
import type { ClarityDocument, RunLog } from '../../src/types';

function log(id: string): RunLog {
  return {
    id, startedAt: 1, finishedAt: 2, cancelled: false, mode: 'all', model: 'qwen2.5:3b',
    extraQuality: false, targetGrade: 6, depthTier: 'moderate', qualityThreshold: 0.75,
    weights: { meaning: 0.5, readability: 0.3, length: 0.2 },
    meaningThresholds: {
      similarity: 0.87, entailmentMin: 0.5, contradictionMax: 0.2, glossaryExemptionMaxRate: 0.3,
      nliModel: 'Xenova/nli-deberta-v3-xsmall',
    },
    summary: {
      nodes: 0, counts: { model: 0, cache: 0, heading: 0, skipped: 0, error: 0 }, totalSeconds: 0,
      secondsPerNode: null, secondsPerModelNode: null, firstResultSeconds: null,
      meaning: makeRunMeaningSummary(),
    },
    nodes: [],
  };
}

function doc(overrides: Partial<ClarityDocument> = {}): ClarityDocument {
  return {
    id: 'doc-1', source: 'page', title: 'How Plants Make Food: A Guide!', createdAt: 0, updatedAt: 0,
    contentHash: 'h', html: '', textContent: '', report: null, results: [], simplifiedReport: null,
    sourceUrl: 'https://example.com/plants', ...overrides,
  };
}

// ---------------------------------------------------------------------------
// appendRunLog — keeps the newest MAX_RUN_LOGS runs
// ---------------------------------------------------------------------------
describe('appendRunLog', () => {
  it('starts a list when there is none', () => {
    expect(appendRunLog(undefined, log('a')).map(l => l.id)).toEqual(['a']);
  });

  it(`keeps the newest ${MAX_RUN_LOGS}, oldest first`, () => {
    let logs: RunLog[] | undefined;
    for (const id of ['1', '2', '3', '4', '5', '6', '7']) logs = appendRunLog(logs, log(id));
    expect(logs?.map(l => l.id)).toEqual(['3', '4', '5', '6', '7']);
  });

  it('does not mutate the previous list', () => {
    const prev = [log('a')];
    appendRunLog(prev, log('b'));
    expect(prev).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildRunReport / runReportFileName
// ---------------------------------------------------------------------------
describe('buildRunReport', () => {
  const now = new Date('2026-10-15T09:30:00Z');

  it('wraps every stored run with document details', () => {
    const report = buildRunReport(doc({ runLogs: [log('a'), log('b')] }), now);
    expect(report).toEqual({
      format: RUN_REPORT_FORMAT,
      exportedAt: '2026-10-15T09:30:00.000Z',
      docId: 'doc-1',
      title: 'How Plants Make Food: A Guide!',
      source: 'page',
      sourceUrl: 'https://example.com/plants',
      runs: [log('a'), log('b')],
    });
  });

  it('is format 3 (failure kinds and replay data)', () => {
    expect(RUN_REPORT_FORMAT).toBe('clarity-run-report/3');
  });

  it('has an empty run list for a document without logs', () => {
    expect(buildRunReport(doc(), now).runs).toEqual([]);
  });

  it('names the file after the title and date', () => {
    expect(runReportFileName(doc(), now)).toBe('clarity-run-report-how-plants-make-food-a-guide-2026-10-15.json');
    expect(runReportFileName(doc({ title: '!!!' }), now)).toBe('clarity-run-report-document-2026-10-15.json');
  });
});
