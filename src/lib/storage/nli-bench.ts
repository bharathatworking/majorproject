/**
 * NLI speed benchmark and device override in chrome.storage.local.
 *
 * Design decisions:
 *  - `nli:bench` (NliBenchRecord) is per machine, so it lives in local, not
 *    sync: a laptop with an NVIDIA GPU and one without must not share it.
 *    lib/quality/nli.ts prepareNli writes it; the run's Auto quality mode and
 *    the Settings page read it (lib/quality/mode.ts).
 *  - `debug:nliDevice` = 'wasm' forces the wasm backend and ignores the
 *    WebGPU adapter (Auto may pick Lite), so one machine can be
 *    measured as a machine without a GPU. 'webgpu' runs q8 on the WebGPU EP,
 *    the path before 2026-10-29 (eval/checker/NLI_PERF.md: before vs after on
 *    one build). 'webgpu-fp16' runs WebGPU with the fp16
 *    weights (experiment; needs npm run fetch-models -- --fp16) and installs
 *    clarityNliExperiment() in the app tab (lib/quality/nli-experiment.ts).
 *    Set it from DevTools in the app tab, e.g.
 *    chrome.storage.local.set({ 'debug:nliDevice': 'wasm' }), and reload the
 *    tab; remove it to go back to q8 on threaded wasm. Anything else is 'auto'.
 */

import type { NliBenchRecord, NliDevice } from '../../types';

// ─── Keys ─────────────────────────────────────────────────────────────────────

const BENCH_KEY = 'nli:bench';
const DEVICE_KEY = 'debug:nliDevice';

// ─── Benchmark ────────────────────────────────────────────────────────────────

export async function getNliBench(): Promise<NliBenchRecord | null> {
  const data = await chrome.storage.local.get<{ [BENCH_KEY]?: NliBenchRecord }>(BENCH_KEY);
  return data[BENCH_KEY] ?? null;
}

export async function saveNliBench(record: NliBenchRecord): Promise<void> {
  await chrome.storage.local.set({ [BENCH_KEY]: record });
}

// ─── Device override and version ──────────────────────────────────────────────

const DEBUG_DEVICES: readonly NliDevice[] = ['wasm', 'webgpu', 'webgpu-fp16'];

/** The debug override ('wasm', 'webgpu' or 'webgpu-fp16') when set, else 'auto' (q8 on threaded wasm). */
export async function getNliDevice(): Promise<NliDevice> {
  const data = await chrome.storage.local.get<{ [DEVICE_KEY]?: unknown }>(DEVICE_KEY);
  const value = data[DEVICE_KEY];
  return DEBUG_DEVICES.find(d => d === value) ?? 'auto';
}

/** The running extension's version; 'dev' where the manifest is not available (tests). */
export function extensionVersion(): string {
  return globalThis.chrome?.runtime?.getManifest?.().version ?? 'dev';
}
