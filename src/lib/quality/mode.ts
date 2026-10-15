/**
 * Quality mode: Full (SBERT + entities + sentence-level NLI, retries and
 * "Extra quality" best-of-N) or Lite (SBERT + entities, at most one retry,
 * no best-of-N). The setting is 'auto', 'full' or 'lite' (chrome.storage.sync
 * `qualityMode`, default 'auto').
 *
 * Design decisions:
 *  - Auto measures instead of guessing from hardware: when the NLI model
 *    first loads, 8 fixed sentence pairs are timed (lib/quality/nli.ts
 *    prepareNli) and stored as `nli:bench`. Auto picks Lite only when there
 *    is no WebGPU AND that benchmark predicts more than
 *    AUTO_LITE_PARAGRAPH_MS of NLI per paragraph; otherwise Full. Without a
 *    benchmark (NLI model not loadable) it picks Full, and the run's NLI
 *    fallback then applies as before.
 *  - The benchmark is re-run when the extension version, the page's WebGPU
 *    adapter or the requested NLI device changes (isBenchStale), so a stored
 *    result from another setup never decides.
 *  - Lite results are stored with nliChecked: false, so the existing thesis
 *    coverage rule keeps them out of the pass rate.
 *  - Pure apart from hasWebGpuAdapter, and import-light (config + types), so
 *    Settings can show the current choice without loading the NLI chunk.
 */

import { AUTO_LITE_PARAGRAPH_MS, NLI_TOP_PREMISES, NLI_TYPICAL_SENTENCES } from './config';
import type { NliBenchRecord, NliDevice, QualityMode, QualityModeSetting } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Pairs in the speed benchmark (lib/quality/nli.ts NLI_BENCH_PAIRS). */
export const BENCH_PAIRS = 8;

export interface QualityDecision {
  mode: QualityMode;
  /** Plain explanation for the log and the run report. */
  reason: string;
}

/** What the run knows about this machine's NLI speed; null when not measured. */
export interface SpeedEvidence {
  webgpu: boolean;
  benchMs: number;
  predictedParagraphMs: number;
}

/** The setup a stored benchmark must match. */
export interface BenchContext {
  version: string;
  webgpuAdapter: boolean;
  device: NliDevice;
}

// ─── Prediction ───────────────────────────────────────────────────────────────

/**
 * NLI ms per typical paragraph from one benchmark batch: the per-pair time
 * times NLI_TOP_PREMISES pairs per sentence times NLI_TYPICAL_SENTENCES.
 */
export function predictParagraphMs(benchMs: number): number {
  return (benchMs / BENCH_PAIRS) * NLI_TOP_PREMISES * NLI_TYPICAL_SENTENCES;
}

/** True when `stored` was measured on another version, adapter state or device. */
export function isBenchStale(stored: NliBenchRecord, ctx: BenchContext): boolean {
  return stored.version !== ctx.version
    || stored.webgpuAdapter !== ctx.webgpuAdapter
    || stored.device !== ctx.device;
}

/** Speed evidence of a stored benchmark. */
export function evidenceOf(bench: NliBenchRecord): SpeedEvidence {
  return { webgpu: bench.backend === 'webgpu', benchMs: bench.ms, predictedParagraphMs: bench.predictedParagraphMs };
}

// ─── Decision ─────────────────────────────────────────────────────────────────

/** The mode a run uses (rules in the file header). */
export function chooseQualityMode(setting: QualityModeSetting, evidence: SpeedEvidence | null): QualityDecision {
  if (setting === 'full') return { mode: 'full', reason: 'set to Full' };
  if (setting === 'lite') return { mode: 'lite', reason: 'set to Lite' };
  if (evidence === null) return { mode: 'full', reason: 'auto: NLI speed not measured (model unavailable)' };

  const measured =
    `benchmark ${Math.round(evidence.benchMs)} ms/${BENCH_PAIRS} pairs → ` +
    `${Math.round(evidence.predictedParagraphMs)} ms per paragraph`;
  if (evidence.webgpu) return { mode: 'full', reason: `auto: WebGPU, ${measured}` };
  if (evidence.predictedParagraphMs > AUTO_LITE_PARAGRAPH_MS) {
    return { mode: 'lite', reason: `auto: no WebGPU, ${measured} > ${AUTO_LITE_PARAGRAPH_MS}` };
  }
  return { mode: 'full', reason: `auto: no WebGPU, ${measured} ≤ ${AUTO_LITE_PARAGRAPH_MS}` };
}

// ─── WebGPU ───────────────────────────────────────────────────────────────────

/** The part of navigator.gpu used here (tsconfig has no WebGPU types). */
interface GpuLike {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<unknown>;
}

/** True when this page can get a WebGPU adapter; never throws. */
export async function hasWebGpuAdapter(): Promise<boolean> {
  const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter({ powerPreference: 'high-performance' })) != null;
  } catch {
    return false;
  }
}
