/**
 * One simplification run at a time.
 *
 * The UK Wikipedia report (eval/fixtures/runs/uk-wiki-2026-10-19.json)
 * shows a cancelled run finishing after the next one had started: starting
 * a run aborted the old one but did not wait for it. The old run then still
 * saved its stale copy of the document (the simplified report) and its run
 * log between the new run's writes, and its onComplete marked the new run
 * inactive.
 *
 * Design decisions:
 *  - start(task) aborts the current run, then waits for the previous task
 *    to settle (its post-run saves included) before the new task begins.
 *    A task that was aborted before it began never starts, so of three
 *    quick starts the middle one never runs (and two starts in the same
 *    tick run only the second).
 *  - Each task gets its own AbortSignal; isCurrent(signal) tells the caller
 *    whether a callback still belongs to the run on screen.
 *  - A task's error never blocks the next task; it is rethrown to whoever
 *    awaited that start.
 *  - Pure (no chrome or React), so it is unit-tested in node; the hook
 *    (app/hooks/useRunState.ts) keeps one per app tab.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type RunTask = (signal: AbortSignal) => Promise<void>;

export interface RunSerializer {
  /** Aborts the current run, waits for it, then runs `task` unless it was aborted meanwhile. */
  start(task: RunTask): Promise<void>;
  /** Aborts the current run (it still finishes its own post-run saves). */
  cancel(): void;
  /** True when `signal` belongs to the latest run and it was not aborted. */
  isCurrent(signal: AbortSignal): boolean;
}

// ─── Serializer ───────────────────────────────────────────────────────────────

export function createRunSerializer(): RunSerializer {
  let controller: AbortController | null = null;
  let last: Promise<void> = Promise.resolve();

  return {
    start(task) {
      controller?.abort();
      const own = new AbortController();
      controller = own;
      const previous = last;
      const run = (async () => {
        await previous;
        if (own.signal.aborted) return;
        await task(own.signal);
      })();
      last = run.catch(() => {});
      return run;
    },
    cancel() {
      controller?.abort();
      controller = null;
    },
    isCurrent(signal) {
      return controller !== null && controller.signal === signal && !signal.aborted;
    },
  };
}
