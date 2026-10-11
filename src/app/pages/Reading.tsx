import React, { useMemo, useState, useCallback } from 'react';
import { segmentHtml } from '../../lib/segmentation/segmenter';
import type { ClarityDocument, ContentNode, StoredResult, DisplayPrefs } from '../../types';
import type { RunState, LiveNodeState } from '../hooks/useRunState';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReadingProps {
  activeDoc: ClarityDocument | null;
  runState: RunState | null;
  displayPrefs: DisplayPrefs;
  onStartRun: (doc: ClarityDocument) => void;
  onCancelRun: () => void;
  onDismissError: () => void;
  onUpdatePrefs: (patch: Partial<DisplayPrefs>) => void;
}

type NodeGroup =
  | { kind: 'single'; node: ContentNode }
  | { kind: 'list'; items: ContentNode[] };

interface NodeResult {
  text: string;
  status: 'pending' | 'streaming' | 'done' | 'error';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Group consecutive list-item nodes so they render inside a <ul>. */
function groupNodes(nodes: ContentNode[]): NodeGroup[] {
  const groups: NodeGroup[] = [];
  let listBuf: ContentNode[] = [];

  for (const node of nodes) {
    if (node.type === 'list-item') {
      listBuf.push(node);
    } else {
      if (listBuf.length) { groups.push({ kind: 'list', items: [...listBuf] }); listBuf = []; }
      groups.push({ kind: 'single', node });
    }
  }
  if (listBuf.length) groups.push({ kind: 'list', items: listBuf });
  return groups;
}

function headingTag(level?: number): keyof JSX.IntrinsicElements {
  const l = level ?? 2;
  return (['h2', 'h3', 'h4', 'h5', 'h6'][l - 2] ?? 'h2') as keyof JSX.IntrinsicElements;
}

// ─── Reading page ─────────────────────────────────────────────────────────────

export function Reading({
  activeDoc, runState, displayPrefs, onStartRun, onCancelRun, onDismissError, onUpdatePrefs,
}: ReadingProps) {
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [hoveredId,  setHoveredId]   = useState<string | null>(null);
  const [focusedId,  setFocusedId]   = useState<string | null>(null);

  // ── Compute nodes once per doc ──────────────────────────────────────────────
  const nodes = useMemo<ContentNode[]>(() => {
    if (!activeDoc) return [];
    const seg = segmentHtml(activeDoc.html, activeDoc.title, activeDoc.contentHash);
    return seg.nodes.filter(
      n => n.type !== 'table' && !n.skipSimplification && n.text.trim().length > 0,
    );
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
      return { text: live.text, status: live.status };
    }
    const s = storedById.get(nodeId);
    if (s) return { text: s.simplifiedText, status: s.status };
    return { text: '', status: 'pending' };
  }, [isLiveRun, runState, storedById]);

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
          {activeDoc.source === 'page' && activeDoc.sourceUrl && (
            <a
              className="reading-source-link"
              href={activeDoc.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open original page"
            >
              ↗ {new URL(activeDoc.sourceUrl).hostname}
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
                onClick={() => onStartRun(activeDoc)}
                disabled={!activeDoc.report}
                title={!activeDoc.report ? 'Waiting for readability analysis…' : undefined}
              >
                {hasAnyResults ? 'Simplify again' : 'Simplify now'}
              </button>
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

      {/* ── Reading column ── */}
      <div className={contentClasses}>
        {groups.map((group, gi) => {
          if (group.kind === 'list') {
            return (
              <ul key={`list-${gi}`} className="reading-list">
                {group.items.map(node => {
                  const result = getResult(node.id);
                  return (
                    <li key={node.id}>
                      <NodeBlock
                        node={node}
                        result={result}
                        isActive={activeParagraphId === node.id}
                        isRevealed={revealedIds.has(node.id)}
                        focusModeOn={displayPrefs.focusMode}
                        onReveal={() => toggleReveal(node.id)}
                        onHover={setHoveredId}
                        onFocus={setFocusedId}
                      />
                    </li>
                  );
                })}
              </ul>
            );
          }

          const { node } = group;
          const result = getResult(node.id);

          if (node.type === 'heading') {
            const Tag = headingTag(node.level);
            // Headings show simplified text inline or original while pending
            const display = result.status !== 'pending' ? (result.text || node.text) : node.text;
            return (
              <Tag key={node.id} className={`reading-heading ${result.status === 'streaming' ? 'streaming' : ''}`}>
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
  const isStreaming = result.status === 'streaming';
  const isError     = result.status === 'error';
  const isPending   = result.status === 'pending';

  const dimmed = focusModeOn && !isActive;

  const wrapperClass = [
    'node-block',
    isStreaming ? 'node-streaming' : '',
    isDone      ? 'node-done'      : '',
    isError     ? 'node-error'     : '',
    dimmed      ? 'node-dimmed'    : '',
  ].filter(Boolean).join(' ');

  const Tag: keyof JSX.IntrinsicElements =
    node.type === 'blockquote' ? 'blockquote' : 'p';

  return (
    <div
      className={wrapperClass}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onFocus(node.id)}
      onBlur={() => onFocus(null)}
    >
      {/* Simplified text (or original while pending / on error) */}
      <Tag
        className={`node-text ${isDone || isStreaming ? 'clickable' : ''}`}
        role={isDone ? 'button' : undefined}
        tabIndex={isDone ? 0 : undefined}
        aria-expanded={isDone ? isRevealed : undefined}
        aria-label={isDone ? 'Click to show original text' : undefined}
        onClick={isDone ? onReveal : undefined}
        onKeyDown={isDone ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReveal(); } } : undefined}
      >
        {isPending && <span className="node-original-text">{node.text}</span>}
        {(isStreaming || isDone) && (result.text || node.text)}
        {isStreaming && <span className="caret" aria-hidden="true" />}
        {isError && (
          <>
            <span className="error-tag" aria-label="Simplification failed">⚠ failed</span>
            {node.text}
          </>
        )}
      </Tag>

      {/* Click-to-reveal original */}
      {isDone && isRevealed && (
        <div className="original-reveal" aria-label="Original text">
          <div className="original-label">Original</div>
          <p className="original-text">{node.text}</p>
        </div>
      )}
    </div>
  );
}
