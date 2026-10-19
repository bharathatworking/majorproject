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
 *    the calibrated ENTAILMENT_MIN holds on WebGPU, wasm and in Node. fp16
 *    weights on WebGPU are an experiment only (debug:nliDevice =
 *    'webgpu-fp16', lib/quality/nli-experiment.ts).
 *  - Backend: WebGPU first (the system's adapter; the GPU is chosen in the
 *    Windows Graphics settings), wasm when WebGPU is missing or fails to load
 *    or warm up. The worker reports the backend, the dtype and the adapter
 *    vendor.
 *  - Premises (lib/quality/premises.ts, SummaC zero-shot, Laban et al.,
 *    2022, TACL): each simplified sentence is scored against the original's
 *    sentences and 2-sentence windows, pruned to the NLI_TOP_PREMISES most
 *    similar (all-minilm cosine via the injected `embed`, word overlap when
 *    it is missing). Entailment is the max over those premises,
 *    contradiction per NLI_CONTRADICTION_AGG. A sentence is unsupported when
 *    entailment < ENTAILMENT_MIN and contradicted when contradiction >
 *    CONTRADICTION_MAX; whether the paragraph passes is the paragraph rule
 *    (NLI_PARAGRAPH_RULE, lib/quality/verdict.ts nliVerdict). Every
 *    sentence's scores are returned, so a run report can be re-judged.
 *  - Glossary sentences that define one of the node's hinted words skip the
 *    entailment requirement but not the contradiction one, and parenthetical
 *    definitions are removed first (lib/quality/glossary.ts).
 *  - Sentences are split from toPlainText(output), so every bullet item is
 *    its own hypothesis, with the same boundary rule as the rolling context.
 *  - Hypothesis context (hypothesisFor): a sentence of fewer than
 *    NLI_CONTEXT_MAX_WORDS words, or one starting with This / That / It /
 *    These / They, is scored as "<previous sentence> <sentence>", since alone
 *    it has nothing for the premises to entail ("Anatocism is the same.").
 *    Verdicts and reasons still name the sentence itself, and glossary
 *    exemptions are decided on it alone.
 *  - NliClient sends a node's uncached pairs in batches of
 *    NLI_BATCH_SIZE_WEBGPU (32) or NLI_BATCH_SIZE_WASM (8), by the backend
 *    the model loaded on, and keeps an in-memory LRU of pair scores keyed by
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
 *  - checkMainClaim is the reverse direction for the combined score's
 *    mainClaim feature (lib/quality/checker.ts): the original's main-claim
 *    sentence is the hypothesis, the simplified text's sentences and windows
 *    the premises, through the same client and pair cache.
 *  - Imported only by the run module (dynamic import), so Transformers.js
 *    stays in the worker chunk and this module out of the main chunk.
 */

import { sha256 } from '../utils/hash';
import { getNliBench, getNliDevice, saveNliBench } from '../storage/nli-bench';
import {
  NLI_BATCH_SIZE_WASM, NLI_BATCH_SIZE_WEBGPU, NLI_CACHE_MAX, NLI_CONTEXT_MAX_WORDS, NLI_CONTRADICTION_AGG,
  NLI_REFERRING_START,
  NLI_LOAD_TIMEOUT_MS, NLI_MODEL_ID, NLI_SCORE_TIMEOUT_MS, NLI_TOP_PREMISES,
} from './config';
import { selectExemptions, stripParentheticalDefinitions } from './glossary';
import { isBenchStale, predictParagraphMs, type BenchContext } from './mode';
import { aggregate, buildPremises, lexicalRank, rankPremises, splitSentences } from './premises';
import { nliVerdict } from './verdict';
import type { EmbedFn } from './semantic';
import type {
  EntailmentCheck, NliBackendName, NliBenchRecord, NliDevice, NliDtype, PremiseRanking, SentenceScore,
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
      dtype: NliDtype;
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
  /** Weights loaded; absent from backends that don't say (tests): q8. */
  dtype?: NliDtype;
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

// splitSentences lives in premises.ts (pure, also used by meaning.ts); re-exported here
export { splitSentences };

/** A short ("Flashlight.") or referring ("That's called inflation.") sentence. */
export function needsContext(sentence: string): boolean {
  const words = sentence.split(/\s+/).filter(Boolean).length;
  return words < NLI_CONTEXT_MAX_WORDS || NLI_REFERRING_START.test(sentence);
}

/**
 * The hypothesis scored for sentence i: the previous sentence plus it when it
 * needs context (needsContext), else the sentence alone. The first sentence
 * never has context.
 */
export function hypothesisFor(sentences: readonly string[], i: number): string {
  return i > 0 && needsContext(sentences[i]) ? `${sentences[i - 1]} ${sentences[i]}` : sentences[i];
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

/** "webgpu (nvidia ampere)", "webgpu fp16 (nvidia ampere)" or "wasm". */
function describeBackend(info: Pick<NliBackendInfo, 'backend' | 'adapter' | 'dtype'>): string {
  const name = info.dtype === 'fp16' ? `${info.backend} fp16` : info.backend;
  if (info.backend !== 'webgpu' || !info.adapter) return name;
  const parts = [info.adapter.vendor, info.adapter.architecture].filter(Boolean).join(' ');
  return parts ? `${name} (${parts})` : name;
}

/** Pairs per worker call on a backend (config NLI_BATCH_SIZE_*). */
export function batchSizeFor(backend: NliBackendName): number {
  return backend === 'webgpu' ? NLI_BATCH_SIZE_WEBGPU : NLI_BATCH_SIZE_WASM;
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
              backend: msg.backend, dtype: msg.dtype, adapter: msg.adapter, loadMs: msg.loadMs,
              ...(msg.webgpuError !== undefined && { webgpuError: msg.webgpuError }),
            };
            console.log(
              `[Clarity] NLI model ${NLI_MODEL_ID} loaded on ${describeBackend(info)} in ${Math.round(msg.loadMs)} ms` +
              (device !== 'auto' ? ` (${device} requested by debug:nliDevice)` : ''),
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
  /** Fixed batch size; undefined = by the loaded backend (batchSizeFor). */
  private readonly batchSize: number | undefined;
  private readonly cacheMax: number;

  constructor(backend: NliBackend, batchSize?: number, cacheMax = NLI_CACHE_MAX) {
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

  /** Pairs per worker call: the fixed size, else by the loaded backend. */
  get currentBatchSize(): number {
    return this.batchSize ?? batchSizeFor(this.loaded?.backend ?? 'wasm');
  }

  /** Probabilities for every pair, in order, plus cache and truncation counts. */
  async scorePairs(pairs: NliPair[]): Promise<ScoredPairs> {
    // The batch size depends on the backend, so load first (once)
    if (!this.loaded && this.batchSize === undefined) await this.load();
    const keys = await Promise.all(pairs.map(p => sha256(`${p.premise}\u0000${p.hypothesis}`)));
    const probs: (NliProbs | undefined)[] = keys.map(k => this.touch(k));
    const cached = probs.filter(Boolean).length;

    // Distinct uncached pairs, scored in as few calls as the batch size allows
    const missing = [...new Set(keys.filter((_, i) => probs[i] === undefined))];
    const pairByKey = new Map(keys.map((k, i) => [k, pairs[i]]));
    const batchSize = this.currentBatchSize;
    for (let i = 0; i < missing.length; i += batchSize) {
      const batchKeys = missing.slice(i, i + batchSize);
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

/**
 * A client with its own worker, backed by nli.worker.ts and the bundled model
 * files. `getDevice` is read when the worker starts (default: the
 * debug:nliDevice setting).
 */
export function createNliClient(getDevice: () => Promise<NliDevice> = getNliDevice): NliClient {
  return new NliClient(createWorkerBackend(
    () => new Worker(new URL('./nli.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
    { modelUrl: chrome.runtime.getURL('models/'), wasmUrl: chrome.runtime.getURL('ort/'), getDevice },
  ));
}

/** The app tab's client (one worker per tab). */
export function getNliClient(): NliClient {
  defaultClient ??= createNliClient();
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
    dtype: info.dtype ?? 'q8',
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
      passed: false, sentenceScores: [], toleratedSentences: [],
      minEntailment: 0, maxContradiction: 0, unsupportedSentences: [], contradictedSentences: [],
      exemptedSentences: [], exemptionRate: 0, sentences: 0, cachedPairs: 0, pairs: 0, truncatedPairs: 0,
      ranking: 'all', rankMs: 0, scoreMs: 0, ms: performance.now() - started,
    };
  }

  const premises = buildPremises(splitSentences(original));
  if (premises.length === 0) premises.push(original.trim());

  const hypotheses = sentences.map((_, i) => hypothesisFor(sentences, i));
  const { top, ranking } = await pickPremises(premises, hypotheses, options.embed, label);
  const ranked = performance.now();

  const pairs = hypotheses.flatMap((hypothesis, i) => top[i].map(j => ({ premise: premises[j], hypothesis })));
  const { probs, cached, truncated } = await client.scorePairs(pairs);
  const scoreMs = performance.now() - ranked;
  const exempt = new Set(selectExemptions(sentences, hintedWords));

  let offset = 0;
  const sentenceScores: SentenceScore[] = sentences.map((sentence, i) => {
    const own = probs.slice(offset, offset + top[i].length);
    offset += top[i].length;
    const p = aggregate(own, NLI_CONTRADICTION_AGG);
    if (exempt.has(i)) {
      console.log(
        `[Clarity] NLI ${label} glossary exemption ` +
        `(entailment ${p.entailment.toFixed(2)}, contradiction ${p.contradiction.toFixed(2)}): "${sentence}"`,
      );
    }
    return {
      sentence,
      ...(hypotheses[i] !== sentence && { hypothesis: hypotheses[i] }),
      entailment: p.entailment,
      contradiction: p.contradiction,
      exempt: exempt.has(i),
    };
  });
  const verdict = nliVerdict(sentenceScores);
  const scored = sentenceScores.filter(s => !s.exempt);
  const exemptedSentences = sentenceScores.filter(s => s.exempt).map(s => s.sentence);

  return {
    passed: verdict.passed,
    sentenceScores,
    toleratedSentences: verdict.tolerated,
    minEntailment: scored.length > 0 ? Math.min(...scored.map(s => s.entailment)) : 1,
    maxContradiction: Math.max(0, ...sentenceScores.map(s => s.contradiction)),
    unsupportedSentences: verdict.unsupported,
    contradictedSentences: verdict.contradicted,
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

// ─── Main claim ───────────────────────────────────────────────────────────────

/** How well the simplified text still says the original's main claim. */
export interface MainClaimCheck {
  /** Min over the claim sentences of the max entailment over their premises; 0 for an empty output. */
  entailment: number;
  /** The claim sentence with the lowest entailment (null when there is none). */
  weakest: string | null;
  pairs: number;
  ms: number;
}

/**
 * The reverse direction of checkEntailment, for the combined score's
 * mainClaim feature: each main-claim sentence of the original (indexes from
 * mainClaimIndexes) is the hypothesis, and the simplified text's SummaC
 * premises (its sentences and 2-sentence windows, top NLI_TOP_PREMISES by
 * all-minilm, word overlap without it) are the premises. A dropped or
 * changed main point gives a low value. Throws like checkEntailment.
 */
export async function checkMainClaim(
  original: string,
  simplified: string,
  claimIndexes: readonly number[],
  client: NliClient,
  options: EntailmentOptions = {},
): Promise<MainClaimCheck> {
  const started = performance.now();
  const originalSentences = splitSentences(original);
  const claims = [...new Set(claimIndexes)].map(i => originalSentences[i]).filter((s): s is string => !!s);
  if (claims.length === 0 && originalSentences.length > 0) claims.push(originalSentences[0]);
  const premises = buildPremises(splitSentences(simplified));
  if (claims.length === 0 || premises.length === 0) {
    return { entailment: 0, weakest: claims[0] ?? null, pairs: 0, ms: performance.now() - started };
  }

  const { top } = await pickPremises(premises, claims, options.embed, options.label ?? '');
  const pairs = claims.flatMap((hypothesis, i) => top[i].map(j => ({ premise: premises[j], hypothesis })));
  const { probs } = await client.scorePairs(pairs);

  let offset = 0;
  let entailment = Infinity;
  let weakest: string | null = null;
  claims.forEach((claim, i) => {
    const own = probs.slice(offset, offset + top[i].length);
    offset += top[i].length;
    const e = aggregate(own, NLI_CONTRADICTION_AGG).entailment;
    if (e < entailment) {
      entailment = e;
      weakest = claim;
    }
  });
  return { entailment, weakest, pairs: pairs.length, ms: performance.now() - started };
}
