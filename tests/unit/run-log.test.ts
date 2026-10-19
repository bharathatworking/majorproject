import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  appendRunLog, buildRunReport, parseRunReport, runReportFileName, MAX_RUN_LOGS, RUN_REPORT_FIELD_NOTES, RUN_REPORT_FORMAT,
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
      fieldNotes: RUN_REPORT_FIELD_NOTES,
      exportedAt: '2026-10-15T09:30:00.000Z',
      docId: 'doc-1',
      title: 'How Plants Make Food: A Guide!',
      source: 'page',
      sourceUrl: 'https://example.com/plants',
      runs: [log('a'), log('b')],
    });
  });

  it('is format 4, and explains gradeGap and the FKGL fields', () => {
    expect(RUN_REPORT_FORMAT).toBe('clarity-run-report/4');
    const notes = buildRunReport(doc(), now).fieldNotes;
    expect(notes?.gradeGap).toContain('minus the target grade');
    expect(notes?.gradeGap).toContain('Negative = simpler than the target');
    expect(Object.keys(notes ?? {})).toEqual(['gradeGap', 'fkglBefore', 'fkglAfter', 'modelInput']);
  });

  it('has an empty run list for a document without logs', () => {
    expect(buildRunReport(doc(), now).runs).toEqual([]);
  });

  it('names the file after the title and date', () => {
    expect(runReportFileName(doc(), now)).toBe('clarity-run-report-how-plants-make-food-a-guide-2026-10-15.json');
    expect(runReportFileName(doc({ title: '!!!' }), now)).toBe('clarity-run-report-document-2026-10-15.json');
  });
});

// ---------------------------------------------------------------------------
// parseRunReport — formats 3 and 4
// ---------------------------------------------------------------------------
describe('parseRunReport', () => {
  it('reads an old format-3 report (the UK fixture)', () => {
    const raw: unknown = JSON.parse(readFileSync('eval/fixtures/runs/uk-wiki-2026-10-19.json', 'utf8'));
    const report = parseRunReport(raw);
    expect(report.format).toBe('clarity-run-report/3');
    expect(report.runs).toHaveLength(5);
    expect(report.runs[0].nodes[0].fkglBefore).toBeUndefined();
  });

  it('reads a report it just built (format 4)', () => {
    const built = buildRunReport(doc({ runLogs: [log('a')] }));
    expect(parseRunReport(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it('rejects other formats and shapes', () => {
    expect(() => parseRunReport({ format: 'clarity-run-report/2', runs: [] })).toThrow(/Unsupported run report format/);
    expect(() => parseRunReport({ format: 'clarity-run-report/4' })).toThrow(/no runs/);
    expect(() => parseRunReport(null)).toThrow();
  });
});
