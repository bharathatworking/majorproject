/**
 * Promise-chain write queue for chrome.storage read-modify-write sequences.
 *
 * Each store module (documents.ts, cache.ts) owns one queue, so writes to its
 * keys never interleave their reads and writes. Queues of different modules
 * run independently: their keys don't overlap.
 */

// ─── Queue ────────────────────────────────────────────────────────────────────

export type Enqueue = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Returns an `enqueue` function. Each enqueued fn runs only after the previous
 * one settles; a rejection reaches its caller but never stops the queue.
 */
export function createWriteQueue(): Enqueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}
