import React, { useMemo, useState, useCallback } from 'react';
import { segmentHtml, simplifiableNodes } from '../../lib/segmentation/segmenter';
import { nestByDepth, parseSimplifiedText, type TreeItem } from '../../lib/render/format-output';
import { getHostname } from '../../lib/utils/url';
// run-log.ts has type-only imports; never import lib/quality/score.ts here
import { buildRunReport, runReportFileName } from '../../lib/run/run-log';
// similarity.ts, not semantic.ts or meaning.ts: those pull compromise into this chunk
import { meaningBadge } from '../../lib/quality/similarity';
import type {
  Block, ClarityDocument, ContentNode, StoredMeaning, StoredResult, DisplayPrefs, RunMode,
} from '../../types';
import type { RunState, LiveNodeState } from '../hooks/useRunState';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReadingProps {
  activeDoc: ClarityDocument | null;
  runState: RunState | null;
  displayPrefs: DisplayPrefs;
  /** `startIndex`: index in the simplifiable node list of the first node to run. */
  onStartRun: (doc: ClarityDocument, mode: RunMode, startIndex: number) => void;
  onCancelRun: () => void;
  onDismissError: () => void;
  onDismissNotice: (message: string) => void;
  onUpdatePrefs: (patch: Partial<DisplayPrefs>) => void;
}

type NodeGroup =
  | { kind: 'single'; node: ContentNode }
  /** Consecutive list items, nested by their depth (pasted Word sub-bullets). */
  | { kind: 'list'; items: TreeItem<ContentNode>[] };

interface NodeResult {
  text: string;
  status: 'pending' | 'streaming' | 'done' | 'error';
  meaning?: StoredMeaning;
  skipped?: boolean;
}

/** The meaning-check fields of a stored result. */
function storedMeaning(r: StoredResult): StoredMeaning {
  return {
    similarity: r.similarity,
    entityRecall: r.entityRecall,
    minEntailment: r.minEntailment,
    maxContradiction: r.maxContradiction,
    nliChecked: r.nliChecked,
    passed: r.passed,
    reasons: r.reasons,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Group consecutive list-item nodes so they render inside nested lists. */
function groupNodes(nodes: ContentNode[]): NodeGroup[] {
  const groups: NodeGroup[] = [];
  let listBuf: ContentNode[] = [];
  const flushList = () => {
    if (listBuf.length) groups.push({ kind: 'list', items: nestByDepth(listBuf, n => n.depth ?? 0) });
    listBuf = [];
  };

  for (const node of nodes) {
    if (node.type === 'list-item') {
      listBuf.push(node);
    } else {
      flushList();
      groups.push({ kind: 'single', node });
    }
  }
  flushList();
  return groups;
}

// Narrow literal unions (not keyof React.JSX.IntrinsicElements) so JSX can
// resolve the element's props when the tag is rendered dynamically.
type HeadingTag = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
const HEADING_TAGS: readonly HeadingTag[] = ['h2', 'h3', 'h4', 'h5', 'h6'];

function headingTag(level?: number): HeadingTag {
  const l = level ?? 2;
  return HEADING_TAGS[l - 2] ?? 'h2';
}

/**
 * Index of the first node whose element is at least partly in the viewport,
 * so a run starts with what the reader is looking at. Falls back to 0.
 */
function firstVisibleIndex(nodes: ContentNode[]): number {
  const viewportHeight = window.innerHeight;
  for (let i = 0; i < nodes.length; i++) {
    const el = document.querySelector(`[data-node-id="${nodes[i].id}"]`);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < viewportHeight) return i;
  }
  return 0;
}

/** Saves the document's run logs as a JSON file (stage 7 A/B evidence). */
function downloadRunReport(doc: ClarityDocument) {
  const json = JSON.stringify(buildRunReport(doc), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = runReportFileName(doc);
  link.click();
  // Revoke after the click has been handled, or the download can be cancelled
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ─── Reading page ─────────────────────────────────────────────────────────────

export function Reading({
  activeDoc, runState, displayPrefs, onStartRun, onCancelRun, onDismissError, onDismissNotice,
  onUpdatePrefs,
}: ReadingProps) {
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [hoveredId,  setHoveredId]   = useState<string | null>(null);
  const [focusedId,  setFocusedId]   = useState<string | null>(null);

  // ── Compute nodes once per doc ──────────────────────────────────────────────
  const nodes = useMemo<ContentNode[]>(() => {
    if (!activeDoc) return [];
    const seg = segmentHtml(activeDoc.html, activeDoc.title, activeDoc.contentHash);
    return simplifiableNodes(seg.nodes);
  }, [activeDoc?.id, activeDoc?.html]);

  const groups = useMemo(() => groupNodes(nodes), [nodes]);

  // ── Build stored result lookup ──────────────────────────────────────────────
  const storedById = useMemo<Map<string, StoredResult>>(() => {
    const m = new Map<string, StoredResult>();
    activeDoc?.results.forEach(r => m.set(r.nodeId, r));
    return m;
  }, [activeDoc?.results]);

  // ── Live run detection ──────────────────────────────────────────────────────
  const isLiveRun = !!(runState?.active && runState.docId === activeDoc?.id);
  const streamingId = isLiveRun
    ? Object.entries(runState!.liveResults).find(([, v]) => v.status === 'streaming')?.[0] ?? null
    : null;

  // Focus-mode "active" paragraph
  const activeParagraphId = hoveredId ?? focusedId ?? streamingId;

  // ── Result merger ───────────────────────────────────────────────────────────
  const getResult = useCallback((nodeId: string): NodeResult => {
    if (isLiveRun && runState!.liveResults[nodeId]) {
      const live: LiveNodeState = runState!.liveResults[nodeId];
      return { text: live.text, status: live.status, meaning: live.meaning, skipped: live.skipped };
    }
    const s = storedById.get(nodeId);
    if (s) return { text: s.simplifiedText, status: s.status, meaning: storedMeaning(s), skipped: s.skipped };
    return { text: '', status: 'pending' };
  }, [isLiveRun, runState, storedById]);

  // ── Nested list rendering (a sub-list goes inside its parent's <li>) ───────
  const renderNodeList = (items: TreeItem<ContentNode>[], key?: string): React.JSX.Element => {
    const ListTag: 'ol' | 'ul' = items[0]?.item.ordered ? 'ol' : 'ul';
    return (
      <ListTag key={key} className="reading-list">
        {items.map(({ item: node, children }) => (
          <li key={node.id}>
            <NodeBlock
              node={node}
              result={getResult(node.id)}
              isActive={activeParagraphId === node.id}
              isRevealed={revealedIds.has(node.id)}
              focusModeOn={displayPrefs.focusMode}
              onReveal={() => toggleReveal(node.id)}
              onHover={setHoveredId}
              onFocus={setFocusedId}
            />
            {children.length > 0 && renderNodeList(children)}
          </li>
        ))}
      </ListTag>
    );
  };

  // ── Reveal toggle ───────────────────────────────────────────────────────────
  const toggleReveal = useCallback((id: string) => {
    setRevealedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // ── Progress counts ─────────────────────────────────────────────────────────
  const doneCount = isLiveRun
    ? runState!.nodesDone
    : activeDoc?.results.filter(r => r.status === 'done').length ?? 0;
  const totalCount = isLiveRun
    ? runState!.nodesTotal
    : nodes.length;

  const hasAnyResults = (activeDoc?.results.filter(r => r.status === 'done').length ?? 0) > 0;
  // Nodes "Simplify again" would run: anything without a done result
  const remainingCount = nodes.filter(n => storedById.get(n.id)?.status !== 'done').length;

  const hostname = activeDoc?.sourceUrl ? getHostname(activeDoc.sourceUrl) : null;

  const startRun = (mode: RunMode) => {
    if (activeDoc) onStartRun(activeDoc, mode, firstVisibleIndex(nodes));
  };

  // ── Display class names ─────────────────────────────────────────────────────
  const contentClasses = [
    'reading-content',
    displayPrefs.dyslexiaFont ? 'dyslexia-font' : '',
    displayPrefs.textSize !== 'normal' ? `text-${displayPrefs.textSize}` : '',
    displayPrefs.focusMode ? 'focus-mode' : '',
  ].filter(Boolean).join(' ');

  // ── No document ─────────────────────────────────────────────────────────────
  if (!activeDoc) {
    return (
      <div className="page stub-page">
        <div className="stub-icon" aria-hidden="true">≡</div>
        <h2>No document selected</h2>
        <p>Go to Dashboard and capture a page, then return here to simplify it.</p>
      </div>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────────
  return (
    <div className="page reading-page">

      {/* ── Reading header ── */}
      <div className="reading-header">
        <div className="reading-title-row">
          <h1 className="reading-doc-title">{activeDoc.title}</h1>
          {activeDoc.source === 'page' && activeDoc.sourceUrl && hostname && (
            <a
              className="reading-source-link"
              href={activeDoc.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open original page"
            >
              ↗ {hostname}
            </a>
          )}
        </div>

        {/* Display toggles */}
        <div className="display-toggles">
          <button
            className={`toggle-btn ${displayPrefs.dyslexiaFont ? 'active' : ''}`}
            onClick={() => onUpdatePrefs({ dyslexiaFont: !displayPrefs.dyslexiaFont })}
            title="Toggle dyslexia-friendly font"
          >Aa</button>
          <button
            className={`toggle-btn ${displayPrefs.textSize === 'large' ? 'active' : ''}`}
            onClick={() => onUpdatePrefs({ textSize: displayPrefs.textSize === 'large' ? 'normal' : 'large' })}
            title="Toggle large text"
          >A+</button>
          <button
            className={`toggle-btn ${displayPrefs.focusMode ? 'active' : ''}`}
            onClick={() => onUpdatePrefs({ focusMode: !displayPrefs.focusMode })}
            title="Toggle focus mode"
          >◎</button>
        </div>

        {/* Run controls */}
        <div className="run-controls">
          {isLiveRun ? (
            <>
              <span className="run-progress">
                <span className="spinner" aria-hidden="true" />
                {doneCount} / {totalCount} paragraphs
              </span>
              <button className="btn-secondary" onClick={onCancelRun}>Cancel</button>
            </>
          ) : (
            <>
              {totalCount > 0 && doneCount > 0 && (
                <span className="run-progress-done">{doneCount} / {totalCount} simplified</span>
              )}
              <button
                className="btn-primary"
                onClick={() => startRun('remaining')}
                disabled={!activeDoc.report || (hasAnyResults && remainingCount === 0)}
                title={
                  !activeDoc.report ? 'Waiting for readability analysis…'
                  : hasAnyResults && remainingCount === 0 ? 'All paragraphs are simplified'
                  : hasAnyResults ? 'Simplify only pending and failed paragraphs'
                  : undefined
                }
              >
                {hasAnyResults ? 'Simplify again' : 'Simplify now'}
              </button>
              {hasAnyResults && (
                <button
                  className="btn-secondary"
                  onClick={() => startRun('all')}
                  disabled={!activeDoc.report}
                  title="Simplify every paragraph again, replacing current results"
                >
                  Re-simplify all
                </button>
              )}
              {(activeDoc.runLogs?.length ?? 0) > 0 && (
                <button
                  className="btn-secondary"
                  onClick={() => downloadRunReport(activeDoc)}
                  title="Per paragraph: prompt variant, quality scores, retries and time for the last runs"
                >
                  Download run report (JSON)
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Error banner ── */}
      {runState?.errorBanner && (
        <div className="banner banner-error">
          <span>{runState.errorBanner}</span>
          <button className="banner-dismiss" onClick={onDismissError} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* ── Notice banners (non-fatal, e.g. embedding or NLI model missing) ── */}
      {runState && runState.docId === activeDoc.id && runState.notices.map(notice => (
        <div key={notice} className="banner banner-info" role="status">
          <span>{notice}</span>
          <button className="banner-dismiss" onClick={() => onDismissNotice(notice)} aria-label="Dismiss">×</button>
        </div>
      ))}

      {/* ── Reading column ── */}
      <div className={contentClasses}>
        {groups.map((group, gi) => {
          if (group.kind === 'list') return renderNodeList(group.items, `list-${gi}`);

          const { node } = group;
          const result = getResult(node.id);

          if (node.type === 'heading') {
            const Tag = headingTag(node.level);
            // Headings show simplified text inline or original while pending
            const display = result.status !== 'pending' ? (result.text || node.text) : node.text;
            return (
              <Tag key={node.id} data-node-id={node.id} className={`reading-heading ${result.status === 'streaming' ? 'streaming' : ''}`}>
                {display}
                {result.status === 'streaming' && <span className="caret" aria-hidden="true" />}
              </Tag>
            );
          }

          return (
            <NodeBlock
              key={node.id}
              node={node}
              result={result}
              isActive={activeParagraphId === node.id}
              isRevealed={revealedIds.has(node.id)}
              focusModeOn={displayPrefs.focusMode}
              onReveal={() => toggleReveal(node.id)}
              onHover={setHoveredId}
              onFocus={setFocusedId}
            />
          );
        })}

        {nodes.length === 0 && (
          <p className="reading-empty">No readable content found in this document.</p>
        )}
      </div>
    </div>
  );
}

// ─── NodeBlock ────────────────────────────────────────────────────────────────

interface NodeBlockProps {
  node: ContentNode;
  result: NodeResult;
  isActive: boolean;
  isRevealed: boolean;
  focusModeOn: boolean;
  onReveal: () => void;
  onHover: (id: string | null) => void;
  onFocus: (id: string | null) => void;
}

function NodeBlock({
  node, result, isActive, isRevealed, focusModeOn, onReveal, onHover, onFocus,
}: NodeBlockProps) {
  const isDone      = result.status === 'done';
  const isSkipped   = isDone && !!result.skipped;
  // Already-simple nodes show the original, so there is nothing to reveal
  const canReveal   = isDone && !isSkipped;
  const isStreaming = result.status === 'streaming';
  const isError     = result.status === 'error';
  const isPending   = result.status === 'pending';

  const dimmed = focusModeOn && !isActive;

  const wrapperClass = [
    'node-block',
    isStreaming ? 'node-streaming' : '',
    isDone      ? 'node-done'      : '',
    isSkipped   ? 'node-skipped'   : '',
    isError     ? 'node-error'     : '',
    dimmed      ? 'node-dimmed'    : '',
  ].filter(Boolean).join(' ');

  // A <div> rather than <p>: simplified output can contain <ul>/<ol>, which
  // is invalid inside a paragraph.
  const Tag: 'blockquote' | 'div' =
    node.type === 'blockquote' ? 'blockquote' : 'div';

  // Re-parsed on every streamed chunk; cheap (linear in a single node's text)
  const blocks = useMemo(() => parseSimplifiedText(result.text), [result.text]);
  const badge = isDone && result.meaning ? meaningBadge(result.meaning) : null;

  return (
    <div
      className={wrapperClass}
      data-node-id={node.id}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onFocus(node.id)}
      onBlur={() => onFocus(null)}
    >
      {/* Simplified text (or original while pending / on error) */}
      <Tag
        className={`node-text ${canReveal || isStreaming ? 'clickable' : ''}`}
        role={canReveal ? 'button' : undefined}
        tabIndex={canReveal ? 0 : undefined}
        aria-expanded={canReveal ? isRevealed : undefined}
        aria-label={canReveal ? 'Click to show original text' : undefined}
        onClick={canReveal ? onReveal : undefined}
        onKeyDown={canReveal ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReveal(); } } : undefined}
      >
        {isPending && <p className="node-para node-original-text">{node.text}</p>}
        {(isStreaming || isDone) && (
          blocks.length > 0
            ? <FormattedBlocks blocks={blocks} showCaret={isStreaming} />
            : (
              <p className="node-para">
                {node.text}
                {isStreaming && <span className="caret" aria-hidden="true" />}
              </p>
            )
        )}
        {isError && (
          <p className="node-para">
            <span className="error-tag" aria-label="Simplification failed">⚠ failed</span>
            {node.text}
          </p>
        )}
      </Tag>

      {/* Meaning-check verdict; CSS shows it on hover/focus */}
      {badge && (
        <span className={`meaning-badge ${badge.warn ? 'meaning-low' : ''}`} title={badge.title}>
          {badge.label}
        </span>
      )}

      {/* Kept as is: already at or below the target grade */}
      {isSkipped && (
        <span className="simple-badge" title="Already at or below your target grade, so it was kept as is">
          already simple
        </span>
      )}

      {/* Click-to-reveal original */}
      {canReveal && isRevealed && (
        <div className="original-reveal" aria-label="Original text">
          <div className="original-label">Original</div>
          <p className="original-text">{node.text}</p>
        </div>
      )}
    </div>
  );
}

// ─── FormattedBlocks ──────────────────────────────────────────────────────────

/**
 * Renders parsed model output as real React elements (never innerHTML).
 * The streaming caret goes inside the last block so it trails the newest text.
 */
function FormattedBlocks({ blocks, showCaret }: { blocks: Block[]; showCaret: boolean }) {
  const caret = <span className="caret" aria-hidden="true" />;
  const lastBlock = blocks.length - 1;

  return (
    <>
      {blocks.map((block, bi) => {
        const isLastBlock = bi === lastBlock;

        if (block.kind === 'paragraph') {
          return (
            <p key={bi} className="node-para">
              {block.text}
              {showCaret && isLastBlock && caret}
            </p>
          );
        }

        // Sub-lists render as <ul>: only top-level items say whether a list is ordered
        const lastItem = block.items.length - 1;
        const renderItems = (items: TreeItem<string>[], ordered: boolean, key?: number): React.JSX.Element => {
          const ListTag: 'ol' | 'ul' = ordered ? 'ol' : 'ul';
          return (
            <ListTag key={key} className="node-list">
              {items.map(({ item, index, children }) => (
                <li key={index}>
                  {item}
                  {showCaret && isLastBlock && index === lastItem && caret}
                  {children.length > 0 && renderItems(children, false)}
                </li>
              ))}
            </ListTag>
          );
        };
        return renderItems(nestByDepth(block.items, (_, i) => block.depths?.[i] ?? 0), block.ordered, bi);
      })}
    </>
  );
}
