import { useState, useCallback, useRef } from 'react';
// Type-only: the run module (and compromise, via NER and the entity check) is
// loaded on the first run, keeping it out of the main chunk.
import type { RunCallbacks } from '../../lib/run/simplify';
import { createRunSerializer, type RunSerializer } from '../../lib/run/run-serializer';
import { getDocument } from '../../lib/storage/documents';
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
 *
 * One run at a time (lib/run/run-serializer.ts): a new start cancels the
 * current run AND waits for it, post-run saves included, before the new run
 * reads the document again from storage (so 'remaining' sees what the
 * cancelled run saved) and writes anything. Callbacks of a run that is no
 * longer current are dropped, so a cancelled run can't mark the new one
 * inactive.
 */
export function useRunState(): UseRunStateReturn {
  const [runState, setRunState] = useState<RunState | null>(null);
  const serializerRef = useRef<RunSerializer | null>(null);
  serializerRef.current ??= createRunSerializer();

  const startRun = useCallback(async (doc: ClarityDocument, mode: RunMode, startIndex = 0) => {
    const serializer = serializerRef.current ?? createRunSerializer();

    setRunState({
      docId: doc.id,
      active: true,
      nodesDone: 0,
      nodesTotal: 0,
      errorBanner: null,
      notices: [],
      liveResults: {},
    });

    /** One run; its callbacks change state only while it is the current run. */
    const execute = async (signal: AbortSignal): Promise<void> => {
      const update = (fn: (prev: RunState | null) => RunState | null) => {
        if (serializer.isCurrent(signal)) setRunState(fn);
      };

      const callbacks: RunCallbacks = {
        signal,

        onProgress: (done, total) =>
          update(prev => prev ? { ...prev, nodesDone: done, nodesTotal: total } : null),

        onNodeStart: (nodeId) =>
          update(prev => prev && {
            ...prev,
            liveResults: { ...prev.liveResults, [nodeId]: { text: '', status: 'streaming' } },
          }),

        onNodeChunk: (nodeId, accumulated) =>
          update(prev => prev && {
            ...prev,
            liveResults: { ...prev.liveResults, [nodeId]: { text: accumulated, status: 'streaming' } },
          }),

        onNodeDone: (nodeId, finalText, meaning, skipped) =>
          update(prev => prev && {
            ...prev,
            liveResults: { ...prev.liveResults, [nodeId]: { text: finalText, status: 'done', meaning, skipped } },
          }),

        onNodeError: (nodeId) =>
          update(prev => prev && {
            ...prev,
            liveResults: { ...prev.liveResults, [nodeId]: { text: '', status: 'error' } },
          }),

        onBannerError: (message) =>
          update(prev => prev ? { ...prev, errorBanner: message } : null),

        onNotice: (message) =>
          update(prev =>
            prev && !prev.notices.includes(message) ? { ...prev, notices: [...prev.notices, message] } : prev,
          ),

        onComplete: () =>
          update(prev => prev ? { ...prev, active: false } : null),
      };

      // The previous run has settled: start from what is stored now
      const fresh = await getDocument(doc.id).catch(() => null);
      if (signal.aborted) return;
      const { runSimplification } = await import('../../lib/run/simplify');
      if (signal.aborted) return;
      await runSimplification(fresh ?? doc, callbacks, mode, startIndex);
    };

    try {
      await serializer.start(execute);
    } catch (err) {
      // The run never rejects by design; if it does, don't leave it "active"
      console.error('[Clarity] Simplification run failed', err);
      setRunState(prev => prev ? { ...prev, active: false, errorBanner: prev.errorBanner ?? String(err) } : null);
    }
  }, []);

  const cancelRun = useCallback(() => {
    serializerRef.current?.cancel();
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
