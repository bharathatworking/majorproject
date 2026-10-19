/**
 * Core simplification run loop.
 *
 * Stateless — all React state lives in useRunState.ts. This module is a pure
 * async function that drives the LLM, persists results node-by-node, and calls
 * back into React via the callbacks object.
 *
 * Run modes (RunMode): 'remaining' skips nodes already stored as `done`
 * ("Simplify again"); 'all' re-runs every node ("Re-simplify all"). Skipped
 * nodes still feed the rolling context and the post-run simplified report, so
 * both reflect the whole document rather than only the nodes re-run.
 *
 * Every node result — success or error — is persisted as soon as it finishes,
 * so a failure after the last success is not lost.
 *
 * Speed (each node takes the first path that applies):
 *   1. Already simple: the node's estimated grade (lib/metrics/node-grade.ts)
 *      is at or below the target, so the original is stored as `done` with
 *      `skipped: true`. No model call, NER or meaning check.
 *   2. Cache hit (lib/storage/cache.ts), keyed by node text + spec + model
 *      (+ the quality mode). 'all' mode ("Re-simplify all") skips cache
 *      reads, since the user is asking for new text, but still writes. Only
 *      versions that pass the meaning and entity checks are cached.
 *   3. The model.
 * The run starts at `startIndex` (the first node visible in Reading) and wraps
 * around to the earlier nodes. Rolling context is always the previous node in
 * document order, and the simplified report joins text in document order.
 * Per-node and total timings are logged with the [Clarity] prefix.
 *
 * Semantic preservation (stage 6C, thesis standard, lib/quality/meaning.ts):
 * each finished node that passes shouldCheckNode is assessed with
 * assessMeaning: the frozen combined score (lib/quality/checker.ts,
 * eval/checker/PREREG.md) over SBERT cosine, entities kept, NLI entailment
 * and contradiction of every simplified sentence against its premises from
 * the original (lib/quality/nli.ts, in a Web Worker on WebGPU or wasm;
 * premises are original sentences and 2-sentence windows ranked by
 * all-minilm, see lib/quality/premises.ts) and the length ratio; a version
 * passes when the score reaches its threshold. The main-claim check
 * (checkMainClaim) runs only if the frozen FULL model uses it. Embeddings are memoized per node, so the
 * original's premise vectors are computed once across retries and variants. A failing node is retried once with a retry
 * instruction naming the specific reasons, and the better version is kept;
 * its assessment (similarity, entityRecall, minEntailment, maxContradiction,
 * nliChecked, passed, reasons, score, scoreModel) is stored on the result.
 * The retry instruction is prose built from the failed assessment
 * (buildRetryInstruction(retryInputOf(…)): missing items in quotes, never a
 * list). The echo guard (lib/quality/echo.ts) fails a version that copied
 * the prompt (a line of entities, instruction wording); if the kept version
 * still echoes, its echo lines are removed and it is re-assessed without a
 * model call (logged as an `echoStripped` candidate). The check never fails
 * a run:
 *   - Missing embedding model (404): one notice, no similarity for the rest
 *     of the run. Other embed errors skip it for that node.
 *   - NLI model not loadable: one notice, nliChecked: false for the rest of
 *     the run (scored with the LITE model: SBERT, entities, length). Other
 *     NLI errors skip it for that node.
 *   - A failed retry keeps the first version.
 * The run log counts every node as passed / failed / not fully checked /
 * excluded, and the failed ones by failure kind (similarity, entities,
 * unsupported, contradiction; one node can fail several), logged as one
 * "[Clarity] Meaning failures" line; when coverage (fully checked / eligible) is below
 * THESIS_COVERAGE_MIN it warns that the pass rate is not thesis-grade.
 *
 * Prompt optimization (stage 7, lib/quality/score.ts and
 * lib/prompt-builder/variants.ts): every model output is scored with
 * scoreCandidate (meaning 0.5, readability 0.3, length 0.2), whose meaning
 * part is the assessment's meaningScore.
 *   - "Extra quality (slower)" off: the stage 6C retry above, unchanged.
 *   - On: the streamed 'standard' version is kept when it passes 6C and its
 *     total is at least QUALITY_THRESHOLD. Otherwise 'stepwise' and
 *     'example-guided' are both generated (not streamed; with the meaning
 *     retry instruction if 'standard' failed 6C) in place of the 6C retry, and
 *     pickBestCandidate keeps the best of the three. A failed variant request
 *     is skipped, not fatal.
 *   - Never more than MAX_MODEL_CALLS_PER_NODE calls per node. Headings and
 *     short texts (no 6C check) always get one call. Extra-quality results
 *     are cached under their own key.
 *
 * Quality mode (lib/quality/mode.ts, sync `qualityMode`): Full is the
 * above; Lite skips NLI (results nliChecked: false, lite: true, so they stay
 * out of the thesis pass rate), keeps the one 6C retry and ignores "Extra
 * quality". Auto decides from the stored NLI speed benchmark, loading the
 * model and benchmarking only when that is missing or stale. The chosen mode
 * and why are logged and recorded in the run log.
 *
 * Cache: only passing versions are cached, with their assessment. A cached
 * verdict that was not fully checked (NLI or embedding model missing at the
 * time) counts as a miss once both checks are available, so coverage recovers.
 *
 * Run log: every node, and every candidate's variant, scores and time, goes
 * into a RunLog that addRunLog appends to the document at the end of the run
 * (also when cancelled), for the run report download in Reading.
 *
 * Error handling:
 *   HTTP 403 → OLLAMA_ORIGINS not set
 *   HTTP 404 → model not pulled (from /api/show at the start of the run, or
 *              /api/chat if it is removed mid-run). The banner names the
 *              default model; the pull command goes to the console only.
 *   TypeError ("Failed to fetch") → Ollama not running
 *   All others → surfaced as-is
 */

import {
  DEFAULT_LLM_MODEL, EMBED_MODEL, missingModelLog, OllamaHttpError, OllamaProvider,
} from '../llm/ollama-provider';
import { resolveProfile } from '../profile/resolver';
import { buildPrompt, hintedWords } from '../prompt-builder/builder';
import { EXTRA_VARIANTS, stripExampleLabel } from '../prompt-builder/variants';
import { segmentHtml, simplifiableNodes } from '../segmentation/segmenter';
import { getExtraQuality, getLlmModel, getQualityMode, getUserProfile } from '../storage/settings';
import { extensionVersion, getNliBench, getNliDevice } from '../storage/nli-bench';
import { getCommonWordSet } from '../metrics/word-set';
import { computeReadabilityReport } from '../metrics/engine';
import { findDifficultWords } from '../metrics/difficult-words';
import { isAlreadySimple } from '../metrics/node-grade';
import { addRunLog, saveDocument } from '../storage/documents';
import { cacheKey, getCached, putCached } from '../storage/cache';
import { recordSession } from '../storage/progress';
import { toPlainText } from '../render/format-output';
import { checkMeaning, shouldCheckNode } from '../quality/semantic';
import {
  assessMeaning, buildRetryInstruction, candidatePasses, pickBetterVersion, retryInputOf, toStoredMeaning,
} from '../quality/meaning';
import { findEcho, stripEchoLines } from '../quality/echo';
import { pickBestCandidate, scoreCandidate, type ScoredCandidate } from '../quality/score';
import {
  chooseQualityMode, evidenceOf, hasWebGpuAdapter, isBenchStale, type BenchContext, type QualityDecision,
} from '../quality/mode';
import { mainClaimIndexes, PREMISE_STRATEGY } from '../quality/premises';
import { failureBreakdown, failuresFromReasons, formatFailureBreakdown } from '../quality/verdict';
import {
  COMBINED_SCORE_FULL, COMBINED_SCORE_LITE, CONTRADICTION_MAX, ENTAILMENT_MIN, ENTITY_RECALL_MIN, GLOSSARY_EXEMPTION_MAX_RATE, MAX_MODEL_CALLS_PER_NODE,
  NLI_BUDGET_MS, NLI_CONTRADICTION_AGG, NLI_HYPOTHESIS_CONTEXT, NLI_MODEL_ID, NLI_PARAGRAPH_RULE,
  QUALITY_THRESHOLD, SIMILARITY_THRESHOLD, THESIS_COVERAGE_MIN, WEIGHTS,
} from '../quality/config';
import { isFullyChecked, meaningStatusOf, summarizeMeaning } from '../quality/similarity';
import { formatSeconds, summarizeRun, type NodeTiming } from './timing';
import type {
  CachedResult, CandidateLog, CandidateScores, ClarityDocument, ContentNode, EntailmentCheck,
  MeaningAssessment, MeaningStatus, NliBenchRecord, NodeMeaningLog, NodeRunLog, NodeSource,
  PromptVariantId, QualityModeSetting, RunLog, RunMode, StoredMeaning, StoredResult,
} from '../../types';

/** The NLI module, loaded on first use (keeps it and its worker out of other chunks). */
type NliModule = typeof import('../quality/nli');

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RunCallbacks {
  onProgress: (nodesDone: number, nodesTotal: number) => void;
  onNodeStart:  (nodeId: string) => void;
  onNodeChunk:  (nodeId: string, accumulated: string) => void;
  /**
   * `meaning` is set when the meaning check assessed the kept version;
   * `skipped` when the node was already simple and kept as is.
   */
  onNodeDone:   (nodeId: string, finalText: string, meaning?: StoredMeaning, skipped?: boolean) => void;
  onNodeError:  (nodeId: string) => void;
  onBannerError: (message: string) => void;
  /** Non-fatal information for the user (e.g. meaning checker not installed). */
  onNotice: (message: string) => void;
  onComplete: () => void;
  signal: AbortSignal;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip any leaked <think>…</think> blocks (qwen3 residue — harmless no-op on qwen2.5). */
function stripThinkingArtifacts(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Last sentence of marker-free text, used as rolling context for the next node. */
function lastSentence(plainText: string): string {
  const sentences = plainText.split(/(?<=[.!?])\s+/);
  return sentences[sentences.length - 1] ?? '';
}

/** Rounds to 4 decimals so the run report stays readable. */
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

const round4OrNull = (x: number | null) => (x === null ? null : round4(x));

const roundMs = (x: number | null) => (x === null ? null : Math.round(x));

function roundScores(s: CandidateScores): CandidateScores {
  return {
    gradeGap: round4(s.gradeGap),
    similarity: round4OrNull(s.similarity),
    entityRecall: round4(s.entityRecall),
    lengthRatio: round4(s.lengthRatio),
    minEntailment: round4OrNull(s.minEntailment),
    maxContradiction: round4OrNull(s.maxContradiction),
    passed: s.passed,
    total: round4(s.total),
  };
}

/** Stored meaning fields, rounded for the run log. */
function roundMeaning(m: StoredMeaning): StoredMeaning {
  return {
    ...m,
    ...(m.similarity !== undefined && { similarity: round4(m.similarity) }),
    ...(m.entityRecall !== undefined && { entityRecall: round4(m.entityRecall) }),
    ...(m.minEntailment !== undefined && { minEntailment: round4(m.minEntailment) }),
    ...(m.maxContradiction !== undefined && { maxContradiction: round4(m.maxContradiction) }),
  };
}

/** Stored meaning of a version; Lite-mode verdicts are marked `lite`. */
function storedMeaningOf(a: MeaningAssessment, lite: boolean): StoredMeaning {
  return { ...toStoredMeaning(a), ...(lite && { lite: true }) };
}

/** Run-log meaning of a model-produced kept version. */
function meaningLog(a: MeaningAssessment, lite: boolean): NodeMeaningLog {
  return {
    ...roundMeaning(storedMeaningOf(a, lite)),
    exemptedSentences: a.exemptedSentences,
    exemptionRate: round4OrNull(a.exemptionRate),
    nliMs: roundMs(a.nliMs),
  };
}

/**
 * Picks the nodes a run should send to the model.
 * 'remaining' keeps nodes without a `done` result (pending, error, or never
 * run); 'all' keeps every node.
 */
export function selectNodesToRun(
  nodes: ContentNode[],
  results: StoredResult[],
  mode: RunMode,
): ContentNode[] {
  if (mode === 'all') return nodes;
  const doneIds = new Set(results.filter(r => r.status === 'done').map(r => r.nodeId));
  return nodes.filter(n => !doneIds.has(n.id));
}

/**
 * `items` starting at index `start`, then wrapping around to the ones before
 * it. An out-of-range start is clamped; a non-finite one counts as 0.
 */
export function rotateFrom<T>(items: T[], start: number): T[] {
  const s = Number.isFinite(start) ? Math.min(Math.max(0, Math.trunc(start)), items.length) : 0;
  return [...items.slice(s), ...items.slice(0, s)];
}

function classifyError(err: unknown, model: string): string {
  if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
    return "Can't reach Ollama at localhost:11434. Is it running?";
  }
  const status = err instanceof OllamaHttpError ? err.status : undefined;
  if (status === 403) {
    return (
      `Ollama refused the request (403). ` +
      `Set OLLAMA_ORIGINS to chrome-extension://${chrome.runtime.id} ` +
      `and fully restart Ollama. See README.md.`
    );
  }
  if (status === 404) {
    console.log(missingModelLog(model));
    const which = model === DEFAULT_LLM_MODEL ? `The default model ${model}` : `The model ${model}`;
    const fallback = model === DEFAULT_LLM_MODEL ? '' : ` The default is ${DEFAULT_LLM_MODEL}.`;
    return (
      `${which} isn't installed in Ollama. Install it, or pick an installed model ` +
      `in Settings → AI Model.${fallback} See README.md.`
    );
  }
  return String(err);
}

/** Shown once per run when the embedding model is missing (HTTP 404). */
export const EMBED_MISSING_NOTICE = `Install the meaning checker: ollama pull ${EMBED_MODEL}`;

/** Shown once per run when the NLI model can't be loaded. */
export const NLI_MISSING_NOTICE =
  'The sentence-level meaning check (NLI) is unavailable, so this run uses similarity and ' +
  'entities only and its pass rate is not thesis-grade. Run npm run fetch-models, ' +
  'npm run build, and reload the extension.';

// Maps ContentNode.type → StoredResult.type (handles the now-removed 'list' type too)
const STORED_TYPE: Record<ContentNode['type'], StoredResult['type']> = {
  heading:    'heading',
  paragraph:  'paragraph',
  'list-item':'list-item',
  blockquote: 'blockquote',
  list:       'paragraph',  // shouldn't appear after segmenter fix
  table:      'paragraph',  // skipped anyway
};

/** One scored model output, with what the run log needs about it. */
interface Attempt extends ScoredCandidate {
  retryInstruction: boolean;
  ms: number;
  /** The kept version with its echo lines removed (no model call). */
  echoStripped?: boolean;
}

/** The version a node keeps, plus every candidate for the run log. */
interface Generated {
  chosen: Attempt;
  candidates: CandidateLog[];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runSimplification(
  doc: ClarityDocument,
  callbacks: RunCallbacks,
  mode: RunMode = 'remaining',
  startIndex = 0,
): Promise<void> {
  const { signal } = callbacks;
  const runStart = performance.now();
  const startedAt = Date.now();

  // 1. Normalize any 'streaming' results left over from a previous crashed run.
  if (doc.results.some(r => r.status === 'streaming')) {
    const normalized = doc.results.map(r =>
      r.status === 'streaming' ? { ...r, status: 'pending' as const } : r,
    );
    doc = { ...doc, results: normalized };
    await saveDocument(doc);
  }
  if (signal.aborted) return;

  // 2. Profile + word set + model + "Extra quality" + quality mode (parallel fetch)
  const [profile, wordSet, model, extraQualitySetting, qualitySetting] = await Promise.all([
    getUserProfile(), getCommonWordSet(), getLlmModel(), getExtraQuality(), getQualityMode(),
  ]);
  if (signal.aborted) return;

  const currentGrade = doc.report?.estimatedGradeLevel ?? 8;
  const spec = resolveProfile(profile, currentGrade);

  // 3. Segment into simplifiable nodes
  const segmented = segmentHtml(doc.html, doc.title, doc.contentHash);
  const simplifiable = simplifiableNodes(segmented.nodes);

  const toRun = selectNodesToRun(simplifiable, doc.results, mode);

  if (toRun.length === 0) {
    callbacks.onComplete();
    return;
  }
  const runIds = new Set(toRun.map(n => n.id));
  const storedById = new Map(doc.results.map(r => [r.nodeId, r]));
  const docIndex = new Map(simplifiable.map((n, i) => [n.id, i]));

  // Marker-free text of every node with a done result (kept from earlier runs
  // or produced by this one), for rolling context and the simplified report
  const plainById = new Map<string, string>();
  for (const node of simplifiable) {
    if (runIds.has(node.id)) continue;
    const plainText = toPlainText(storedById.get(node.id)?.simplifiedText ?? '');
    if (plainText) plainById.set(node.id, plainText);
  }

  callbacks.onProgress(0, toRun.length);

  // 4. Bootstrap the LLM session with the first node's system prompt
  const llm = new OllamaProvider(model);
  const firstPromptObj = doc.report
    ? buildPrompt(toRun[0], spec, doc.report)
    : null;

  try {
    await llm.createBaseSession(firstPromptObj?.system ?? '');
  } catch (err) {
    if (!signal.aborted) callbacks.onBannerError(classifyError(err, model));
    return;
  }
  if (signal.aborted) { llm.destroy(); return; }

  // 5. Process each node, starting at the visible one
  let doneCount = 0;

  // Work from a mutable copy of results; we upsert per-node as we go
  const storedResults: StoredResult[] = [...doc.results];

  function upsertResult(result: StoredResult) {
    const idx = storedResults.findIndex(r => r.nodeId === result.nodeId);
    if (idx >= 0) storedResults[idx] = result;
    else storedResults.push(result);
  }

  /** Records the result in the run's copy and persists the document now. */
  async function persist(result: StoredResult) {
    upsertResult(result);
    doc = { ...doc, results: storedResults, lastRunAt: Date.now() };
    await saveDocument(doc);
  }

  let firstError: string | null = null;

  // Meaning checks: per-run flags, turned off after the first 404 from
  // /api/embed or the first NLI model load failure
  let embedAvailable = true;
  let nliAvailable = true;
  let nliModule: NliModule | null = null;
  /** Loads the NLI module and model once per run (see ensureNli). */
  let nliReady: Promise<NliModule | null> | null = null;
  /** This run's NLI benchmark (backend and speed); null until the model loaded. */
  let nliBench: NliBenchRecord | null = null;
  let benchContext: Promise<BenchContext> | null = null;
  // Set once the quality mode is decided, before the first node
  let lite = false;
  let extraQuality = extraQualitySetting;

  // Timing and run log: recorded per node, summarized after the loop
  const timings: NodeTiming[] = [];
  const nodeLogs: NodeRunLog[] = [];
  let firstResultMs: number | null = null;
  // NLI time of every assessed version, and the kept versions' sentence counts
  const nliTimes: number[] = [];
  let nliPairs = 0;
  let truncatedPairs = 0;
  let keptNliSentences = 0;
  let keptExempted = 0;
  // Model calls made for the current node (reset per node; read on errors too)
  let nodeCalls = 0;

  function finishNode(
    node: ContentNode,
    source: NodeSource,
    nodeStartedAt: number,
    details: Partial<Pick<NodeRunLog, 'variantUsed' | 'candidates' | 'meaning'>> = {},
  ) {
    const now = performance.now();
    const ms = now - nodeStartedAt;
    const meaningStatus: MeaningStatus =
      source === 'error' ? 'error'
      : source === 'skipped' ? 'excluded'
      : meaningStatusOf(details.meaning);
    timings.push({ nodeId: node.id, source, ms });
    nodeLogs.push({
      nodeId: node.id,
      type: STORED_TYPE[node.type] ?? 'paragraph',
      originalText: node.text,
      source,
      variantUsed: details.variantUsed ?? null,
      modelCalls: nodeCalls,
      retries: Math.max(0, nodeCalls - 1),
      ms: Math.round(ms),
      candidates: details.candidates ?? [],
      meaningStatus,
      ...(details.meaning && { meaning: details.meaning }),
    });
    if (firstResultMs === null && source !== 'error') firstResultMs = now - runStart;
    console.log(`[Clarity] Node ${node.id} (${source}, meaning ${meaningStatus}) ${formatSeconds(ms)}`);
  }

  /** Last sentence of the previous node in document order, if it is done. */
  function contextFor(node: ContentNode): string {
    const i = docIndex.get(node.id) ?? 0;
    const previous = i > 0 ? plainById.get(simplifiable[i - 1].id) : undefined;
    return previous ? lastSentence(previous) : '';
  }

  /**
   * One model reply; `stream` forwards chunks to the UI. Null if aborted.
   * Counts the call against MAX_MODEL_CALLS_PER_NODE.
   */
  async function completeText(nodeId: string, userPrompt: string, stream: boolean): Promise<string | null> {
    if (nodeCalls >= MAX_MODEL_CALLS_PER_NODE) {
      throw new Error(`[Clarity] Model call limit (${MAX_MODEL_CALLS_PER_NODE}) reached for node ${nodeId}`);
    }
    nodeCalls++;
    const chunks = await llm.simplifyChunk(userPrompt);
    if (signal.aborted) return null;
    let fullText = '';
    for await (const chunk of chunks) {
      if (signal.aborted) return null;
      fullText += chunk;
      if (stream) callbacks.onNodeChunk(nodeId, fullText);
    }
    if (signal.aborted) return null;
    return stripThinkingArtifacts(fullText);
  }

  /**
   * all-minilm vectors of `texts`, embedding only those not in this node's
   * `memo`, in one request. A 404 turns the embedding model off for the run
   * (one notice) and is rethrown, like every other failure.
   */
  async function embedWith(memo: Map<string, number[]>, texts: string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter(t => !memo.has(t)))];
    if (missing.length > 0) {
      try {
        const vectors = await llm.embed(missing);
        if (vectors.length !== missing.length) {
          throw new Error(`Embedding returned ${vectors.length} vectors for ${missing.length} texts`);
        }
        missing.forEach((t, i) => memo.set(t, vectors[i]));
      } catch (err) {
        if (err instanceof OllamaHttpError && err.status === 404 && embedAvailable) {
          embedAvailable = false;
          console.log(`[Clarity] Embedding model ${EMBED_MODEL} not installed; similarity check skipped`);
          if (!signal.aborted) callbacks.onNotice(EMBED_MISSING_NOTICE);
        }
        throw err;
      }
    }
    return texts.map(t => memo.get(t) as number[]);
  }

  /** SBERT cosine of one version; null when unavailable (never throws). */
  async function similarityOf(
    nodeId: string,
    original: string,
    plain: string,
    memo: Map<string, number[]>,
  ): Promise<number | null> {
    if (!embedAvailable) return null;
    try {
      return (await checkMeaning(original, plain, texts => embedWith(memo, texts))).similarity;
    } catch (err) {
      if (!(err instanceof OllamaHttpError && err.status === 404)) {
        console.warn('[Clarity] Similarity check failed for node', nodeId, err);
      }
      return null;
    }
  }

  /** Turns NLI off for the rest of the run and tells the user once. */
  function disableNli(err: unknown) {
    if (!nliAvailable) return;
    nliAvailable = false;
    console.warn(`[Clarity] NLI model ${NLI_MODEL_ID} unavailable; meaning check falls back to SBERT + entities`, err);
    if (!signal.aborted) callbacks.onNotice(NLI_MISSING_NOTICE);
  }

  /** Version, requested NLI device and the page's WebGPU adapter state (once per run). */
  function getBenchContext(): Promise<BenchContext> {
    benchContext ??= (async () => ({
      version: extensionVersion(),
      webgpuAdapter: await hasWebGpuAdapter(),
      device: await getNliDevice().catch(() => 'auto' as const),
    }))();
    return benchContext;
  }

  /**
   * Loads the NLI module and model once per run and records the benchmark
   * (backend, speed). Null when NLI is unavailable (turned off, one notice).
   */
  function ensureNli(): Promise<NliModule | null> {
    nliReady ??= (async () => {
      let mod: NliModule;
      try {
        mod = nliModule ??= await import('../quality/nli');
      } catch (err) {
        disableNli(err);
        return null;
      }
      try {
        nliBench = await mod.prepareNli(mod.getNliClient(), await getBenchContext());
      } catch (err) {
        if (err instanceof mod.NliUnavailableError) {
          disableNli(err);
          return null;
        }
        // The model loaded but the benchmark failed: NLI still runs
        console.warn('[Clarity] NLI benchmark failed', err);
      }
      return mod;
    })();
    return nliReady;
  }

  /**
   * The mode this run uses. Auto decides from the stored benchmark when it
   * matches this setup, else loads the model and benchmarks it first.
   */
  async function resolveQualityMode(setting: QualityModeSetting): Promise<QualityDecision> {
    if (setting !== 'auto') return chooseQualityMode(setting, null);
    const ctx = await getBenchContext();
    const stored = await getNliBench().catch(() => null);
    if (stored && !isBenchStale(stored, ctx)) return chooseQualityMode('auto', evidenceOf(stored));
    await ensureNli();
    return chooseQualityMode('auto', nliBench ? evidenceOf(nliBench) : null);
  }

  /** Sentence-level NLI of one version; null when skipped or unavailable (never throws). */
  async function entailmentOf(
    nodeId: string,
    original: string,
    simplified: string,
    hinted: readonly string[],
    memo: Map<string, number[]>,
  ): Promise<EntailmentCheck | null> {
    if (lite || !nliAvailable || signal.aborted) return null;
    const mod = await ensureNli();
    if (!mod || !nliAvailable || signal.aborted) return null;
    try {
      const result = await mod.checkEntailment(original, simplified, hinted, mod.getNliClient(), {
        label: nodeId,
        ...(embedAvailable && { embed: (texts: string[]) => embedWith(memo, texts) }),
      });
      nliTimes.push(result.ms);
      nliPairs += result.pairs;
      truncatedPairs += result.truncatedPairs;
      console.log(
        `[Clarity] NLI ${nodeId}: ${result.sentences} sentences, ${result.pairs} pairs ` +
        `(${result.ranking} premises, ${result.cachedPairs} cached, ${result.truncatedPairs} truncated, ` +
        `${result.exemptedSentences.length} exempt) ${Math.round(result.ms)} ms ` +
        `(rank ${Math.round(result.rankMs)}, score ${Math.round(result.scoreMs)})`,
      );
      return result;
    } catch (err) {
      if (err instanceof mod.NliUnavailableError) disableNli(err);
      else console.warn('[Clarity] NLI check failed for node', nodeId, err);
      return null;
    }
  }

  /**
   * Entailment of the original's main claim by one version (nli.ts
   * checkMainClaim), for the combined score's mainClaim feature; null under
   * the same conditions as entailmentOf (never throws).
   */
  async function mainClaimEntailmentOf(
    nodeId: string,
    original: string,
    simplified: string,
    claim: readonly number[],
    memo: Map<string, number[]>,
  ): Promise<{ entailment: number; weakest: string | null } | null> {
    if (lite || !nliAvailable || signal.aborted) return null;
    const mod = await ensureNli();
    if (!mod || !nliAvailable || signal.aborted) return null;
    try {
      const result = await mod.checkMainClaim(original, simplified, claim, mod.getNliClient(), {
        label: nodeId,
        ...(embedAvailable && { embed: (texts: string[]) => embedWith(memo, texts) }),
      });
      nliPairs += result.pairs;
      console.log(`[Clarity] NLI ${nodeId} main claim: ${result.pairs} pairs, entailment ${result.entailment.toFixed(2)} ${Math.round(result.ms)} ms`);
      return result;
    } catch (err) {
      if (err instanceof mod.NliUnavailableError) disableNli(err);
      else console.warn('[Clarity] Main-claim check failed for node', nodeId, err);
      return null;
    }
  }

  /**
   * The original's main-claim sentences: all of a list item, else the one
   * closest to the whole paragraph by all-minilm (the vectors are in the
   * node's memo already: the original for SBERT, its sentences as premises).
   * Null without embeddings (assessMeaning then takes the first sentence).
   */
  async function mainClaimOf(
    node: ContentNode,
    original: string,
    sentences: readonly string[],
    memo: Map<string, number[]>,
  ): Promise<number[] | null> {
    if (node.type === 'list-item') return sentences.map((_, i) => i);
    if (sentences.length <= 2 || !embedAvailable) return null;
    try {
      const [paragraph, ...vecs] = await embedWith(memo, [original, ...sentences]);
      return mainClaimIndexes(sentences.length, { sentences: vecs, paragraph });
    } catch {
      return null;
    }
  }

  /** Thesis meaning assessment of one version of a checked node. */
  function assess(
    node: ContentNode,
    text: string,
    hinted: readonly string[],
    memo: Map<string, number[]>,
  ): Promise<MeaningAssessment> {
    return assessMeaning(node.text, text, node.entities ?? [], hinted, {
      similarity: (original, plain) => similarityOf(node.id, original, plain, memo),
      entail: (original, simplified, words) => entailmentOf(node.id, original, simplified, words, memo),
      mainClaim: (original, sentences) => mainClaimOf(node, original, sentences, memo),
      mainClaimEntailment: (original, simplified, claim) =>
        mainClaimEntailmentOf(node.id, original, simplified, claim, memo),
    }, { echoGuard: true });
  }

  /**
   * Generates one node with the model: 'standard' first, then either the
   * stage 6C retry or (extra quality) the other variants — see file header.
   * Null if aborted; throws if the first request fails.
   */
  async function generate(segmentedNode: ContentNode): Promise<Generated | null> {
    // NER only for nodes that reach the model (the segmenter doesn't run it).
    // Loaded on first use: compromise-dates would push this chunk past 500 kB.
    const entities = segmentedNode.entities
      ?? (await import('../segmentation/ner')).detectEntities(segmentedNode.text);
    const node: ContentNode = { ...segmentedNode, entities };
    const checked = shouldCheckNode(node);
    const difficultWords = doc.report ? findDifficultWords(node.text, entities, wordSet) : [];
    // The words the prompt names; the NLI glossary exemption uses the same list
    const hinted = hintedWords(spec, difficultWords);
    // Embeddings of this node's texts (original, its premises, every version)
    const vectors = new Map<string, number[]>();

    /** User prompt for a variant; falls back to the bare text without a report. */
    const promptFor = (variant: PromptVariantId): string =>
      doc.report
        ? buildPrompt(node, spec, doc.report, contextFor(node), difficultWords, variant).user
        : node.text;

    /** Checks (6C) and scores one version of the node. Null if aborted. */
    async function judge(
      text: string,
      variant: PromptVariantId,
      retryInstruction: boolean,
      started: number,
    ): Promise<Attempt | null> {
      const meaning = checked ? await assess(node, text, hinted, vectors) : null;
      if (signal.aborted) return null;
      const scores = scoreCandidate({ original: node.text, simplified: text, spec, wordSet, meaning });
      return { text, meaning, variant, scores, retryInstruction, ms: performance.now() - started };
    }

    /**
     * Generates, checks (6C) and scores one candidate. `retryFrom` (null for
     * a first attempt) is the failed assessment the retry instruction names.
     * Null if aborted.
     */
    async function attempt(
      variant: PromptVariantId,
      retryFrom: MeaningAssessment | null,
      stream: boolean,
    ): Promise<Attempt | null> {
      const started = performance.now();
      const prompt = promptFor(variant);
      const raw = await completeText(
        node.id,
        retryFrom === null ? prompt : `${buildRetryInstruction(retryInputOf(retryFrom))}\n\n${prompt}`,
        stream,
      );
      if (raw === null) return null;
      const text = variant === 'example-guided' ? stripExampleLabel(raw) : raw;
      return judge(text, variant, retryFrom !== null, started);
    }

    const first = await attempt('standard', null, true);
    if (first === null) return null;
    const tried: Attempt[] = [first];
    let chosen = first;

    if (checked) {
      const firstPasses = candidatePasses(first);
      const reasons = firstPasses ? null : first.meaning;
      if (extraQuality && (!firstPasses || first.scores.total < QUALITY_THRESHOLD)) {
        for (const variant of EXTRA_VARIANTS.slice(0, MAX_MODEL_CALLS_PER_NODE - 1)) {
          try {
            const next = await attempt(variant, reasons, false);
            if (next === null) return null;
            tried.push(next);
          } catch (err) {
            if (signal.aborted) return null;
            // The other candidates are still usable; don't fail the node
            console.warn(`[Clarity] Variant ${variant} failed for node`, node.id, err);
          }
        }
        chosen = pickBestCandidate(tried);
      } else if (!extraQuality && !firstPasses) {
        try {
          const retry = await attempt('standard', reasons, true);
          if (retry === null) return null;
          tried.push(retry);
          chosen = pickBetterVersion(first, retry);
        } catch (err) {
          if (signal.aborted) return null;
          // The first version is still usable; don't fail the node over the retry
          console.warn('[Clarity] Meaning retry failed for node', node.id, err);
        }
      }
    }

    // Last resort: every version echoed the prompt, so drop the echo lines
    // from the kept one and judge it again (no model call)
    if (chosen.meaning?.echo) {
      const echoContext = { original: node.text, entities };
      const stripped = stripEchoLines(chosen.text, echoContext);
      const finding = findEcho(stripped, echoContext);
      if (stripped !== '' && stripped !== chosen.text && finding.lines.length === 0 && !finding.instruction) {
        const cleaned = await judge(stripped, chosen.variant, chosen.retryInstruction, performance.now());
        if (cleaned === null) return null;
        console.log(`[Clarity] Node ${node.id}: removed echo lines from the kept version`);
        cleaned.echoStripped = true;
        tried.push(cleaned);
        chosen = cleaned;
      }
    }

    const candidates: CandidateLog[] = tried.map(t => ({
      variant: t.variant,
      retryInstruction: t.retryInstruction,
      chosen: t === chosen,
      ms: Math.round(t.ms),
      text: t.text,
      scores: roundScores(t.scores),
      missingEntities: t.meaning?.missingEntities ?? [],
      missingKeyEntities: t.meaning?.missingKeyEntities ?? [],
      reasons: t.meaning?.reasons ?? [],
      failures: t.meaning?.failures ?? [],
      nliChecked: t.meaning?.nliChecked ?? false,
      exemptedSentences: t.meaning?.exemptedSentences ?? [],
      exemptionRate: round4OrNull(t.meaning?.exemptionRate ?? null),
      nliMs: roundMs(t.meaning?.nliMs ?? null),
      nliRankMs: roundMs(t.meaning?.nliRankMs ?? null),
      nliScoreMs: roundMs(t.meaning?.nliScoreMs ?? null),
      ...(t.echoStripped && { echoStripped: true }),
    }));
    return { chosen, candidates };
  }

  /**
   * Cache lookup that never fails the node: a storage error counts as a miss.
   * A verdict that was not fully checked is a miss while both checks are
   * available, so the node gets the full thesis check this time.
   */
  async function lookupCache(key: string): Promise<CachedResult | null> {
    if (mode === 'all') return null;  // "Re-simplify all" asks for new text
    try {
      const cached = await getCached(key);
      if (cached?.meaning && !isFullyChecked(cached.meaning) && embedAvailable && nliAvailable && !lite) return null;
      return cached;
    } catch (err) {
      console.warn('[Clarity] Cache read failed', err);
      return null;
    }
  }

  // Quality mode: decided once, before the first node
  const decision = await resolveQualityMode(qualitySetting);
  lite = decision.mode === 'lite';
  console.log(`[Clarity] Quality mode ${decision.mode} (${decision.reason})`);
  if (lite && extraQuality) {
    extraQuality = false;
    console.log('[Clarity] Extra quality is off in Lite mode (no best-of-N)');
  }

  for (const node of rotateFrom(simplifiable, startIndex)) {
    if (signal.aborted) break;
    if (!runIds.has(node.id)) continue;  // already done ('remaining' mode)

    const nodeStartedAt = performance.now();
    nodeCalls = 0;
    const base = {
      nodeId: node.id,
      originalText: node.text,
      type: STORED_TYPE[node.type] ?? 'paragraph',
      level: node.level,
    };

    try {
      // a. Already at or below the target grade: keep the original
      if (isAlreadySimple(node.text, spec.targetGrade, wordSet)) {
        callbacks.onNodeDone(node.id, node.text, undefined, true);
        doneCount++;
        plainById.set(node.id, toPlainText(node.text));
        await persist({ ...base, simplifiedText: node.text, status: 'done', skipped: true });
        callbacks.onProgress(doneCount, toRun.length);
        finishNode(node, 'skipped', nodeStartedAt);
        continue;
      }

      // b. Cache, then c. the model
      const key = await cacheKey(node.text, spec, model, extraQuality ? 'extra' : 'standard');
      const cached = await lookupCache(key);
      let fullText: string;
      let stored: StoredMeaning | null;
      let source: NodeSource;
      let details: Parameters<typeof finishNode>[3];
      if (cached) {
        fullText = cached.text;
        stored = cached.meaning;
        source = 'cache';
        details = stored ? { meaning: roundMeaning(stored) } : {};
      } else {
        callbacks.onNodeStart(node.id);
        const generated = await generate(node);
        if (generated === null) break;
        const { chosen } = generated;
        fullText = chosen.text;
        stored = chosen.meaning ? storedMeaningOf(chosen.meaning, lite) : null;
        source = 'model';
        details = {
          variantUsed: chosen.variant,
          candidates: generated.candidates,
          ...(chosen.meaning && { meaning: meaningLog(chosen.meaning, lite) }),
        };
        if (chosen.meaning) {
          keptNliSentences += chosen.meaning.nliSentences;
          keptExempted += chosen.meaning.exemptedSentences.length;
        }
        // Unchecked versions (headings, short texts) pass too
        if (candidatePasses(chosen)) {
          await putCached(key, { text: fullText, meaning: stored })
            .catch(err => console.warn('[Clarity] Cache write failed', err));
        }
      }

      callbacks.onNodeDone(node.id, fullText, stored ?? undefined);
      doneCount++;
      // Metrics and rolling context use marker-free text (one sentence per
      // bullet); the raw text with markers is what gets stored and rendered.
      plainById.set(node.id, toPlainText(fullText));

      // Persist this node's result immediately
      await persist({ ...base, simplifiedText: fullText, status: 'done', ...stored });

      callbacks.onProgress(doneCount, toRun.length);
      finishNode(node, source, nodeStartedAt, details);

    } catch (err) {
      if (signal.aborted) break;
      console.error('[Clarity] Simplification error for node', node.id, err);
      callbacks.onNodeError(node.id);
      if (!firstError) firstError = classifyError(err, model);

      // Persist now: a failure after the last success would otherwise be lost
      await persist({ ...base, simplifiedText: '', status: 'error' });
      finishNode(node, 'error', nodeStartedAt);
    }
  }

  llm.destroy();

  const summary = summarizeRun(timings, performance.now() - runStart);
  // Assigned inside ensureNli, which TypeScript can't see from here
  const bench = nliBench as NliBenchRecord | null;
  const firstResult = firstResultMs === null ? 'n/a' : formatSeconds(firstResultMs);
  const meaning = {
    ...summarizeMeaning(nodeLogs.map(n => n.meaningStatus)),
    avgNliMs: nliTimes.length > 0 ? nliTimes.reduce((a, b) => a + b, 0) / nliTimes.length : null,
    exemptedSentences: keptExempted,
    exemptionRate: keptNliSentences > 0 ? keptExempted / keptNliSentences : null,
    nliPairs,
    truncatedPairs,
    failureBreakdown: failureBreakdown(
      nodeLogs
        .filter(n => n.meaningStatus === 'failed')
        .map(n => n.meaning?.failures ?? failuresFromReasons(n.meaning?.reasons ?? [])),
    ),
  };
  const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  console.log(
    `[Clarity] Run${signal.aborted ? ' (cancelled)' : ''}: ${summary.line}; ` +
    `first result after ${firstResult}; model ${model}` +
    `; quality ${decision.mode}${extraQuality ? ', extra quality' : ''}; ` +
    `meaning passed ${pct(meaning.passRate)} (${meaning.passed}/${meaning.passed + meaning.failed}), ` +
    `coverage ${pct(meaning.coverage)}; ` +
    `NLI avg ${meaning.avgNliMs === null ? 'n/a' : `${Math.round(meaning.avgNliMs)} ms`} per paragraph` +
    (bench
      ? ` (backend ${bench.backend}${bench.dtype === 'fp16' ? ' fp16' : ''}` +
        `${bench.adapterVendor ? ` ${bench.adapterVendor}` : ''})`
      : '') +
    `, truncated pairs ${truncatedPairs}/${nliPairs}`,
  );
  if (meaning.failureBreakdown.failedParagraphs > 0) {
    console.log(`[Clarity] Meaning failures: ${formatFailureBreakdown(meaning.failureBreakdown)}`);
  }
  if (meaning.coverage !== null && !meaning.thesisGrade) {
    console.warn(
      `[Clarity] Meaning coverage ${pct(meaning.coverage)} is below ${pct(THESIS_COVERAGE_MIN)}: ` +
      `the pass rate is not thesis-grade for this run`,
    );
  }
  // Info, not a warning: chrome://extensions → Errors stays for real errors
  if (meaning.avgNliMs !== null && meaning.avgNliMs > NLI_BUDGET_MS) {
    console.info(
      `[Clarity] NLI above budget: ${Math.round(meaning.avgNliMs)} ms per paragraph on average ` +
      `(budget ${NLI_BUDGET_MS} ms)`,
    );
  }

  const runLog: RunLog = {
    id: crypto.randomUUID(),
    startedAt,
    finishedAt: Date.now(),
    cancelled: signal.aborted,
    mode,
    model,
    // The effective value: Lite turns best-of-N off whatever the toggle says
    extraQuality,
    qualitySetting,
    qualityMode: decision.mode,
    qualityModeReason: decision.reason,
    nli: bench && {
      backend: bench.backend,
      adapterVendor: bench.adapterVendor,
      dtype: bench.dtype ?? 'q8',
      benchMs: Math.round(bench.ms),
      predictedParagraphMs: Math.round(bench.predictedParagraphMs),
    },
    targetGrade: spec.targetGrade,
    depthTier: spec.depthTier,
    qualityThreshold: QUALITY_THRESHOLD,
    weights: { ...WEIGHTS },
    meaningThresholds: {
      similarity: SIMILARITY_THRESHOLD,
      entailmentMin: ENTAILMENT_MIN,
      contradictionMax: CONTRADICTION_MAX,
      glossaryExemptionMaxRate: GLOSSARY_EXEMPTION_MAX_RATE,
      nliModel: NLI_MODEL_ID,
      premiseStrategy: PREMISE_STRATEGY,
      contradictionAggregation: NLI_CONTRADICTION_AGG,
      paragraphRule: NLI_PARAGRAPH_RULE,
      hypothesisContext: NLI_HYPOTHESIS_CONTEXT,
      entityRecallMin: ENTITY_RECALL_MIN,
      verdict: 'combined-score',
      scoreModels: { full: COMBINED_SCORE_FULL, lite: COMBINED_SCORE_LITE },
    },
    summary: {
      nodes: summary.nodes,
      counts: summary.counts,
      totalSeconds: round4(summary.totalSeconds),
      secondsPerNode: summary.secondsPerNode === null ? null : round4(summary.secondsPerNode),
      secondsPerModelNode: summary.secondsPerModelNode === null ? null : round4(summary.secondsPerModelNode),
      firstResultSeconds: firstResultMs === null ? null : round4(firstResultMs / 1000),
      meaning: {
        ...meaning,
        passRate: round4OrNull(meaning.passRate),
        coverage: round4OrNull(meaning.coverage),
        avgNliMs: meaning.avgNliMs === null ? null : Math.round(meaning.avgNliMs),
        exemptionRate: round4OrNull(meaning.exemptionRate),
      },
    },
    nodes: nodeLogs,
  };

  /** Appends the run log last, after any other save, through the doc queue. */
  const saveRunLog = () =>
    addRunLog(doc.id, runLog).catch(err => console.warn('[Clarity] Run log save failed', err));

  // Every node of the run finished (done or error); a cancel that arrives
  // during the last node's save doesn't undo a complete run
  const finishedAll = timings.length === toRun.length;

  // Show error banner for the first failure (if any)
  if (firstError && !signal.aborted) callbacks.onBannerError(firstError);

  // 6. Post-run: the simplified report (over stored + new results, in
  //    document order) whenever this run finished a node, also when
  //    cancelled, and a session when the run is complete. Each write is
  //    guarded, so one failure can't skip the other, the run log or
  //    onComplete.
  if (doneCount > 0) {
    const combinedText = simplifiable
      .map(n => plainById.get(n.id))
      .filter((t): t is string => !!t)
      .join('\n\n');
    const simplifiedReport = computeReadabilityReport(combinedText, wordSet);
    doc = { ...doc, simplifiedReport, lastRunAt: Date.now() };
    try {
      await saveDocument(doc);
    } catch (err) {
      console.error('[Clarity] Saving the simplified report failed', err);
    }
    if (!signal.aborted || finishedAll) {
      try {
        const sessions = await recordSession(spec.targetGrade);
        console.log(`[Clarity] Session recorded (${sessions} this week)`);
      } catch (err) {
        console.error('[Clarity] Recording the session failed', err);
      }
    }
  }

  await saveRunLog();
  callbacks.onComplete();
}
