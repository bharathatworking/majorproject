/**
 * Quality mode: Full (SBERT + entities + sentence-level NLI, retries and
 * "Extra quality" best-of-N) or Lite (SBERT + entities, at most one retry,
 * no best-of-N). The setting is 'auto', 'full' or 'lite' (chrome.storage.sync
 * `qualityMode`, default 'auto').
 *
 * Design decisions:
 *  - Auto measures instead of guessing from hardware: when the NLI model
 *    first loads, a realistic paragraph is timed (lib/quality/nli.ts
 *    prepareNli: NLI_BENCH_PARAGRAPH, ~150 words and 6 simplified sentences,
 *    the 18 pairs the check would score for it, in the backend's batch
 *    size) and stored as `nli:bench`. The old 8 short pairs, multiplied up,
 *    predicted 1256 ms per paragraph where real runs measured 4875 ms (UK
 *    run, WebGPU). Auto picks Lite only when there
 *    is no WebGPU AND that benchmark predicts more than
 *    AUTO_LITE_PARAGRAPH_MS of NLI per paragraph; otherwise Full. Without a
 *    benchmark (NLI model not loadable) it picks Full, and the run's NLI
 *    fallback then applies as before.
 *  - The benchmark is re-run when the extension version, the page's WebGPU
 *    adapter, the requested NLI device or the benchmark format changes
 *    (isBenchStale), so a stored result from another setup never decides.
 *  - Lite results are stored with nliChecked: false, so the existing thesis
 *    coverage rule keeps them out of the pass rate.
 *  - Pure apart from hasWebGpuAdapter, and import-light (config + types), so
 *    Settings can show the current choice without loading the NLI chunk.
 *  - hasWebGpuAdapter asks once per app tab and reuses the answer (module
 *    state is fine on an extension page): adapters don't come and go during
 *    a session, and each request costs time. It passes no powerPreference,
 *    which Chrome ignores on Windows (crbug 369219127) and warns about on
 *    the Errors page; the GPU is chosen in the Windows Graphics settings.
 */

import { AUTO_LITE_PARAGRAPH_MS, NLI_TOP_PREMISES, NLI_TYPICAL_SENTENCES } from './config';
import type { NliBenchRecord, NliDevice, QualityMode, QualityModeSetting } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Pairs in the speed benchmark: NLI_TOP_PREMISES per sentence of the benchmark paragraph. */
export const BENCH_PAIRS = NLI_TOP_PREMISES * NLI_TYPICAL_SENTENCES;

/**
 * Format of NliBenchRecord; 2 = the realistic paragraph, 3 = q8 on threaded
 * wasm (2026-10-29). Older records are stale.
 */
export const BENCH_FORMAT = 3;

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
 * NLI ms per typical paragraph: the benchmark already scores a typical
 * paragraph (BENCH_PAIRS pairs), so it is the measured time itself.
 */
export function predictParagraphMs(benchMs: number): number {
  return benchMs;
}

/** True when `stored` was measured on another version, adapter state, device or benchmark format. */
export function isBenchStale(stored: NliBenchRecord, ctx: BenchContext): boolean {
  return (stored.benchFormat ?? 1) !== BENCH_FORMAT
    || stored.version !== ctx.version
    || stored.webgpuAdapter !== ctx.webgpuAdapter
    || stored.device !== ctx.device;
}

/**
 * Speed evidence of a stored benchmark. `webgpu` means the machine has a
 * WebGPU adapter (the model itself runs on threaded wasm since 2026-10-29),
 * unless the benchmark was forced to wasm (debug:nliDevice = 'wasm').
 */
export function evidenceOf(bench: NliBenchRecord): SpeedEvidence {
  const webgpu = bench.backend === 'webgpu' || (bench.webgpuAdapter && bench.device !== 'wasm');
  return { webgpu, benchMs: bench.ms, predictedParagraphMs: bench.predictedParagraphMs };
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
  requestAdapter(): Promise<unknown>;
}

let adapterCheck: Promise<boolean> | null = null;

async function checkAdapter(): Promise<boolean> {
  const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

/** True when this page can get a WebGPU adapter; asked once per session, never throws. */
export function hasWebGpuAdapter(): Promise<boolean> {
  adapterCheck ??= checkAdapter();
  return adapterCheck;
}

/** Forgets the session's adapter answer (tests). */
export function resetWebGpuAdapterCache(): void {
  adapterCheck = null;
}
