import { describe, it, expect } from 'vitest';
import { formatSeconds, summarizeRun, type NodeTiming } from '../../src/lib/run/timing';

// ---------------------------------------------------------------------------
// summarizeRun — counts and averages for the [Clarity] run log
// ---------------------------------------------------------------------------
describe('summarizeRun', () => {
  const entries: NodeTiming[] = [
    { nodeId: 'n0', source: 'model', ms: 3000 },
    { nodeId: 'n1', source: 'model', ms: 1000 },
    { nodeId: 'n2', source: 'cache', ms: 5 },
    { nodeId: 'n3', source: 'skipped', ms: 1 },
    { nodeId: 'n4', source: 'error', ms: 200 },
  ];

  it('counts nodes by source', () => {
    expect(summarizeRun(entries, 5000).counts).toEqual({ model: 2, cache: 1, heading: 0, skipped: 1, error: 1 });
  });

  it('averages over every node and over model nodes only', () => {
    const summary = summarizeRun(entries, 5000);
    expect(summary.totalSeconds).toBe(5);
    expect(summary.secondsPerNode).toBe(1);
    expect(summary.secondsPerModelNode).toBe(2);
  });

  it('formats one line', () => {
    expect(summarizeRun(entries, 5000).line).toBe(
      '5 nodes in 5.00 s — 2 model, 1 cache, 0 headings, 1 skipped, 1 errors; 2.00 s/model node, 1.00 s/node',
    );
  });

  it('reports n/a when the model ran for no node', () => {
    const summary = summarizeRun([{ nodeId: 'n0', source: 'cache', ms: 4 }], 10);
    expect(summary.secondsPerModelNode).toBeNull();
    expect(summary.line).toContain('n/a/model node');
  });

  it('handles an empty run', () => {
    const summary = summarizeRun([], 0);
    expect(summary.nodes).toBe(0);
    expect(summary.secondsPerNode).toBeNull();
  });
});

describe('formatSeconds', () => {
  it('shows milliseconds as seconds with two decimals', () => {
    expect(formatSeconds(2312)).toBe('2.31 s');
  });
});
