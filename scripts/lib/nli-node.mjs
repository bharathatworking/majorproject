/**
 * Shared by the Node evaluation scripts (calibrate-nli, calibrate-meaning,
 * eval-nli-external): the bundled NLI model on onnxruntime-node, all-minilm
 * embeddings through local Ollama, JSONL reading and the app's TypeScript
 * modules through Vite's ssrLoadModule.
 *
 * Design decisions:
 *  - Same model, same weights as the extension: Xenova/nli-deberta-v3-xsmall
 *    from public/models/ (npm run fetch-models), env.allowRemoteModels =
 *    false, one intra-op thread like the extension's wasm backend. The graph
 *    and weights are identical, so probabilities match to rounding.
 *  - score() tokenizes like nli.worker.ts (pairs over 512 tokens are scored
 *    truncated and flagged), so a script can wrap it as an NliBackend and run
 *    the app's own checkEntailment.
 *  - score() runs the pairs in order in batches of NLI_BATCH_SIZE, read from
 *    the app's config.ts (Node strips its types; it has no imports), so a
 *    script that calls it directly batches like the app and the calibration.
 *    Scripts that go through NliClient already send at most NLI_BATCH_SIZE.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NLI_BATCH_SIZE } from '../../src/lib/quality/config.ts';

// ─── Config ───────────────────────────────────────────────────────────────────

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLLAMA = 'http://localhost:11434';
const EMBED_MODEL = 'all-minilm';
const MAX_TOKENS = 512;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.split(/\r?\n/).filter(l => l.trim() !== '').map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      throw new Error(`${path} line ${i + 1}: ${err.message}`);
    }
  });
}

function softmax(row) {
  const max = Math.max(...row);
  const exps = row.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

/** all-minilm vectors from Ollama, or null when it doesn't answer. */
export async function embed(texts) {
  try {
    const res = await fetch(`${OLLAMA}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: '10m' }),
    });
    if (!res.ok) return null;
    return (await res.json()).embeddings;
  } catch {
    return null;
  }
}

/** embed() that throws instead of returning null (an EmbedFn for checkEntailment). */
export async function embedOrThrow(texts) {
  const vectors = await embed(texts);
  if (!vectors) throw new Error('all-minilm via Ollama did not answer');
  return vectors;
}

// ─── Vite ─────────────────────────────────────────────────────────────────────

/** A Vite server for loading the app's TypeScript modules; close() it when done. */
export async function createAppLoader() {
  const { createServer } = await import(pathToFileURL(join(ROOT, 'node_modules/vite/dist/node/index.js')).href);
  return createServer({
    root: ROOT, configFile: false, logLevel: 'error', appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
  });
}

// ─── Model ────────────────────────────────────────────────────────────────────

/**
 * The NLI model; score(pairs) → [{ entailment, contradiction, neutral, truncated }].
 * Defaults: the CPU with one thread (the calibration setup). `device`
 * ('cpu' | 'webgpu') and `threads` are for scripts/nli-perf.mjs only.
 */
export async function loadModel(modelId, dtype = 'q8', { device = 'cpu', threads = 1 } = {}) {
  const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = join(ROOT, 'public', 'models') + '/';
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
    dtype,
    device,
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
  });
  const id2label = model.config.id2label ?? {};
  const find = label => Number(Object.entries(id2label).find(([, l]) => l.toLowerCase() === label)?.[0]);
  const index = { entailment: find('entailment'), contradiction: find('contradiction'), neutral: find('neutral') };
  if (Object.values(index).some(Number.isNaN)) throw new Error('model labels missing');

  /** Probabilities and truncation flags for pairs, in order, in batches of NLI_BATCH_SIZE. */
  async function score(pairs) {
    const out = [];
    for (let i = 0; i < pairs.length; i += NLI_BATCH_SIZE) {
      out.push(...await scoreBatch(pairs.slice(i, i + NLI_BATCH_SIZE)));
    }
    return out;
  }
  /** One inference call (same code path as nli.worker.ts). */
  async function scoreBatch(pairs) {
    if (pairs.length === 0) return [];
    const full = tokenizer(pairs.map(p => p.premise), {
      text_pair: pairs.map(p => p.hypothesis), padding: false, truncation: false, return_tensor: false,
    });
    const inputs = tokenizer(pairs.map(p => p.premise), {
      text_pair: pairs.map(p => p.hypothesis), padding: true, truncation: true, max_length: MAX_TOKENS,
    });
    const { logits } = await model(inputs);
    const labels = logits.dims[1];
    return pairs.map((_, i) => {
      const p = softmax(Array.from({ length: labels }, (_, j) => Number(logits.data[i * labels + j])));
      return {
        entailment: p[index.entailment],
        contradiction: p[index.contradiction],
        neutral: p[index.neutral],
        truncated: full.input_ids[i].length > MAX_TOKENS,
      };
    });
  }
  /** Token count of each pair, untruncated (premise + hypothesis + special tokens). */
  function tokenLengths(pairs) {
    if (pairs.length === 0) return [];
    const full = tokenizer(pairs.map(p => p.premise), {
      text_pair: pairs.map(p => p.hypothesis), padding: false, truncation: false, return_tensor: false,
    });
    return full.input_ids.map(ids => ids.length);
  }
  return { score, tokenLengths };
}

// ─── Statistics ───────────────────────────────────────────────────────────────

/** Wilson score 95% interval of k successes in n, as [low, high]; null for n = 0. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return null;
  const p = k / n;
  const denom = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
