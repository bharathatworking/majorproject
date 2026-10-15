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
 * Semantic preservation (stage 6C, lib/quality/semantic.ts): each finished
 * node that passes shouldCheckNode is scored for meaning (embedding cosine
 * vs the original) and for dropped entities. A failing node is retried once
 * with MEANING_RETRY_INSTRUCTION and the better version is kept; its
 * similarity is stored on the result. The check never fails a run: a missing
 * embedding model (404) shows one notice and disables the meaning score for
 * the rest of the run, other embed errors skip it for that node, and a failed
 * retry keeps the first version.
 *
 * Prompt optimization (stage 7, lib/quality/score.ts and
 * lib/prompt-builder/variants.ts): every model output is scored with
 * scoreCandidate (meaning 0.5, readability 0.3, length 0.2).
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
 * Run log: every node, and every candidate's variant, scores and time, goes
 * into a RunLog that addRunLog appends to the document at the end of the run
 * (also when cancelled), for the run report download in Reading.
 *
 * Error handling:
 *   HTTP 403 → OLLAMA_ORIGINS not set
 *   HTTP 404 → model not pulled
 *   TypeError ("Failed to fetch") → Ollama not running
 *   All others → surfaced as-is
 */

import { EMBED_MODEL, OllamaHttpError, OllamaProvider } from '../llm/ollama-provider';
import { resolveProfile } from '../profile/resolver';
import { buildPrompt } from '../prompt-builder/builder';
import { EXTRA_VARIANTS, stripExampleLabel } from '../prompt-builder/variants';
import { segmentHtml, simplifiableNodes } from '../segmentation/segmenter';
import { getExtraQuality, getLlmModel, getUserProfile } from '../storage/settings';
import { getCommonWordSet } from '../metrics/word-set';
import { computeReadabilityReport } from '../metrics/engine';
import { findDifficultWords } from '../metrics/difficult-words';
import { isAlreadySimple } from '../metrics/node-grade';
import { addRunLog, saveDocument } from '../storage/documents';
import { cacheKey, getCached, putCached } from '../storage/cache';
import { recordSession } from '../storage/progress';
import { toPlainText } from '../render/format-output';
import {
  checkMeaning, findMissingEntities, MEANING_RETRY_INSTRUCTION, passesChecks,
  pickBetterVersion, shouldCheckNode,
} from '../quality/semantic';
import {
  MAX_MODEL_CALLS_PER_NODE, pickBestCandidate, QUALITY_THRESHOLD, scoreCandidate, WEIGHTS,
  type ScoredCandidate,
} from '../quality/score';
import { formatSeconds, summarizeRun, type NodeTiming } from './timing';
import type {
  CachedResult, CandidateLog, CandidateScores, ClarityDocument, ContentNode, MeaningCandidate,
  NodeRunLog, NodeSource, PromptVariantId, RunLog, RunMode, StoredResult,
} from '../../types';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RunCallbacks {
  onProgress: (nodesDone: number, nodesTotal: number) => void;
  onNodeStart:  (nodeId: string) => void;
  onNodeChunk:  (nodeId: string, accumulated: string) => void;
  /**
   * `similarity` is set when the meaning check scored the kept version;
   * `skipped` when the node was already simple and kept as is.
   */
  onNodeDone:   (nodeId: string, finalText: string, similarity?: number, skipped?: boolean) => void;
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

function roundScores(s: CandidateScores): CandidateScores {
  return {
    gradeGap: round4(s.gradeGap),
    similarity: s.similarity === null ? null : round4(s.similarity),
    entityRecall: round4(s.entityRecall),
    lengthRatio: round4(s.lengthRatio),
    total: round4(s.total),
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
    return `Model not found on Ollama. Run: ollama pull ${model}`;
  }
  return String(err);
}

/** Shown once per run when the embedding model is missing (HTTP 404). */
export const EMBED_MISSING_NOTICE = `Install the meaning checker: ollama pull ${EMBED_MODEL}`;

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

  // 2. Profile + word set + model + quality mode (parallel fetch)
  const [profile, wordSet, model, extraQuality] = await Promise.all([
    getUserProfile(), getCommonWordSet(), getLlmModel(), getExtraQuality(),
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

  // Meaning check: per-run flag, turned off after the first 404 from /api/embed
  let embedAvailable = true;

  // Timing and run log: recorded per node, summarized after the loop
  const timings: NodeTiming[] = [];
  const nodeLogs: NodeRunLog[] = [];
  let firstResultMs: number | null = null;
  // Model calls made for the current node (reset per node; read on errors too)
  let nodeCalls = 0;

  function finishNode(
    node: ContentNode,
    source: NodeSource,
    nodeStartedAt: number,
    details: Partial<Pick<NodeRunLog, 'variantUsed' | 'candidates' | 'similarity'>> = {},
  ) {
    const now = performance.now();
    const ms = now - nodeStartedAt;
    timings.push({ nodeId: node.id, source, ms });
    nodeLogs.push({
      nodeId: node.id,
      type: STORED_TYPE[node.type] ?? 'paragraph',
      source,
      variantUsed: details.variantUsed ?? null,
      modelCalls: nodeCalls,
      retries: Math.max(0, nodeCalls - 1),
      ms: Math.round(ms),
      candidates: details.candidates ?? [],
      ...(details.similarity !== undefined && { similarity: round4(details.similarity) }),
    });
    if (firstResultMs === null && source !== 'error') firstResultMs = now - runStart;
    console.log(`[Clarity] Node ${node.id} (${source}) ${formatSeconds(ms)}`);
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

  /** Scores one version of a node; never throws for embedding failures. */
  async function assess(node: ContentNode, text: string): Promise<MeaningCandidate> {
    const plainText = toPlainText(text);
    const candidate: MeaningCandidate = {
      text,
      missingEntities: findMissingEntities(node.entities ?? [], plainText),
    };
    if (!embedAvailable) return candidate;
    try {
      const { similarity } = await checkMeaning(node.text, plainText, texts => llm.embed(texts));
      candidate.similarity = similarity;
    } catch (err) {
      if (err instanceof OllamaHttpError && err.status === 404) {
        embedAvailable = false;
        console.log(`[Clarity] Embedding model ${EMBED_MODEL} not installed; meaning check skipped`);
        if (!signal.aborted) callbacks.onNotice(EMBED_MISSING_NOTICE);
      } else {
        console.warn('[Clarity] Meaning check failed for node', node.id, err);
      }
    }
    return candidate;
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

    /** User prompt for a variant; falls back to the bare text without a report. */
    const promptFor = (variant: PromptVariantId): string =>
      doc.report
        ? buildPrompt(node, spec, doc.report, contextFor(node), difficultWords, variant).user
        : node.text;

    /** Generates, checks (6C) and scores one candidate. Null if aborted. */
    async function attempt(
      variant: PromptVariantId,
      retryInstruction: boolean,
      stream: boolean,
    ): Promise<Attempt | null> {
      const started = performance.now();
      const prompt = promptFor(variant);
      const raw = await completeText(
        node.id, retryInstruction ? `${MEANING_RETRY_INSTRUCTION}\n\n${prompt}` : prompt, stream,
      );
      if (raw === null) return null;
      const text = variant === 'example-guided' ? stripExampleLabel(raw) : raw;
      const meaning: MeaningCandidate = checked
        ? await assess(node, text)
        : { text, missingEntities: [] };
      if (signal.aborted) return null;
      const scores = scoreCandidate({
        original: node.text,
        simplified: text,
        spec,
        wordSet,
        similarity: meaning.similarity,
        entityCount: checked ? entities.length : 0,
        missingEntityCount: meaning.missingEntities.length,
      });
      return { ...meaning, variant, scores, retryInstruction, ms: performance.now() - started };
    }

    const first = await attempt('standard', false, true);
    if (first === null) return null;
    const tried: Attempt[] = [first];
    let chosen = first;

    if (checked) {
      const firstPasses = passesChecks(first);
      if (extraQuality && (!firstPasses || first.scores.total < QUALITY_THRESHOLD)) {
        for (const variant of EXTRA_VARIANTS.slice(0, MAX_MODEL_CALLS_PER_NODE - 1)) {
          try {
            const next = await attempt(variant, !firstPasses, false);
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
          const retry = await attempt('standard', true, true);
          if (retry === null) return null;
          tried.push(retry);
          chosen = pickBetterVersion(first, retry) === retry ? retry : first;
        } catch (err) {
          if (signal.aborted) return null;
          // The first version is still usable; don't fail the node over the retry
          console.warn('[Clarity] Meaning retry failed for node', node.id, err);
        }
      }
    }

    const candidates: CandidateLog[] = tried.map(t => ({
      variant: t.variant,
      retryInstruction: t.retryInstruction,
      chosen: t === chosen,
      ms: Math.round(t.ms),
      scores: roundScores(t.scores),
      missingEntities: t.missingEntities,
    }));
    return { chosen, candidates };
  }

  /** Cache lookup that never fails the node: a storage error counts as a miss. */
  async function lookupCache(key: string): Promise<CachedResult | null> {
    if (mode === 'all') return null;  // "Re-simplify all" asks for new text
    try {
      return await getCached(key);
    } catch (err) {
      console.warn('[Clarity] Cache read failed', err);
      return null;
    }
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
      let chosen: MeaningCandidate;
      let source: NodeSource;
      let details: Parameters<typeof finishNode>[3];
      if (cached) {
        chosen = { text: cached.text, similarity: cached.similarity, missingEntities: [] };
        source = 'cache';
        details = { similarity: cached.similarity };
      } else {
        callbacks.onNodeStart(node.id);
        const generated = await generate(node);
        if (generated === null) break;
        chosen = generated.chosen;
        source = 'model';
        details = { variantUsed: generated.chosen.variant, candidates: generated.candidates };
        // Unchecked versions pass too (no similarity, no missing entities)
        if (passesChecks(chosen)) {
          await putCached(key, {
            text: chosen.text,
            ...(chosen.similarity !== undefined && { similarity: chosen.similarity }),
          }).catch(err => console.warn('[Clarity] Cache write failed', err));
        }
      }

      const fullText = chosen.text;
      callbacks.onNodeDone(node.id, fullText, chosen.similarity);
      doneCount++;
      // Metrics and rolling context use marker-free text (one sentence per
      // bullet); the raw text with markers is what gets stored and rendered.
      plainById.set(node.id, toPlainText(fullText));

      // Persist this node's result immediately
      await persist({
        ...base,
        simplifiedText: fullText,
        status: 'done',
        ...(chosen.similarity !== undefined && { similarity: chosen.similarity }),
      });

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
  const firstResult = firstResultMs === null ? 'n/a' : formatSeconds(firstResultMs);
  console.log(
    `[Clarity] Run${signal.aborted ? ' (cancelled)' : ''}: ${summary.line}; ` +
    `first result after ${firstResult}; model ${model}` +
    `${extraQuality ? '; extra quality' : ''}`,
  );

  const runLog: RunLog = {
    id: crypto.randomUUID(),
    startedAt,
    finishedAt: Date.now(),
    cancelled: signal.aborted,
    mode,
    model,
    extraQuality,
    targetGrade: spec.targetGrade,
    depthTier: spec.depthTier,
    qualityThreshold: QUALITY_THRESHOLD,
    weights: { ...WEIGHTS },
    summary: {
      nodes: summary.nodes,
      counts: summary.counts,
      totalSeconds: round4(summary.totalSeconds),
      secondsPerNode: summary.secondsPerNode === null ? null : round4(summary.secondsPerNode),
      secondsPerModelNode: summary.secondsPerModelNode === null ? null : round4(summary.secondsPerModelNode),
      firstResultSeconds: firstResultMs === null ? null : round4(firstResultMs / 1000),
    },
    nodes: nodeLogs,
  };

  /** Appends the run log last, after any other save, through the doc queue. */
  const saveRunLog = () =>
    addRunLog(doc.id, runLog).catch(err => console.warn('[Clarity] Run log save failed', err));

  if (signal.aborted) {
    await saveRunLog();
    callbacks.onComplete();
    return;
  }

  // Show error banner for the first failure (if any)
  if (firstError) callbacks.onBannerError(firstError);

  // 6. Post-run: compute simplified report (over stored + new results, in
  //    document order) and record session, if this run finished any node
  if (doneCount > 0) {
    const combinedText = simplifiable
      .map(n => plainById.get(n.id))
      .filter((t): t is string => !!t)
      .join('\n\n');
    const simplifiedReport = computeReadabilityReport(combinedText, wordSet);
    doc = { ...doc, simplifiedReport, lastRunAt: Date.now() };
    await saveDocument(doc);
    await recordSession(spec.targetGrade);
  }

  await saveRunLog();
  callbacks.onComplete();
}
