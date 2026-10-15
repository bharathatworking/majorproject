/**
 * Web Worker that runs the NLI cross-encoder (see nli.ts for the protocol and
 * the design of the check).
 *
 * Design decisions:
 *  - Fully local: env.allowRemoteModels = false, model files from
 *    <extension>/models/<id>/ and the ONNX Runtime wasm from <extension>/ort/
 *    (both copied there by npm run fetch-models). The page passes the URLs in
 *    the init message because chrome.* is not reliably available in workers.
 *  - Explicit wasmPaths with useWasmCache off: Transformers.js otherwise
 *    defaults to a CDN URL and loads the wasm factory from a blob: URL, which
 *    script-src 'self' (rightly) blocks. Compiling the wasm itself needs
 *    'wasm-unsafe-eval' in the extension CSP, and nothing more.
 *  - WebGPU first: the worker asks for the 'high-performance' adapter (the
 *    discrete GPU on a laptop with two), hands that adapter to ONNX Runtime
 *    so it can't pick another one, loads the same q8 weights with device
 *    'webgpu' and runs one warm-up pair. Any failure there (no adapter,
 *    unsupported op, shader error) falls back to wasm. The WebGPU build of
 *    ONNX Runtime uses the same asyncify wasm files, and WGSL shaders are not
 *    script, so no CSP change is needed.
 *  - Single-threaded wasm: threads need SharedArrayBuffer, which needs a
 *    cross-origin-isolated page.
 *  - Truncation: each pair is also tokenized without truncation, and pairs
 *    over MAX_TOKENS are flagged `truncated`, so the run can count them.
 *  - Labels come from the model's own config.id2label (0 contradiction,
 *    1 entailment, 2 neutral for this model); init fails if one is missing,
 *    so a different model can never be read with the wrong label order.
 */

import { AutoModelForSequenceClassification, AutoTokenizer, env } from '@huggingface/transformers';
import type { GpuAdapterSummary, NliPair, NliProbs, NliRequest, NliResponse } from './nli';
import type { NliBackendName, NliDevice } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The parts of the worker global scope this file uses (tsconfig has no WebWorker lib). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<NliRequest>) => void) | null;
  postMessage(message: NliResponse): void;
  navigator: { gpu?: GpuLike };
}

/** The parts of WebGPU used here (tsconfig has no WebGPU types). */
interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string; description?: string };
}
interface GpuLike {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<GpuAdapterLike | null>;
}

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Model = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;

interface Loaded {
  tokenizer: Tokenizer;
  model: Model;
  backend: NliBackendName;
  adapter: GpuAdapterSummary | null;
  webgpuError?: string;
  /** Logit index of each label. */
  index: { entailment: number; contradiction: number; neutral: number };
}

const scope = self as unknown as WorkerScope;

/** Max tokens of one premise + hypothesis pair (the model's position limit). */
const MAX_TOKENS = 512;

/** Warm-up pair that proves a WebGPU session can actually run. */
const WARMUP: NliPair[] = [{ premise: 'The cat sat on the mat.', hypothesis: 'A cat is sitting.' }];

let loaded: Loaded | null = null;

// ─── Load ─────────────────────────────────────────────────────────────────────

function configureEnv(modelUrl: string, wasmUrl: string) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelUrl;
  env.useBrowserCache = false;
  env.useWasmCache = false;
  const wasm = env.backends.onnx.wasm;
  if (!wasm) throw new Error('ONNX Runtime wasm backend is not available');
  wasm.wasmPaths = {
    mjs: `${wasmUrl}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${wasmUrl}ort-wasm-simd-threaded.asyncify.wasm`,
  };
  wasm.numThreads = 1;
  wasm.proxy = false;
}

/** Logit indexes of the three labels, from the model's config. */
function labelIndex(model: Model): Loaded['index'] {
  const id2label = (model.config as { id2label?: Record<string, string> }).id2label ?? {};
  const find = (label: string): number => {
    const entry = Object.entries(id2label).find(([, l]) => l.toLowerCase() === label);
    if (!entry) throw new Error(`NLI model config has no "${label}" label`);
    return Number(entry[0]);
  };
  return { entailment: find('entailment'), contradiction: find('contradiction'), neutral: find('neutral') };
}

/** The high-performance adapter, handed to ONNX Runtime; throws when there is none. */
async function useHighPerformanceAdapter(): Promise<GpuAdapterSummary> {
  const gpu = scope.navigator.gpu;
  if (!gpu) throw new Error('navigator.gpu is not available');
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const webgpu = env.backends.onnx.webgpu as { powerPreference?: string; adapter?: unknown } | undefined;
  if (webgpu) {
    webgpu.powerPreference = 'high-performance';
    webgpu.adapter = adapter;
  }
  return {
    vendor: adapter.info?.vendor ?? '',
    architecture: adapter.info?.architecture ?? '',
    description: adapter.info?.description ?? '',
  };
}

async function loadOn(modelId: string, backend: NliBackendName): Promise<Pick<Loaded, 'model' | 'index'>> {
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'q8', device: backend });
  return { model, index: labelIndex(model) };
}

async function load(modelId: string, modelUrl: string, wasmUrl: string, device: NliDevice): Promise<Loaded> {
  configureEnv(modelUrl, wasmUrl);
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);

  let webgpuError: string | undefined;
  if (device === 'auto') {
    try {
      const adapter = await useHighPerformanceAdapter();
      const candidate: Loaded = { tokenizer, ...(await loadOn(modelId, 'webgpu')), backend: 'webgpu', adapter };
      await score(candidate, WARMUP);
      return candidate;
    } catch (err) {
      webgpuError = String(err);
    }
  }
  return {
    tokenizer,
    ...(await loadOn(modelId, 'wasm')),
    backend: 'wasm',
    adapter: null,
    ...(webgpuError !== undefined && { webgpuError }),
  };
}

// ─── Score ────────────────────────────────────────────────────────────────────

function softmax(row: number[]): number[] {
  const max = Math.max(...row);
  const exps = row.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

/** Per pair: longer than MAX_TOKENS before truncation. */
function overLimit(tokenizer: Tokenizer, pairs: NliPair[]): boolean[] {
  const full = tokenizer(pairs.map(p => p.premise), {
    text_pair: pairs.map(p => p.hypothesis),
    padding: false,
    truncation: false,
    return_tensor: false,
  }) as unknown as { input_ids: number[][] };
  return full.input_ids.map(ids => ids.length > MAX_TOKENS);
}

async function score({ tokenizer, model, index }: Loaded, pairs: NliPair[]): Promise<NliProbs[]> {
  const truncated = overLimit(tokenizer, pairs);
  const inputs = tokenizer(pairs.map(p => p.premise), {
    text_pair: pairs.map(p => p.hypothesis),
    padding: true,
    truncation: true,
    max_length: MAX_TOKENS,
  });
  const output = (await model(inputs)) as { logits: { data: ArrayLike<number>; dims: number[] } };
  const { data, dims } = output.logits;
  const labels = dims[1];
  return pairs.map((_, i) => {
    const p = softmax(Array.from({ length: labels }, (_, j) => Number(data[i * labels + j])));
    return {
      entailment: p[index.entailment], contradiction: p[index.contradiction], neutral: p[index.neutral],
      ...(truncated[i] && { truncated: true }),
    };
  });
}

// ─── Messages ─────────────────────────────────────────────────────────────────

scope.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    const started = performance.now();
    try {
      loaded ??= await load(msg.modelId, msg.modelUrl, msg.wasmUrl, msg.device);
      scope.postMessage({
        type: 'ready',
        loadMs: performance.now() - started,
        backend: loaded.backend,
        adapter: loaded.adapter,
        ...(loaded.webgpuError !== undefined && { webgpuError: loaded.webgpuError }),
      });
    } catch (err) {
      scope.postMessage({ type: 'init-error', message: `NLI model failed to load: ${String(err)}` });
    }
    return;
  }
  if (!loaded) {
    scope.postMessage({ type: 'score-error', id: msg.id, message: 'NLI model is not loaded' });
    return;
  }
  try {
    scope.postMessage({ type: 'scores', id: msg.id, probs: await score(loaded, msg.pairs) });
  } catch (err) {
    scope.postMessage({ type: 'score-error', id: msg.id, message: String(err) });
  }
};
