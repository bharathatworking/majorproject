import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BENCH_PAIRS, chooseQualityMode, evidenceOf, hasWebGpuAdapter, isBenchStale, predictParagraphMs,
  type SpeedEvidence,
} from '../../src/lib/quality/mode';
import { AUTO_LITE_PARAGRAPH_MS, NLI_TOP_PREMISES, NLI_TYPICAL_SENTENCES } from '../../src/lib/quality/config';
import { getQualityMode, saveQualityMode } from '../../src/lib/storage/settings';
import { extensionVersion, getNliBench, getNliDevice, saveNliBench } from '../../src/lib/storage/nli-bench';
import { installChromeMock } from '../mocks/chrome';
import type { NliBenchRecord } from '../../src/types';

/** Speed evidence from a fake benchmark time (ms for the 8 pairs). */
function measured(benchMs: number, webgpu: boolean): SpeedEvidence {
  return { webgpu, benchMs, predictedParagraphMs: predictParagraphMs(benchMs) };
}

/** Benchmark ms that predicts exactly `paragraphMs`. */
const benchFor = (paragraphMs: number) => (paragraphMs / (NLI_TOP_PREMISES * NLI_TYPICAL_SENTENCES)) * BENCH_PAIRS;

const RECORD: NliBenchRecord = {
  backend: 'wasm', adapterVendor: null, ms: 900, predictedParagraphMs: predictParagraphMs(900),
  version: '1.0.0', webgpuAdapter: false, device: 'auto', at: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// predictParagraphMs
// ---------------------------------------------------------------------------
describe('predictParagraphMs', () => {
  it('scales the per-pair time to top premises × typical sentences', () => {
    expect(predictParagraphMs(800)).toBe(100 * NLI_TOP_PREMISES * NLI_TYPICAL_SENTENCES);
    expect(predictParagraphMs(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// chooseQualityMode
// ---------------------------------------------------------------------------
describe('chooseQualityMode', () => {
  it('uses Full with WebGPU, however slow the benchmark', () => {
    expect(chooseQualityMode('auto', measured(benchFor(9000), true)).mode).toBe('full');
  });

  it('uses Lite without WebGPU when the prediction is above the limit', () => {
    const d = chooseQualityMode('auto', measured(benchFor(3500), false));
    expect(d.mode).toBe('lite');
    expect(d.reason).toMatch(/no WebGPU.*3500 ms per paragraph > 3000/);
  });

  it('uses Full without WebGPU when the prediction is within the limit', () => {
    expect(chooseQualityMode('auto', measured(benchFor(2500), false)).mode).toBe('full');
    expect(chooseQualityMode('auto', measured(benchFor(AUTO_LITE_PARAGRAPH_MS), false)).mode).toBe('full');
  });

  it('uses Full when the speed could not be measured', () => {
    expect(chooseQualityMode('auto', null)).toEqual({
      mode: 'full', reason: 'auto: NLI speed not measured (model unavailable)',
    });
  });

  it('lets an explicit setting win over any measurement', () => {
    expect(chooseQualityMode('lite', measured(10, true)).mode).toBe('lite');
    expect(chooseQualityMode('full', measured(benchFor(99_000), false)).mode).toBe('full');
  });

  it('reads the evidence of a stored record', () => {
    expect(evidenceOf(RECORD)).toEqual({ webgpu: false, benchMs: 900, predictedParagraphMs: RECORD.predictedParagraphMs });
    expect(evidenceOf({ ...RECORD, backend: 'webgpu' }).webgpu).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isBenchStale
// ---------------------------------------------------------------------------
describe('isBenchStale', () => {
  const ctx = { version: '1.0.0', webgpuAdapter: false, device: 'auto' as const };

  it('keeps a record of the same version, adapter state and device', () => {
    expect(isBenchStale(RECORD, ctx)).toBe(false);
  });

  it('is stale after an extension update', () => {
    expect(isBenchStale(RECORD, { ...ctx, version: '1.0.1' })).toBe(true);
  });

  it('is stale when a WebGPU adapter appeared or disappeared', () => {
    expect(isBenchStale(RECORD, { ...ctx, webgpuAdapter: true })).toBe(true);
  });

  it('is stale when the requested device changed', () => {
    expect(isBenchStale(RECORD, { ...ctx, device: 'wasm' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasWebGpuAdapter
// ---------------------------------------------------------------------------
describe('hasWebGpuAdapter', () => {
  it('is false without navigator.gpu (node)', async () => {
    expect(await hasWebGpuAdapter()).toBe(false);
  });

  it('asks for the high-performance adapter', async () => {
    const requestAdapter = vi.fn(async () => ({}));
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    expect(await hasWebGpuAdapter()).toBe(true);
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
  });

  it('is false when no adapter is returned or the request throws', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => null } });
    expect(await hasWebGpuAdapter()).toBe(false);
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => { throw new Error('blocked'); } } });
    expect(await hasWebGpuAdapter()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Storage: qualityMode setting, nli:bench, debug:nliDevice
// ---------------------------------------------------------------------------
describe('quality mode storage', () => {
  beforeEach(() => {
    installChromeMock();
  });

  it("defaults to 'auto' and ignores invalid values", async () => {
    expect(await getQualityMode()).toBe('auto');
    await chrome.storage.sync.set({ qualityMode: 'turbo' });
    expect(await getQualityMode()).toBe('auto');
  });

  it('saves and reads back a mode', async () => {
    await saveQualityMode('lite');
    expect(await getQualityMode()).toBe('lite');
  });

  it('stores the benchmark in local storage', async () => {
    expect(await getNliBench()).toBeNull();
    await saveNliBench(RECORD);
    expect(await getNliBench()).toEqual(RECORD);
  });

  it("reads the device override: 'wasm' only when set to exactly that", async () => {
    expect(await getNliDevice()).toBe('auto');
    await chrome.storage.local.set({ 'debug:nliDevice': 'wasm' });
    expect(await getNliDevice()).toBe('wasm');
    await chrome.storage.local.set({ 'debug:nliDevice': 'gpu' });
    expect(await getNliDevice()).toBe('auto');
  });

  it("reports 'dev' when the manifest is not available", () => {
    expect(extensionVersion()).toBe('dev');
  });
});
