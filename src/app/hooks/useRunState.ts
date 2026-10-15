import { useState, useCallback, useRef } from 'react';
// Type-only: the run module (and compromise, via NER and the entity check) is
// loaded on the first run, keeping it out of the main chunk.
import type { RunCallbacks } from '../../lib/run/simplify';
import type { ClarityDocument, RunMode, StoredMeaning } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LiveNodeState {
  text: string;
  status: 'pending' | 'streaming' | 'done' | 'error';
  /** Meaning check of the kept version, once done (if checked). */
  meaning?: StoredMeaning;
  /** Node was already simple; text is the original. */
  skipped?: boolean;
}

export interface RunState {
  docId: string;
  active: boolean;
  nodesDone: number;
  nodesTotal: number;
  errorBanner: string | null;
  /** Non-fatal info banners, deduplicated (e.g. embedding or NLI model missing). */
  notices: string[];
  liveResults: Record<string, LiveNodeState>;
}

export interface UseRunStateReturn {
  runState: RunState | null;
  /** `startIndex`: index of the first node to simplify (see runSimplification). */
  startRun: (doc: ClarityDocument, mode: RunMode, startIndex?: number) => Promise<void>;
  cancelRun: () => void;
  dismissError: () => void;
  dismissNotice: (message: string) => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Manages the active simplification run at the App level so that navigating
 * away from the Reading page doesn't interrupt the stream.
 *
 * `liveResults` holds per-node streaming state for the current run.
 * The Reading page merges these with the stored doc.results for display.
 */
export function useRunState(): UseRunStateReturn {
  const [runState, setRunState] = useState<RunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startRun = useCallback(async (doc: ClarityDocument, mode: RunMode, startIndex = 0) => {
    // Cancel any in-flight run before starting a new one
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunState({
      docId: doc.id,
      active: true,
      nodesDone: 0,
      nodesTotal: 0,
      errorBanner: null,
      notices: [],
      liveResults: {},
    });

    const callbacks: RunCallbacks = {
      signal: controller.signal,

      onProgress: (done, total) =>
        setRunState(prev => prev ? { ...prev, nodesDone: done, nodesTotal: total } : null),

      onNodeStart: (nodeId) =>
        setRunState(prev => {
          if (!prev) return null;
          return {
            ...prev,
            liveResults: { ...prev.liveResults, [nodeId]: { text: '', status: 'streaming' } },
          };
        }),

      onNodeChunk: (nodeId, accumulated) =>
        setRunState(prev => {
          if (!prev) return null;
          return {
            ...prev,
            liveResults: {
              ...prev.liveResults,
              [nodeId]: { text: accumulated, status: 'streaming' },
            },
          };
        }),

      onNodeDone: (nodeId, finalText, meaning, skipped) =>
        setRunState(prev => {
          if (!prev) return null;
          return {
            ...prev,
            liveResults: {
              ...prev.liveResults,
              [nodeId]: { text: finalText, status: 'done', meaning, skipped },
            },
          };
        }),

      onNodeError: (nodeId) =>
        setRunState(prev => {
          if (!prev) return null;
          return {
            ...prev,
            liveResults: {
              ...prev.liveResults,
              [nodeId]: { text: '', status: 'error' },
            },
          };
        }),

      onBannerError: (message) =>
        setRunState(prev => prev ? { ...prev, errorBanner: message } : null),

      onNotice: (message) =>
        setRunState(prev =>
          prev && !prev.notices.includes(message) ? { ...prev, notices: [...prev.notices, message] } : prev,
        ),

      onComplete: () =>
        setRunState(prev => prev ? { ...prev, active: false } : null),
    };

    const { runSimplification } = await import('../../lib/run/simplify');
    if (controller.signal.aborted) return;
    await runSimplification(doc, callbacks, mode, startIndex);
  }, []);

  const cancelRun = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunState(prev => prev ? { ...prev, active: false } : null);
  }, []);

  const dismissError = useCallback(() => {
    setRunState(prev => prev ? { ...prev, errorBanner: null } : null);
  }, []);

  const dismissNotice = useCallback((message: string) => {
    setRunState(prev => prev ? { ...prev, notices: prev.notices.filter(n => n !== message) } : null);
  }, []);

  return { runState, startRun, cancelRun, dismissError, dismissNotice };
}
