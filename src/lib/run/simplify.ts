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
 *   2. Cache hit (lib/storage/cache.ts), keyed by node text + spec + model.
 *      'all' mode ("Re-simplify all") skips cache reads, since the user is
 *      asking for new text, but still writes. Only versions that pass the
 *      meaning and entity checks are cached.
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
 * Error handling:
 *   HTTP 403 → OLLAMA_ORIGINS not set
 *   HTTP 404 → model not pulled
 *   TypeError ("Failed to fetch") → Ollama not running
 *   All others → surfaced as-is
 */

import { EMBED_MODEL, OllamaHttpError, OllamaProvider } from '../llm/ollama-provider';
import { resolveProfile } from '../profile/resolver';
import { buildPrompt } from '../prompt-builder/builder';
import { segmentHtml, simplifiableNodes } from '../segmentation/segmenter';
import { getLlmModel, getUserProfile } from '../storage/settings';
import { getCommonWordSet } from '../metrics/word-set';
import { computeReadabilityReport } from '../metrics/engine';
import { findDifficultWords } from '../metrics/difficult-words';
import { isAlreadySimple } from '../metrics/node-grade';
import { saveDocument } from '../storage/documents';
import { cacheKey, getCached, putCached } from '../storage/cache';
import { recordSession } from '../storage/progress';
import { toPlainText } from '../render/format-output';
import {
  checkMeaning, findMissingEntities, MEANING_RETRY_INSTRUCTION, passesChecks,
  pickBetterVersion, shouldCheckNode,
} from '../quality/semantic';
import { formatSeconds, summarizeRun, type NodeSource, type NodeTiming } from './timing';
import type {
  CachedResult, ClarityDocument, ContentNode, MeaningCandidate, RunMode, StoredResult,
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

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runSimplification(
  doc: ClarityDocument,
  callbacks: RunCallbacks,
  mode: RunMode = 'remaining',
  startIndex = 0,
): Promise<void> {
  const { signal } = callbacks;
  const runStart = performance.now();

  // 1. Normalize any 'streaming' results left over from a previous crashed run.
  if (doc.results.some(r => r.status === 'streaming')) {
    const normalized = doc.results.map(r =>
      r.status === 'streaming' ? { ...r, status: 'pending' as const } : r,
    );
    doc = { ...doc, results: normalized };
    await saveDocument(doc);
  }
  if (signal.aborted) return;

  // 2. Profile + word set + model (parallel fetch)
  const [profile, wordSet, model] = await Promise.all([
    getUserProfile(), getCommonWordSet(), getLlmModel(),
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

  // Timing: logged per node, summarized after the loop
  const timings: NodeTiming[] = [];
  let firstResultMs: number | null = null;

  function recordTiming(nodeId: string, source: NodeSource, startedAt: number) {
    const now = performance.now();
    timings.push({ nodeId, source, ms: now - startedAt });
    if (firstResultMs === null && source !== 'error') firstResultMs = now - runStart;
    console.log(`[Clarity] Node ${nodeId} (${source}) ${formatSeconds(now - startedAt)}`);
  }

  /** Last sentence of the previous node in document order, if it is done. */
  function contextFor(node: ContentNode): string {
    const i = docIndex.get(node.id) ?? 0;
    const previous = i > 0 ? plainById.get(simplifiable[i - 1].id) : undefined;
    return previous ? lastSentence(previous) : '';
  }

  /** Streams one model reply, forwarding chunks to the UI; null if aborted. */
  async function streamText(nodeId: string, userPrompt: string): Promise<string | null> {
    const stream = await llm.simplifyChunk(userPrompt);
    if (signal.aborted) return null;
    let fullText = '';
    for await (const chunk of stream) {
      if (signal.aborted) return null;
      fullText += chunk;
      callbacks.onNodeChunk(nodeId, fullText);
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
   * Generates one node with the model: first attempt, stage 6C check, one
   * retry on failure. Null if aborted; throws if the first request fails.
   */
  async function generate(segmentedNode: ContentNode): Promise<MeaningCandidate | null> {
    // NER only for nodes that reach the model (the segmenter doesn't run it).
    // Loaded on first use: compromise-dates would push this chunk past 500 kB.
    const entities = segmentedNode.entities
      ?? (await import('../segmentation/ner')).detectEntities(segmentedNode.text);
    const node: ContentNode = { ...segmentedNode, entities };

    // Use the report for grade context; fall back to empty report-like object if missing
    const promptObj = doc.report
      ? buildPrompt(
          node, spec, doc.report, contextFor(node),
          findDifficultWords(node.text, entities, wordSet),
        )
      : { system: firstPromptObj?.system ?? '', user: node.text };

    const firstText = await streamText(node.id, promptObj.user);
    if (firstText === null) return null;

    // Stage 6C: meaning + entity check, one retry on failure
    if (!shouldCheckNode(node)) return { text: firstText, missingEntities: [] };

    const first = await assess(node, firstText);
    if (signal.aborted) return null;
    if (passesChecks(first)) return first;

    try {
      const retryText = await streamText(
        node.id, `${MEANING_RETRY_INSTRUCTION}\n\n${promptObj.user}`,
      );
      if (retryText === null) return null;
      const retry = await assess(node, retryText);
      if (signal.aborted) return null;
      return pickBetterVersion(first, retry);
    } catch (err) {
      if (signal.aborted) return null;
      // The first version is still usable; don't fail the node over the retry
      console.warn('[Clarity] Meaning retry failed for node', node.id, err);
      return first;
    }
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

    const startedAt = performance.now();
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
        recordTiming(node.id, 'skipped', startedAt);
        continue;
      }

      // b. Cache, then c. the model
      const key = await cacheKey(node.text, spec, model);
      const cached = await lookupCache(key);
      let chosen: MeaningCandidate;
      let source: NodeSource;
      if (cached) {
        chosen = { text: cached.text, similarity: cached.similarity, missingEntities: [] };
        source = 'cache';
      } else {
        callbacks.onNodeStart(node.id);
        const generated = await generate(node);
        if (generated === null) break;
        chosen = generated;
        source = 'model';
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
      recordTiming(node.id, source, startedAt);

    } catch (err) {
      if (signal.aborted) break;
      console.error('[Clarity] Simplification error for node', node.id, err);
      callbacks.onNodeError(node.id);
      if (!firstError) firstError = classifyError(err, model);

      // Persist now: a failure after the last success would otherwise be lost
      await persist({ ...base, simplifiedText: '', status: 'error' });
      recordTiming(node.id, 'error', startedAt);
    }
  }

  llm.destroy();

  const summary = summarizeRun(timings, performance.now() - runStart);
  const firstResult = firstResultMs === null ? 'n/a' : formatSeconds(firstResultMs);
  console.log(
    `[Clarity] Run${signal.aborted ? ' (cancelled)' : ''}: ${summary.line}; ` +
    `first result after ${firstResult}; model ${model}`,
  );

  if (signal.aborted) { callbacks.onComplete(); return; }

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

  callbacks.onComplete();
}
