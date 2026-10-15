/**
 * Run timing summary for performance reporting.
 *
 * Pure: the run loop (lib/run/simplify.ts) measures with performance.now()
 * and passes the per-node entries here; this module only counts, averages
 * and formats. "Per model node" is the figure to compare across models, since
 * cache hits and skipped nodes take milliseconds.
 */

import type { NodeSource } from '../../types';

// NodeSource lives in types (the run log uses it); re-exported for callers
export type { NodeSource };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NodeTiming {
  nodeId: string;
  source: NodeSource;
  ms: number;
}

export interface RunSummary {
  nodes: number;
  counts: Record<NodeSource, number>;
  totalSeconds: number;
  /** Total time divided by every node processed; null when none were. */
  secondsPerNode: number | null;
  /** Mean time of model-generated nodes only; null when the model ran for none. */
  secondsPerModelNode: number | null;
  line: string;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const fmt = (seconds: number | null) => (seconds === null ? 'n/a' : `${seconds.toFixed(2)} s`);

/** Seconds as text with two decimals, e.g. "2.31 s". */
export function formatSeconds(ms: number): string {
  return fmt(ms / 1000);
}

export function summarizeRun(entries: NodeTiming[], totalMs: number): RunSummary {
  const counts: Record<NodeSource, number> = { model: 0, cache: 0, skipped: 0, error: 0 };
  let modelMs = 0;
  for (const e of entries) {
    counts[e.source]++;
    if (e.source === 'model') modelMs += e.ms;
  }

  const totalSeconds = totalMs / 1000;
  const secondsPerNode = entries.length > 0 ? totalSeconds / entries.length : null;
  const secondsPerModelNode = counts.model > 0 ? modelMs / 1000 / counts.model : null;

  const line =
    `${entries.length} nodes in ${fmt(totalSeconds)} — ` +
    `${counts.model} model, ${counts.cache} cache, ${counts.skipped} skipped, ${counts.error} errors; ` +
    `${fmt(secondsPerModelNode)}/model node, ${fmt(secondsPerNode)}/node`;

  return { nodes: entries.length, counts, totalSeconds, secondsPerNode, secondsPerModelNode, line };
}
