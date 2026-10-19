/**
 * Run logs and the downloadable run report (pipeline stage 7).
 *
 * Design decisions:
 *  - The run loop (lib/run/simplify.ts) records every node and every model
 *    candidate with its scores in a RunLog and stores it on the document
 *    (ClarityDocument.runLogs), so it is cleared and evicted with the document
 *    and reaches Reading through the usual doc:<id> change listener.
 *  - Only the last MAX_RUN_LOGS runs are kept. An "Extra quality" OFF run and
 *    an ON run of the same document therefore land in one report, which is
 *    the A/B evidence.
 *  - Pure with type-only imports, so Reading can import it without pulling
 *    the metrics engine or compromise into the main chunk.
 *  - parseRunReport reads formats 3 and 4 (format 4 only adds fields), so
 *    older downloaded reports stay usable by the scripts
 *    (scripts/meaning-breakdown.mjs).
 */

import type { ClarityDocument, RunLog } from '../../types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Runs kept per document. */
export const MAX_RUN_LOGS = 5;

/**
 * Format tag of the downloaded JSON, bumped on breaking changes. 2: the
 * thesis meaning standard (per-node meaningStatus and meaning, candidate NLI
 * fields, summary.meaning, meaningThresholds; node.similarity removed).
 * 3: failure kinds (`failures` per candidate and kept version,
 * summary.meaning.failureBreakdown) and replay data (candidate `text`, node
 * `originalText`, NLI rank/score ms), so a report can be re-judged offline
 * (scripts/meaning-breakdown.mjs).
 */
export const RUN_REPORT_FORMAT = 'clarity-run-report/4';

/**
 * 4 adds, per node, `fkglBefore` / `fkglAfter` and `modelInput` (text after
 * clutter removal); per candidate, `echoStripped`; per run, `appVersion`,
 * `gitCommit`, `ollamaVersion` and the Lite counts in summary.meaning
 * (`liteChecked`, `liteFailed`, `liteFailureBreakdown`); per report,
 * `fieldNotes` explaining fields whose meaning isn't obvious.
 */
export const READABLE_RUN_REPORT_FORMATS = ['clarity-run-report/3', 'clarity-run-report/4'] as const;

export type RunReportFormat = typeof READABLE_RUN_REPORT_FORMATS[number];

/** What the less obvious fields of a report mean; written into every format-4 report. */
export const RUN_REPORT_FIELD_NOTES = {
  gradeGap:
    'Per candidate: estimated grade of the version (lib/metrics/node-grade.ts) minus the target grade. ' +
    'Negative = simpler than the target, positive = harder (lib/quality/score.ts readability part).',
  fkglBefore: 'Per node: Flesch-Kincaid grade of the text the model got (modelInput, else originalText).',
  fkglAfter: 'Per node: Flesch-Kincaid grade of the kept version as plain text; null when the node failed.',
  modelInput: 'Per node, when present: the text the model and the meaning check got, after removing citation markers and hatnotes.',
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunReport {
  format: RunReportFormat;
  /** Format 4 and later. */
  fieldNotes?: typeof RUN_REPORT_FIELD_NOTES;
  exportedAt: string;
  docId: string;
  title: string;
  source: ClarityDocument['source'];
  sourceUrl?: string;
  fileName?: string;
  runs: RunLog[];
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

/** `previous` plus `log`, keeping the newest MAX_RUN_LOGS (oldest first). */
export function appendRunLog(previous: RunLog[] | undefined, log: RunLog): RunLog[] {
  return [...(previous ?? []), log].slice(-MAX_RUN_LOGS);
}

// ─── Report ───────────────────────────────────────────────────────────────────

export function buildRunReport(doc: ClarityDocument, now: Date = new Date()): RunReport {
  return {
    format: RUN_REPORT_FORMAT,
    fieldNotes: RUN_REPORT_FIELD_NOTES,
    exportedAt: now.toISOString(),
    docId: doc.id,
    title: doc.title,
    source: doc.source,
    ...(doc.sourceUrl !== undefined && { sourceUrl: doc.sourceUrl }),
    ...(doc.fileName !== undefined && { fileName: doc.fileName }),
    runs: doc.runLogs ?? [],
  };
}

/**
 * A downloaded report (parsed JSON) of a readable format; throws for any
 * other format or a shape without runs.
 */
export function parseRunReport(raw: unknown): RunReport {
  const r = raw as Partial<RunReport> | null;
  const format = r?.format;
  if (!format || !(READABLE_RUN_REPORT_FORMATS as readonly string[]).includes(format)) {
    throw new Error(`[Clarity] Unsupported run report format: ${String(format)}`);
  }
  if (!Array.isArray(r.runs)) throw new Error('[Clarity] Run report has no runs');
  return r as RunReport;
}

/** e.g. "clarity-run-report-my-article-2026-10-15.json". */
export function runReportFileName(doc: ClarityDocument, now: Date = new Date()): string {
  const slug = doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const date = now.toISOString().slice(0, 10);
  return `clarity-run-report-${slug || 'document'}-${date}.json`;
}
