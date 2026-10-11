/**
 * Core simplification run loop.
 *
 * Stateless — all React state lives in useRunState.ts. This module is a pure
 * async function that drives the LLM, persists results node-by-node, and calls
 * back into React via the callbacks object.
 *
 * Error handling:
 *   HTTP 403 → OLLAMA_ORIGINS not set
 *   HTTP 404 → model not pulled
 *   TypeError ("Failed to fetch") → Ollama not running
 *   All others → surfaced as-is
 */

import { OllamaProvider, OLLAMA_MODEL } from '../llm/ollama-provider';
import { resolveProfile } from '../profile/resolver';
import { buildPrompt } from '../prompt-builder/builder';
import { segmentHtml } from '../segmentation/segmenter';
import { getUserProfile } from '../storage/settings';
import { getCommonWordSet } from '../metrics/word-set';
import { computeReadabilityReport } from '../metrics/engine';
import { saveDocument } from '../storage/documents';
import { recordSession } from '../storage/progress';
import type { ClarityDocument, ContentNode, StoredResult } from '../../types';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RunCallbacks {
  onProgress: (nodesDone: number, nodesTotal: number) => void;
  onNodeStart:  (nodeId: string) => void;
  onNodeChunk:  (nodeId: string, accumulated: string) => void;
  onNodeDone:   (nodeId: string, finalText: string) => void;
  onNodeError:  (nodeId: string) => void;
  onBannerError: (message: string) => void;
  onComplete: () => void;
  signal: AbortSignal;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip any leaked <think>…</think> blocks (qwen3 residue — harmless no-op on qwen2.5). */
function stripThinkingArtifacts(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function classifyError(err: unknown): string {
  if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
    return "Can't reach Ollama at localhost:11434. Is it running?";
  }
  const status = (err as any)?.status as number | undefined;
  if (status === 403) {
    return (
      `Ollama refused the request (403). ` +
      `Set OLLAMA_ORIGINS to chrome-extension://${chrome.runtime.id} ` +
      `and fully restart Ollama. See README.md.`
    );
  }
  if (status === 404) {
    return `Model not found on Ollama. Run: ollama pull ${OLLAMA_MODEL}`;
  }
  return String(err);
}

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
): Promise<void> {
  const { signal } = callbacks;

  // 1. Normalize any 'streaming' results left over from a previous crashed run.
  if (doc.results.some(r => r.status === 'streaming')) {
    const normalized = doc.results.map(r =>
      r.status === 'streaming' ? { ...r, status: 'pending' as const } : r,
    );
    doc = { ...doc, results: normalized };
    await saveDocument(doc);
  }
  if (signal.aborted) return;

  // 2. Profile + word set (parallel fetch)
  const [profile, wordSet] = await Promise.all([getUserProfile(), getCommonWordSet()]);
  if (signal.aborted) return;

  const currentGrade = doc.report?.estimatedGradeLevel ?? 8;
  const spec = resolveProfile(profile, currentGrade);

  // 3. Segment into simplifiable nodes
  const segmented = segmentHtml(doc.html, doc.title, doc.contentHash);
  const simplifiable = segmented.nodes.filter(
    n => n.type !== 'table' && !n.skipSimplification && n.text.trim().length > 0,
  );

  if (simplifiable.length === 0) {
    callbacks.onComplete();
    return;
  }

  callbacks.onProgress(0, simplifiable.length);

  // 4. Bootstrap the LLM session with the first node's system prompt
  const llm = new OllamaProvider();
  const firstPromptObj = doc.report
    ? buildPrompt(simplifiable[0], spec, doc.report)
    : null;

  try {
    await llm.createBaseSession(firstPromptObj?.system ?? '');
  } catch (err) {
    if (!signal.aborted) callbacks.onBannerError(classifyError(err));
    return;
  }
  if (signal.aborted) { llm.destroy(); return; }

  // 5. Stream each node
  let previousContext = '';
  let doneCount = 0;
  const completedTexts: string[] = [];

  // Work from a mutable copy of results; we upsert per-node as we go
  const storedResults: StoredResult[] = [...doc.results];

  function upsertResult(result: StoredResult) {
    const idx = storedResults.findIndex(r => r.nodeId === result.nodeId);
    if (idx >= 0) storedResults[idx] = result;
    else storedResults.push(result);
  }

  let firstError: string | null = null;

  for (const node of simplifiable) {
    if (signal.aborted) break;

    callbacks.onNodeStart(node.id);

    // Use the report for grade context; fall back to empty report-like object if missing
    const promptObj = doc.report
      ? buildPrompt(node, spec, doc.report, previousContext)
      : { system: firstPromptObj?.system ?? '', user: node.text };

    try {
      const stream = await llm.simplifyChunk(promptObj.user);
      if (signal.aborted) break;

      let fullText = '';
      for await (const chunk of stream) {
        if (signal.aborted) break;
        fullText += chunk;
        callbacks.onNodeChunk(node.id, fullText);
      }
      if (signal.aborted) break;

      fullText = stripThinkingArtifacts(fullText);
      callbacks.onNodeDone(node.id, fullText);
      doneCount++;
      completedTexts.push(fullText);

      // Persist this node's result immediately
      const result: StoredResult = {
        nodeId: node.id,
        originalText: node.text,
        simplifiedText: fullText,
        status: 'done',
        type: STORED_TYPE[node.type] ?? 'paragraph',
        level: node.level,
      };
      upsertResult(result);
      doc = { ...doc, results: storedResults, lastRunAt: Date.now() };
      await saveDocument(doc);

      // Rolling context: last sentence of the simplified output
      const sentences = fullText.split(/(?<=[.!?])\s+/);
      previousContext = sentences[sentences.length - 1] ?? '';

      callbacks.onProgress(doneCount, simplifiable.length);

    } catch (err) {
      if (signal.aborted) break;
      console.error('[Clarity] Simplification error for node', node.id, err);
      callbacks.onNodeError(node.id);
      if (!firstError) firstError = classifyError(err);

      upsertResult({
        nodeId: node.id,
        originalText: node.text,
        simplifiedText: '',
        status: 'error',
        type: STORED_TYPE[node.type] ?? 'paragraph',
        level: node.level,
      });
    }
  }

  llm.destroy();
  if (signal.aborted) { callbacks.onComplete(); return; }

  // Show error banner for the first failure (if any)
  if (firstError) callbacks.onBannerError(firstError);

  // 6. Post-run: compute simplified report and record session (≥1 node done)
  if (doneCount > 0) {
    const combinedText = completedTexts.join('\n\n');
    const wordSet2 = await getCommonWordSet();
    const simplifiedReport = computeReadabilityReport(combinedText, wordSet2);
    doc = { ...doc, simplifiedReport, lastRunAt: Date.now() };
    await saveDocument(doc);
    await recordSession(spec.targetGrade);
  }

  callbacks.onComplete();
}
