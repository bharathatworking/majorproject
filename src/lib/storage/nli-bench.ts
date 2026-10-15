/**
 * NLI speed benchmark and device override in chrome.storage.local.
 *
 * Design decisions:
 *  - `nli:bench` (NliBenchRecord) is per machine, so it lives in local, not
 *    sync: a laptop with an NVIDIA GPU and one without must not share it.
 *    lib/quality/nli.ts prepareNli writes it; the run's Auto quality mode and
 *    the Settings page read it (lib/quality/mode.ts).
 *  - `debug:nliDevice` = 'wasm' forces the wasm backend, so one machine can
 *    be benchmarked on both backends. Set it from DevTools in the app tab:
 *    chrome.storage.local.set({ 'debug:nliDevice': 'wasm' }); remove it to go
 *    back to WebGPU first. Anything else counts as 'auto'.
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

/** 'wasm' when the debug override is set, else 'auto' (WebGPU first). */
export async function getNliDevice(): Promise<NliDevice> {
  const data = await chrome.storage.local.get<{ [DEVICE_KEY]?: unknown }>(DEVICE_KEY);
  return data[DEVICE_KEY] === 'wasm' ? 'wasm' : 'auto';
}

/** The running extension's version; 'dev' where the manifest is not available (tests). */
export function extensionVersion(): string {
  return globalThis.chrome?.runtime?.getManifest?.().version ?? 'dev';
}
