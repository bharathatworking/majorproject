/**
 * Sentence-level NLI check (thesis standard, stage 6C): is every simplified
 * sentence supported by, and not contradicted by, the original paragraph?
 *
 * Design decisions:
 *  - Model: Xenova/nli-deberta-v3-xsmall (ONNX, 8-bit quantized), a
 *    cross-encoder trained on SNLI + MultiNLI, Apache-2.0. It runs in a Web
 *    Worker (nli.worker.ts) through Transformers.js, so inference never
 *    blocks the UI. The files ship in dist/ (npm run fetch-models); nothing
 *    is downloaded at runtime.
 *  - premise = the original paragraph, hypothesis = one simplified sentence.
 *    A sentence fails when entailment < ENTAILMENT_MIN (unsupported) or
 *    contradiction > CONTRADICTION_MAX (contradicted).
 *  - Glossary sentences that define one of the node's hinted words skip the
 *    entailment requirement but not the contradiction one, and parenthetical
 *    definitions are removed first (lib/quality/glossary.ts).
 *  - Sentences are split from toPlainText(output), so every bullet item is
 *    its own hypothesis, with the same boundary rule as the rolling context.
 *  - NliClient batches pairs (NLI_BATCH_SIZE per worker call) and keeps an
 *    in-memory LRU of pair scores keyed by sha256(premise, hypothesis), so a
 *    retry or a cache re-check never re-scores an unchanged sentence. One
 *    client (and worker) lives per app tab; module state is fine here (this is
 *    an extension page, not the service worker).
 *  - Failures: a model that won't load (missing files, wasm blocked, timeout)
 *    throws NliUnavailableError; the run then falls back to SBERT + entities
 *    and tells the user once. A later call tries to load it again.
 *  - Imported only by the run module (dynamic import), so Transformers.js
 *    stays in the worker chunk and this module out of the main chunk.
 */

import { toPlainText } from '../render/format-output';
import { sha256 } from '../utils/hash';
import {
  CONTRADICTION_MAX, ENTAILMENT_MIN, NLI_BATCH_SIZE, NLI_CACHE_MAX, NLI_LOAD_TIMEOUT_MS,
  NLI_MODEL_ID, NLI_SCORE_TIMEOUT_MS,
} from './config';
import { selectExemptions, stripParentheticalDefinitions } from './glossary';
import type { EntailmentCheck } from '../../types';

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
}

/** Page → worker messages. */
export type NliRequest =
  | { type: 'init'; modelId: string; modelUrl: string; wasmUrl: string }
  | { type: 'score'; id: number; pairs: NliPair[] };

/** Worker → page messages. */
export type NliResponse =
  | { type: 'ready'; loadMs: number }
  | { type: 'init-error'; message: string }
  | { type: 'scores'; id: number; probs: NliProbs[] }
  | { type: 'score-error'; id: number; message: string };

/** Scores one batch of pairs (the worker, or a fake in tests). */
export interface NliBackend {
  score(pairs: NliPair[]): Promise<NliProbs[]>;
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
  loadTimeoutMs?: number;
  scoreTimeoutMs?: number;
}

/**
 * Backend that runs the model in a Web Worker. The worker is created and the
 * model loaded on the first score call; if that fails, the worker is dropped
 * and the next call starts over.
 */
export function createWorkerBackend(createWorker: () => WorkerLike, options: WorkerBackendOptions): NliBackend {
  const loadTimeoutMs = options.loadTimeoutMs ?? NLI_LOAD_TIMEOUT_MS;
  const scoreTimeoutMs = options.scoreTimeoutMs ?? NLI_SCORE_TIMEOUT_MS;

  let worker: WorkerLike | null = null;
  let ready: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (p: NliProbs[]) => void; reject: (e: Error) => void }>();

  function reset(reason: Error) {
    worker?.terminate();
    worker = null;
    ready = null;
    for (const p of pending.values()) p.reject(reason);
    pending.clear();
  }

  function start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
          case 'ready':
            clearTimeout(timer);
            console.log(`[Clarity] NLI model ${NLI_MODEL_ID} loaded in ${Math.round(msg.loadMs)} ms`);
            resolve();
            break;
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
      w.postMessage({ type: 'init', modelId: NLI_MODEL_ID, modelUrl: options.modelUrl, wasmUrl: options.wasmUrl });
    });
  }

  return {
    async score(pairs) {
      ready ??= start();
      await ready;
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

export class NliClient {
  private readonly cache = new Map<string, NliProbs>();

  constructor(
    private readonly backend: NliBackend,
    private readonly batchSize = NLI_BATCH_SIZE,
    private readonly cacheMax = NLI_CACHE_MAX,
  ) {}

  /** Probabilities for every pair, in order, plus how many came from the cache. */
  async scorePairs(pairs: NliPair[]): Promise<{ probs: NliProbs[]; cached: number }> {
    const keys = await Promise.all(pairs.map(p => sha256(`${p.premise}\u0000${p.hypothesis}`)));
    const probs: (NliProbs | undefined)[] = keys.map(k => this.touch(k));
    const cached = probs.filter(Boolean).length;

    // Distinct uncached pairs, scored in batches
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

    return { probs: keys.map(k => this.cache.get(k) as NliProbs), cached };
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
    { modelUrl: chrome.runtime.getURL('models/'), wasmUrl: chrome.runtime.getURL('ort/') },
  ));
  return defaultClient;
}

// ─── Check ────────────────────────────────────────────────────────────────────

export interface EntailmentOptions {
  /** Prefix for the [Clarity] log lines (e.g. the node id). */
  label?: string;
}

/**
 * Scores every simplified sentence against the original paragraph. Throws
 * NliUnavailableError when the model can't load, or Error for a failed
 * request; the caller decides the fallback.
 */
export async function checkEntailment(
  original: string,
  simplified: string,
  hintedWords: readonly string[],
  client: NliClient,
  options: EntailmentOptions = {},
): Promise<EntailmentCheck> {
  const started = performance.now();
  const sentences = splitSentences(simplified)
    .map(s => stripParentheticalDefinitions(s, hintedWords))
    .filter(s => s !== '');

  if (sentences.length === 0) {
    return {
      minEntailment: 0, maxContradiction: 0, unsupportedSentences: [], contradictedSentences: [],
      exemptedSentences: [], exemptionRate: 0, sentences: 0, cachedPairs: 0,
      ms: performance.now() - started,
    };
  }

  const { probs, cached } = await client.scorePairs(
    sentences.map(hypothesis => ({ premise: original, hypothesis })),
  );
  const exempt = new Set(selectExemptions(sentences, hintedWords));

  let minEntailment = 1;
  let maxContradiction = 0;
  const unsupportedSentences: string[] = [];
  const contradictedSentences: string[] = [];
  const exemptedSentences: string[] = [];

  sentences.forEach((sentence, i) => {
    const p = probs[i];
    maxContradiction = Math.max(maxContradiction, p.contradiction);
    if (p.contradiction > CONTRADICTION_MAX) contradictedSentences.push(sentence);
    if (exempt.has(i)) {
      exemptedSentences.push(sentence);
      console.log(
        `[Clarity] NLI ${options.label ?? ''} glossary exemption ` +
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
    ms: performance.now() - started,
  };
}
