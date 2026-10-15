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
export const RUN_REPORT_FORMAT = 'clarity-run-report/3';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunReport {
  format: typeof RUN_REPORT_FORMAT;
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
    exportedAt: now.toISOString(),
    docId: doc.id,
    title: doc.title,
    source: doc.source,
    ...(doc.sourceUrl !== undefined && { sourceUrl: doc.sourceUrl }),
    ...(doc.fileName !== undefined && { fileName: doc.fileName }),
    runs: doc.runLogs ?? [],
  };
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
