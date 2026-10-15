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
 *  - Single-threaded wasm: threads need SharedArrayBuffer, which needs a
 *    cross-origin-isolated page.
 *  - Labels come from the model's own config.id2label (0 contradiction,
 *    1 entailment, 2 neutral for this model); init fails if one is missing,
 *    so a different model can never be read with the wrong label order.
 */

import { AutoModelForSequenceClassification, AutoTokenizer, env } from '@huggingface/transformers';
import type { NliPair, NliProbs, NliRequest, NliResponse } from './nli';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The parts of the worker global scope this file uses (tsconfig has no WebWorker lib). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<NliRequest>) => void) | null;
  postMessage(message: NliResponse): void;
}

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Model = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;

interface Loaded {
  tokenizer: Tokenizer;
  model: Model;
  /** Logit index of each label. */
  index: { entailment: number; contradiction: number; neutral: number };
}

const scope = self as unknown as WorkerScope;

/** Max tokens of one premise + hypothesis pair (the model's position limit). */
const MAX_TOKENS = 512;

let loaded: Loaded | null = null;

// ─── Load ─────────────────────────────────────────────────────────────────────

async function load(modelId: string, modelUrl: string, wasmUrl: string): Promise<Loaded> {
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

  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
    dtype: 'q8',
    device: 'wasm',
  });

  const id2label = (model.config as { id2label?: Record<string, string> }).id2label ?? {};
  const find = (label: string): number => {
    const entry = Object.entries(id2label).find(([, l]) => l.toLowerCase() === label);
    if (!entry) throw new Error(`NLI model config has no "${label}" label`);
    return Number(entry[0]);
  };
  return {
    tokenizer,
    model,
    index: { entailment: find('entailment'), contradiction: find('contradiction'), neutral: find('neutral') },
  };
}

// ─── Score ────────────────────────────────────────────────────────────────────

function softmax(row: number[]): number[] {
  const max = Math.max(...row);
  const exps = row.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

async function score({ tokenizer, model, index }: Loaded, pairs: NliPair[]): Promise<NliProbs[]> {
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
    return { entailment: p[index.entailment], contradiction: p[index.contradiction], neutral: p[index.neutral] };
  });
}

// ─── Messages ─────────────────────────────────────────────────────────────────

scope.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    const started = performance.now();
    try {
      loaded ??= await load(msg.modelId, msg.modelUrl, msg.wasmUrl);
      scope.postMessage({ type: 'ready', loadMs: performance.now() - started });
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
