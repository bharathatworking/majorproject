import { describe, it, expect } from 'vitest';
import { createRunSerializer } from '../../src/lib/run/run-serializer';

/** Resolves after the current macrotask, so other promises get to run in between. */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * A fake run that writes `steps` entries to `log`, one per tick, like the run
 * loop's per-node saves. After an abort it stops, but still writes its
 * post-run entry (the simplified report and run log of a cancelled run).
 */
function fakeRun(name: string, log: string[], steps = 3) {
  return async (signal: AbortSignal) => {
    for (let i = 0; i < steps; i++) {
      if (signal.aborted) break;
      await tick();
      log.push(`${name}:node${i}`);
    }
    await tick();
    log.push(`${name}:post-run`);
  };
}

describe('createRunSerializer', () => {
  it('two quick starts never interleave writes: the first run finishes before the second writes', async () => {
    const s = createRunSerializer();
    const log: string[] = [];
    const a = s.start(fakeRun('A', log));
    await tick();
    const b = s.start(fakeRun('B', log));
    await Promise.all([a, b]);

    const lastA = log.lastIndexOf('A:post-run');
    const firstB = log.findIndex(e => e.startsWith('B:'));
    expect(lastA).toBeGreaterThanOrEqual(0);
    expect(firstB).toBeGreaterThan(lastA);
    // A was aborted after its first node: it saved no more nodes
    expect(log.filter(e => e.startsWith('A:node'))).toEqual(['A:node0']);
    expect(log.filter(e => e.startsWith('B:'))).toEqual(['B:node0', 'B:node1', 'B:node2', 'B:post-run']);
  });

  it('three quick starts: the middle run never starts', async () => {
    const s = createRunSerializer();
    const log: string[] = [];
    const a = s.start(fakeRun('A', log));
    await tick();
    const runs = [a, s.start(fakeRun('B', log)), s.start(fakeRun('C', log))];
    await Promise.all(runs);

    expect(log.some(e => e.startsWith('B:'))).toBe(false);
    expect(log.lastIndexOf('A:post-run')).toBeGreaterThanOrEqual(0);
    expect(log.findIndex(e => e.startsWith('C:'))).toBeGreaterThan(log.lastIndexOf('A:post-run'));
  });

  it('tells which signal is current, and cancel aborts it', async () => {
    const s = createRunSerializer();
    const signals: AbortSignal[] = [];
    const a = s.start(async signal => { signals.push(signal); await tick(); });
    await tick();
    expect(s.isCurrent(signals[0])).toBe(true);
    const b = s.start(async signal => { signals.push(signal); await tick(); });
    await a;
    await tick();
    expect(s.isCurrent(signals[0])).toBe(false);
    expect(s.isCurrent(signals[1])).toBe(true);
    s.cancel();
    expect(signals[1].aborted).toBe(true);
    expect(s.isCurrent(signals[1])).toBe(false);
    await b;
  });

  it('a failing run rejects its own start and does not block the next one', async () => {
    const s = createRunSerializer();
    const log: string[] = [];
    const failing = s.start(async () => { await tick(); throw new Error('boom'); });
    await tick();
    const next = s.start(fakeRun('B', log, 1));
    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(log).toEqual(['B:node0', 'B:post-run']);
  });
});
