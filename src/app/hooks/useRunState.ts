import { useState, useCallback, useRef } from 'react';
import { runSimplification, type RunCallbacks } from '../../lib/run/simplify';
import type { ClarityDocument } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LiveNodeState {
  text: string;
  status: 'pending' | 'streaming' | 'done' | 'error';
}

export interface RunState {
  docId: string;
  active: boolean;
  nodesDone: number;
  nodesTotal: number;
  errorBanner: string | null;
  liveResults: Record<string, LiveNodeState>;
}

export interface UseRunStateReturn {
  runState: RunState | null;
  startRun: (doc: ClarityDocument) => Promise<void>;
  cancelRun: () => void;
  dismissError: () => void;
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

  const startRun = useCallback(async (doc: ClarityDocument) => {
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

      onNodeDone: (nodeId, finalText) =>
        setRunState(prev => {
          if (!prev) return null;
          return {
            ...prev,
            liveResults: {
              ...prev.liveResults,
              [nodeId]: { text: finalText, status: 'done' },
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

      onComplete: () =>
        setRunState(prev => prev ? { ...prev, active: false } : null),
    };

    await runSimplification(doc, callbacks);
  }, []);

  const cancelRun = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunState(prev => prev ? { ...prev, active: false } : null);
  }, []);

  const dismissError = useCallback(() => {
    setRunState(prev => prev ? { ...prev, errorBanner: null } : null);
  }, []);

  return { runState, startRun, cancelRun, dismissError };
}
