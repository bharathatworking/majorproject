/**
 * Sentence-level NLI check (thesis standard, stage 6C): is every simplified
 * sentence supported by, and not contradicted by, the original paragraph?
 *
 * Design decisions:
 *  - Model: Xenova/nli-deberta-v3-xsmall (ONNX, 8-bit quantized), a
 *    cross-encoder trained on SNLI + MultiNLI, Apache-2.0. It runs in a Web
 *    Worker (nli.worker.ts) through Transformers.js, so inference never
 *    blocks the UI. The files ship in dist/ (npm run fetch-models); nothing
 *    is downloaded at runtime. The same q8 weights run on every backend, so
 *    the calibrated ENTAILMENT_MIN holds on WebGPU, wasm and in Node.
 *  - Backend: WebGPU first (the high-performance adapter, i.e. the discrete
 *    GPU), wasm when WebGPU is missing or fails to load or warm up. The
 *    worker reports which one it uses and the adapter vendor.
 *  - Premises (lib/quality/premises.ts, SummaC zero-shot, Laban et al.,
 *    2022, TACL): each simplified sentence is scored against the original's
 *    sentences and 2-sentence windows, pruned to the NLI_TOP_PREMISES most
 *    similar (all-minilm cosine via the injected `embed`, word overlap when
 *    it is missing). Entailment is the max over those premises,
 *    contradiction per NLI_CONTRADICTION_AGG. A sentence fails when
 *    entailment < ENTAILMENT_MIN (unsupported) or contradiction >
 *    CONTRADICTION_MAX (contradicted).
 *  - Glossary sentences that define one of the node's hinted words skip the
 *    entailment requirement but not the contradiction one, and parenthetical
 *    definitions are removed first (lib/quality/glossary.ts).
 *  - Sentences are split from toPlainText(output), so every bullet item is
 *    its own hypothesis, with the same boundary rule as the rolling context.
 *  - NliClient sends all of a node's uncached pairs in one worker call (up to
 *    NLI_BATCH_SIZE) and keeps an in-memory LRU of pair scores keyed by
 *    sha256(premise, hypothesis), so a retry or a cache re-check never
 *    re-scores an unchanged pair. The worker flags pairs over the model's
 *    512 tokens (scored truncated), and the check counts them. One client
 *    (and worker) lives per app tab; module state is fine here (this is an
 *    extension page, not the service worker).
 *  - Speed benchmark (prepareNli): after the model loads, 8 fixed pairs are
 *    timed once and stored (`nli:bench`) for the Auto quality mode
 *    (lib/quality/mode.ts); re-run when the version, adapter or device changes.
 *  - Failures: a model that won't load (missing files, wasm blocked, timeout)
 *    throws NliUnavailableError; the run then falls back to SBERT + entities
 *    and tells the user once. A later call tries to load it again.
 *  - Imported only by the run module (dynamic import), so Transformers.js
 *    stays in the worker chunk and this module out of the main chunk.
 */

import { toPlainText } from '../render/format-output';
import { sha256 } from '../utils/hash';
import { getNliBench, getNliDevice, saveNliBench } from '../storage/nli-bench';
import {
  CONTRADICTION_MAX, ENTAILMENT_MIN, NLI_BATCH_SIZE, NLI_CACHE_MAX, NLI_CONTRADICTION_AGG,
  NLI_LOAD_TIMEOUT_MS, NLI_MODEL_ID, NLI_SCORE_TIMEOUT_MS, NLI_TOP_PREMISES,
} from './config';
import { selectExemptions, stripParentheticalDefinitions } from './glossary';
import { isBenchStale, predictParagraphMs, type BenchContext } from './mode';
import { aggregate, buildPremises, lexicalRank, rankPremises } from './premises';
import type { EmbedFn } from './semantic';
import type {
  EntailmentCheck, NliBackendName, NliBenchRecord, NliDevice, PremiseRanking,
} from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NliPair {
  premise: string;
  hypothesis: string;
}

/** Softmax probabilities of one pair. */
export interface NliProbs {
  entailment: number;
  contradiction: number;
  neutral: number;
  /** The pair was longer than the model's 512 tokens and scored truncated. */
  truncated?: boolean;
}

/** What the worker reports about the GPU adapter it uses. */
export interface GpuAdapterSummary {
  vendor: string;
  architecture: string;
  description: string;
}

/** Page → worker messages. */
export type NliRequest =
  | { type: 'init'; modelId: string; modelUrl: string; wasmUrl: string; device: NliDevice }
  | { type: 'score'; id: number; pairs: NliPair[] };

/** Worker → page messages. */
export type NliResponse =
  | {
      type: 'ready';
      loadMs: number;
      backend: NliBackendName;
      adapter: GpuAdapterSummary | null;
      /** Why WebGPU was not used, when it was tried and failed. */
      webgpuError?: string;
    }
  | { type: 'init-error'; message: string }
  | { type: 'scores'; id: number; probs: NliProbs[] }
  | { type: 'score-error'; id: number; message: string };

/** The loaded model's backend. */
export interface NliBackendInfo {
  backend: NliBackendName;
  adapter: GpuAdapterSummary | null;
  loadMs: number;
  webgpuError?: string;
}

/** Scores one batch of pairs (the worker, or a fake in tests). */
export interface NliBackend {
  score(pairs: NliPair[]): Promise<NliProbs[]>;
  /** Loads the model if needed; backends without it count as wasm. */
  load?(): Promise<NliBackendInfo>;
}

/** The minimal Worker surface the backend uses, so tests can pass a fake. */
export interface WorkerLike {
  postMessage(message: NliRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<NliResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** The NLI model could not be loaded; the meaning check falls back without it. */
export class NliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NliUnavailableError';
  }
}

// ─── Sentences ────────────────────────────────────────────────────────────────

/**
 * Sentences of a (possibly bulleted) model output: marker-free text split
 * after . ! or ? followed by whitespace, and at line breaks. Trimmed, empty
 * pieces dropped.
 */
export function splitSentences(text: string): string[] {
  return toPlainText(text)
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[.!?])\s+/))
    .map(s => s.trim())
    .filter(s => s !== '');
}

// ─── Worker backend ───────────────────────────────────────────────────────────

export interface WorkerBackendOptions {
  modelUrl: string;
  wasmUrl: string;
  /** Requested device, read when the worker starts (default 'auto'). */
  getDevice?: () => Promise<NliDevice>;
  loadTimeoutMs?: number;
  scoreTimeoutMs?: number;
}

/** "webgpu (nvidia ampere)" or "wasm". */
function describeBackend(info: Pick<NliBackendInfo, 'backend' | 'adapter'>): string {
  if (info.backend !== 'webgpu' || !info.adapter) return info.backend;
  const parts = [info.adapter.vendor, info.adapter.architecture].filter(Boolean).join(' ');
  return parts ? `webgpu (${parts})` : 'webgpu';
}

/**
 * Backend that runs the model in a Web Worker. The worker is created and the
 * model loaded on the first load or score call; if that fails, the worker is
 * dropped and the next call starts over.
 */
export function createWorkerBackend(
  createWorker: () => WorkerLike,
  options: WorkerBackendOptions,
): Required<NliBackend> {
  const loadTimeoutMs = options.loadTimeoutMs ?? NLI_LOAD_TIMEOUT_MS;
  const scoreTimeoutMs = options.scoreTimeoutMs ?? NLI_SCORE_TIMEOUT_MS;

  let worker: WorkerLike | null = null;
  let ready: Promise<NliBackendInfo> | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (p: NliProbs[]) => void; reject: (e: Error) => void }>();

  function reset(reason: Error) {
    worker?.terminate();
    worker = null;
    ready = null;
    for (const p of pending.values()) p.reject(reason);
    pending.clear();
  }

  async function start(): Promise<NliBackendInfo> {
    // Without getDevice, the worker starts synchronously within this call
    const device: NliDevice = options.getDevice
      ? await options.getDevice().catch(() => 'auto' as const)
      : 'auto';
    return new Promise<NliBackendInfo>((resolve, reject) => {
      let w: WorkerLike;
      try {
        w = createWorker();
      } catch (err) {
        reject(new NliUnavailableError(`NLI worker could not start: ${String(err)}`));
        return;
      }
      worker = w;
      const timer = setTimeout(() => {
        const err = new NliUnavailableError(`NLI model did not load within ${loadTimeoutMs} ms`);
        reset(err);
        reject(err);
      }, loadTimeoutMs);

      w.onmessage = (event) => {
        const msg = event.data;
        switch (msg.type) {
          case 'ready': {
            clearTimeout(timer);
            const info: NliBackendInfo = {
              backend: msg.backend, adapter: msg.adapter, loadMs: msg.loadMs,
              ...(msg.webgpuError !== undefined && { webgpuError: msg.webgpuError }),
            };
            console.log(
              `[Clarity] NLI model ${NLI_MODEL_ID} loaded on ${describeBackend(info)} in ${Math.round(msg.loadMs)} ms` +
              (device === 'wasm' ? ' (wasm forced by debug:nliDevice)' : ''),
            );
            if (msg.webgpuError) console.log(`[Clarity] NLI WebGPU not used: ${msg.webgpuError}`);
            resolve(info);
            break;
          }
          case 'init-error': {
            clearTimeout(timer);
            const err = new NliUnavailableError(msg.message);
            reset(err);
            reject(err);
            break;
          }
          case 'scores':
            pending.get(msg.id)?.resolve(msg.probs);
            pending.delete(msg.id);
            break;
          case 'score-error':
            pending.get(msg.id)?.reject(new Error(msg.message));
            pending.delete(msg.id);
            break;
        }
      };
      w.onerror = (event) => {
        clearTimeout(timer);
        const err = new NliUnavailableError(`NLI worker crashed: ${event.message || 'unknown error'}`);
        reset(err);
        reject(err);
      };
      w.postMessage({
        type: 'init', modelId: NLI_MODEL_ID, modelUrl: options.modelUrl, wasmUrl: options.wasmUrl, device,
      });
    });
  }

  function load(): Promise<NliBackendInfo> {
    ready ??= start();
    return ready;
  }

  return {
    load,
    async score(pairs) {
      await load();
      const w = worker;
      if (!w) throw new NliUnavailableError('NLI worker is not running');
      const id = nextId++;
      return new Promise<NliProbs[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`NLI scoring timed out after ${scoreTimeoutMs} ms`));
        }, scoreTimeoutMs);
        pending.set(id, {
          resolve: (p) => { clearTimeout(timer); resolve(p); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        w.postMessage({ type: 'score', id, pairs });
      });
    },
  };
}

// ─── Client (batching + cache) ────────────────────────────────────────────────

/** Scores of a list of pairs, in order. */
export interface ScoredPairs {
  probs: NliProbs[];
  /** Pairs answered from the in-memory cache. */
  cached: number;
  /** Pairs that were over the model's token limit. */
  truncated: number;
}

export class NliClient {
  private readonly cache = new Map<string, NliProbs>();
  private loaded: NliBackendInfo | null = null;
  private readonly backend: NliBackend;
  private readonly batchSize: number;
  private readonly cacheMax: number;

  constructor(backend: NliBackend, batchSize = NLI_BATCH_SIZE, cacheMax = NLI_CACHE_MAX) {
    this.backend = backend;
    this.batchSize = batchSize;
    this.cacheMax = cacheMax;
  }

  /** Loads the model (once) and returns its backend. */
  async load(): Promise<NliBackendInfo> {
    this.loaded = this.backend.load
      ? await this.backend.load()
      : { backend: 'wasm', adapter: null, loadMs: 0 };
    return this.loaded;
  }

  /** The backend of the last successful load, or null. */
  get info(): NliBackendInfo | null {
    return this.loaded;
  }

  /**
   * ms for one batch of `pairs`, after an untimed warm-up batch (WebGPU
   * compiles its shaders on the first run). Bypasses the cache.
   */
  async bench(pairs: NliPair[]): Promise<number> {
    await this.backend.score(pairs);
    const started = performance.now();
    await this.backend.score(pairs);
    return performance.now() - started;
  }

  /** Probabilities for every pair, in order, plus cache and truncation counts. */
  async scorePairs(pairs: NliPair[]): Promise<ScoredPairs> {
    const keys = await Promise.all(pairs.map(p => sha256(`${p.premise}\u0000${p.hypothesis}`)));
    const probs: (NliProbs | undefined)[] = keys.map(k => this.touch(k));
    const cached = probs.filter(Boolean).length;

    // Distinct uncached pairs, scored in as few calls as the batch size allows
    const missing = [...new Set(keys.filter((_, i) => probs[i] === undefined))];
    const pairByKey = new Map(keys.map((k, i) => [k, pairs[i]]));
    for (let i = 0; i < missing.length; i += this.batchSize) {
      const batchKeys = missing.slice(i, i + this.batchSize);
      const scores = await this.backend.score(batchKeys.map(k => pairByKey.get(k) as NliPair));
      if (scores.length !== batchKeys.length) {
        throw new Error(`NLI returned ${scores.length} scores for ${batchKeys.length} pairs`);
      }
      batchKeys.forEach((k, j) => this.remember(k, scores[j]));
    }

    const all = keys.map(k => this.cache.get(k) as NliProbs);
    return { probs: all, cached, truncated: all.filter(p => p.truncated).length };
  }

  /** Cached value for `key`, marked as most recently used. */
  private touch(key: string): NliProbs | undefined {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
    }
    return hit;
  }

  private remember(key: string, value: NliProbs) {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

let defaultClient: NliClient | null = null;

/** The app tab's client, backed by nli.worker.ts and the bundled model files. */
export function getNliClient(): NliClient {
  defaultClient ??= new NliClient(createWorkerBackend(
    () => new Worker(new URL('./nli.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
    { modelUrl: chrome.runtime.getURL('models/'), wasmUrl: chrome.runtime.getURL('ort/'), getDevice: getNliDevice },
  ));
  return defaultClient;
}

// ─── Benchmark ────────────────────────────────────────────────────────────────

/**
 * Fixed pairs timed by the speed benchmark: sentence-length premises and
 * simplified hypotheses, like the pairs the check sends.
 */
export const NLI_BENCH_PAIRS: readonly NliPair[] = [
  ['The Treaty of Versailles was signed in June 1919 and formally ended the First World War.', 'The treaty that ended the First World War was signed in 1919.'],
  ['Photosynthesis converts light energy into chemical energy stored in glucose molecules.', 'Plants use light to make sugar they can store.'],
  ['The central bank raised interest rates by half a percentage point to slow inflation.', 'The bank made borrowing more expensive to fight rising prices.'],
  ['Patients should take the medication twice daily with food unless a doctor advises otherwise.', 'Take the medicine two times a day with a meal.'],
  ['The river flows north for 6,650 kilometres before emptying into the Mediterranean Sea.', 'The river is 6,650 kilometres long and ends in the sea.'],
  ['Volcanic eruptions can release ash clouds that disrupt air travel across entire continents.', 'Ash from volcanoes can stop planes from flying.'],
  ['The software update fixes a security flaw that allowed attackers to read stored passwords.', 'The update closes a hole that let hackers see passwords.'],
  ['Applicants must submit the completed form and two forms of identification before the deadline.', 'You need to send the form and two IDs before the deadline.'],
].map(([premise, hypothesis]) => ({ premise, hypothesis }));

/** Where prepareNli reads and writes the stored benchmark. */
export interface BenchStore {
  get(): Promise<NliBenchRecord | null>;
  save(record: NliBenchRecord): Promise<void>;
}

const chromeBenchStore: BenchStore = { get: getNliBench, save: saveNliBench };

/**
 * Loads the model and returns this setup's benchmark: the stored one when it
 * matches (same version, adapter state, device and actual backend), else a
 * fresh one, which is stored. Throws NliUnavailableError when the model
 * can't load; a failed save is only logged.
 */
export async function prepareNli(
  client: NliClient,
  ctx: BenchContext,
  store: BenchStore = chromeBenchStore,
): Promise<NliBenchRecord> {
  const info = await client.load();
  const stored = await store.get().catch(() => null);
  if (stored && !isBenchStale(stored, ctx) && stored.backend === info.backend) return stored;

  const ms = await client.bench([...NLI_BENCH_PAIRS]);
  const record: NliBenchRecord = {
    backend: info.backend,
    adapterVendor: info.adapter?.vendor || null,
    ms,
    predictedParagraphMs: predictParagraphMs(ms),
    version: ctx.version,
    webgpuAdapter: ctx.webgpuAdapter,
    device: ctx.device,
    at: Date.now(),
  };
  console.log(
    `[Clarity] NLI benchmark on ${describeBackend(info)}: ${Math.round(ms)} ms for ${NLI_BENCH_PAIRS.length} pairs ` +
    `→ about ${Math.round(record.predictedParagraphMs)} ms per paragraph`,
  );
  await store.save(record).catch(err => console.warn('[Clarity] NLI benchmark save failed', err));
  return record;
}

// ─── Check ────────────────────────────────────────────────────────────────────

export interface EntailmentOptions {
  /** Prefix for the [Clarity] log lines (e.g. the node id). */
  label?: string;
  /** Embeds texts for premise ranking (all-minilm); word overlap without it. */
  embed?: EmbedFn;
}

/**
 * The premises each hypothesis is scored against (indexes into `premises`):
 * all of them when there are no more than NLI_TOP_PREMISES, else the most
 * similar by embedding, or by word overlap when embedding is unavailable.
 */
async function pickPremises(
  premises: string[],
  hypotheses: string[],
  embed: EmbedFn | undefined,
  label: string,
): Promise<{ top: number[][]; ranking: PremiseRanking }> {
  if (premises.length <= NLI_TOP_PREMISES) {
    return { top: hypotheses.map(() => premises.map((_, i) => i)), ranking: 'all' };
  }
  if (embed) {
    try {
      const vecs = await embed([...premises, ...hypotheses]);
      if (vecs.length === premises.length + hypotheses.length) {
        return { top: rankPremises(vecs.slice(0, premises.length), vecs.slice(premises.length)), ranking: 'embedding' };
      }
      console.warn(`[Clarity] NLI ${label} premise embedding returned ${vecs.length} vectors; using word overlap`);
    } catch (err) {
      console.warn(`[Clarity] NLI ${label} premise embedding failed; using word overlap`, err);
    }
  }
  return { top: lexicalRank(premises, hypotheses), ranking: 'lexical' };
}

/**
 * Scores every simplified sentence against its premises from the original.
 * Throws NliUnavailableError when the model can't load, or Error for a
 * failed request; the caller decides the fallback.
 */
export async function checkEntailment(
  original: string,
  simplified: string,
  hintedWords: readonly string[],
  client: NliClient,
  options: EntailmentOptions = {},
): Promise<EntailmentCheck> {
  const started = performance.now();
  const label = options.label ?? '';
  const sentences = splitSentences(simplified)
    .map(s => stripParentheticalDefinitions(s, hintedWords))
    .filter(s => s !== '');

  if (sentences.length === 0) {
    return {
      minEntailment: 0, maxContradiction: 0, unsupportedSentences: [], contradictedSentences: [],
      exemptedSentences: [], exemptionRate: 0, sentences: 0, cachedPairs: 0, pairs: 0, truncatedPairs: 0,
      ranking: 'all', rankMs: 0, scoreMs: 0, ms: performance.now() - started,
    };
  }

  const premises = buildPremises(splitSentences(original));
  if (premises.length === 0) premises.push(original.trim());

  const { top, ranking } = await pickPremises(premises, sentences, options.embed, label);
  const ranked = performance.now();

  const pairs = sentences.flatMap((hypothesis, i) => top[i].map(j => ({ premise: premises[j], hypothesis })));
  const { probs, cached, truncated } = await client.scorePairs(pairs);
  const scoreMs = performance.now() - ranked;
  const exempt = new Set(selectExemptions(sentences, hintedWords));

  let minEntailment = 1;
  let maxContradiction = 0;
  const unsupportedSentences: string[] = [];
  const contradictedSentences: string[] = [];
  const exemptedSentences: string[] = [];

  let offset = 0;
  sentences.forEach((sentence, i) => {
    const own = probs.slice(offset, offset + top[i].length);
    offset += top[i].length;
    const p = aggregate(own, NLI_CONTRADICTION_AGG);
    maxContradiction = Math.max(maxContradiction, p.contradiction);
    if (p.contradiction > CONTRADICTION_MAX) contradictedSentences.push(sentence);
    if (exempt.has(i)) {
      exemptedSentences.push(sentence);
      console.log(
        `[Clarity] NLI ${label} glossary exemption ` +
        `(entailment ${p.entailment.toFixed(2)}, contradiction ${p.contradiction.toFixed(2)}): "${sentence}"`,
      );
      return;
    }
    minEntailment = Math.min(minEntailment, p.entailment);
    if (p.entailment < ENTAILMENT_MIN) unsupportedSentences.push(sentence);
  });

  return {
    minEntailment,
    maxContradiction,
    unsupportedSentences,
    contradictedSentences,
    exemptedSentences,
    exemptionRate: exemptedSentences.length / sentences.length,
    sentences: sentences.length,
    cachedPairs: cached,
    pairs: pairs.length,
    truncatedPairs: truncated,
    ranking,
    rankMs: ranked - started,
    scoreMs,
    ms: performance.now() - started,
  };
}
