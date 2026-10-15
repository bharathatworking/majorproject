import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  checkEntailment, createWorkerBackend, NliClient, NliUnavailableError, splitSentences,
  type NliBackend, type NliPair, type NliProbs, type NliRequest, type NliResponse, type WorkerLike,
} from '../../src/lib/quality/nli';
import { CONTRADICTION_MAX, ENTAILMENT_MIN } from '../../src/lib/quality/config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SUPPORTED: NliProbs = { entailment: 0.95, contradiction: 0.01, neutral: 0.04 };
const NEUTRAL: NliProbs = { entailment: 0.1, contradiction: 0.05, neutral: 0.85 };
const CONTRADICTED: NliProbs = { entailment: 0.01, contradiction: 0.97, neutral: 0.02 };

/** Fake backend: probabilities per hypothesis (default SUPPORTED), recording every batch. */
function fakeBackend(table: Record<string, NliProbs> = {}) {
  const batches: NliPair[][] = [];
  const backend: NliBackend = {
    score: vi.fn(async (pairs: NliPair[]) => {
      batches.push(pairs);
      return pairs.map(p => table[p.hypothesis] ?? SUPPORTED);
    }),
  };
  return { backend, batches };
}

const ORIGINAL = 'The Treaty of Versailles was signed in 1919. It ended the war.';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// splitSentences
// ---------------------------------------------------------------------------
describe('splitSentences', () => {
  it('splits after . ! and ? followed by whitespace', () => {
    expect(splitSentences('One. Two! Three? Four')).toEqual(['One.', 'Two!', 'Three?', 'Four']);
  });

  it('treats every bullet item as its own sentence, without the marker', () => {
    expect(splitSentences('Plants need:\n- water\n- light')).toEqual(['Plants need:', 'water.', 'light.']);
  });

  it('drops empty pieces and trims', () => {
    expect(splitSentences('  One.   \n\n  Two.  ')).toEqual(['One.', 'Two.']);
    expect(splitSentences('')).toEqual([]);
  });

  it('keeps decimals and abbreviations without a following space together', () => {
    expect(splitSentences('It cost 3.5 dollars. Then it rose.')).toEqual(['It cost 3.5 dollars.', 'Then it rose.']);
  });
});

// ---------------------------------------------------------------------------
// NliClient — batching and cache
// ---------------------------------------------------------------------------
describe('NliClient', () => {
  it('batches pairs by the batch size, in order', async () => {
    const { backend, batches } = fakeBackend();
    const client = new NliClient(backend, 2);
    const pairs = ['a.', 'b.', 'c.'].map(h => ({ premise: 'p', hypothesis: h }));
    const { probs, cached } = await client.scorePairs(pairs);
    expect(batches.map(b => b.map(p => p.hypothesis))).toEqual([['a.', 'b.'], ['c.']]);
    expect(probs).toHaveLength(3);
    expect(cached).toBe(0);
  });

  it('answers repeated pairs from the cache without calling the worker', async () => {
    const { backend } = fakeBackend({ 'b.': NEUTRAL });
    const client = new NliClient(backend);
    const pairs = ['a.', 'b.'].map(h => ({ premise: 'p', hypothesis: h }));
    await client.scorePairs(pairs);
    const second = await client.scorePairs(pairs);
    expect(backend.score).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(2);
    expect(second.probs[1]).toEqual(NEUTRAL);
  });

  it('keys the cache by premise and hypothesis', async () => {
    const { backend } = fakeBackend();
    const client = new NliClient(backend);
    await client.scorePairs([{ premise: 'p1', hypothesis: 'h.' }]);
    await client.scorePairs([{ premise: 'p2', hypothesis: 'h.' }]);
    expect(backend.score).toHaveBeenCalledTimes(2);
  });

  it('scores a duplicated pair once', async () => {
    const { backend, batches } = fakeBackend();
    await new NliClient(backend).scorePairs([{ premise: 'p', hypothesis: 'h.' }, { premise: 'p', hypothesis: 'h.' }]);
    expect(batches).toEqual([[{ premise: 'p', hypothesis: 'h.' }]]);
  });

  it('evicts the least recently used pair past the cap', async () => {
    const { backend } = fakeBackend();
    const client = new NliClient(backend, 8, 2);
    const pair = (h: string) => [{ premise: 'p', hypothesis: h }];
    await client.scorePairs(pair('a.'));
    await client.scorePairs(pair('b.'));
    await client.scorePairs(pair('a.'));  // a is now most recent
    await client.scorePairs(pair('c.'));  // evicts b
    expect((await client.scorePairs(pair('a.'))).cached).toBe(1);
    expect((await client.scorePairs(pair('b.'))).cached).toBe(0);
  });

  it('throws when the backend returns the wrong number of scores', async () => {
    const client = new NliClient({ score: async () => [] });
    await expect(client.scorePairs([{ premise: 'p', hypothesis: 'h.' }])).rejects.toThrow(/0 scores for 1/);
  });
});

// ---------------------------------------------------------------------------
// checkEntailment — per-sentence verdicts
// ---------------------------------------------------------------------------
describe('checkEntailment', () => {
  it('uses the original paragraph as premise and each sentence as hypothesis', async () => {
    const { backend, batches } = fakeBackend();
    await checkEntailment(ORIGINAL, 'It was signed in 1919. It ended the war.', [], new NliClient(backend));
    expect(batches[0]).toEqual([
      { premise: ORIGINAL, hypothesis: 'It was signed in 1919.' },
      { premise: ORIGINAL, hypothesis: 'It ended the war.' },
    ]);
  });

  it('reports the lowest entailment, the highest contradiction and the failing sentences', async () => {
    const { backend } = fakeBackend({ 'It was signed in 1945.': CONTRADICTED, 'France was happy.': NEUTRAL });
    const r = await checkEntailment(
      ORIGINAL, 'It was signed in 1945. It ended the war. France was happy.', [], new NliClient(backend),
    );
    expect(r.minEntailment).toBeCloseTo(0.01);
    expect(r.maxContradiction).toBeCloseTo(0.97);
    expect(r.contradictedSentences).toEqual(['It was signed in 1945.']);
    expect(r.unsupportedSentences).toEqual(['It was signed in 1945.', 'France was happy.']);
    expect(r.sentences).toBe(3);
  });

  it('passes the thresholds for supported sentences', async () => {
    const r = await checkEntailment(ORIGINAL, 'It ended the war.', [], new NliClient(fakeBackend().backend));
    expect(r.minEntailment).toBeGreaterThanOrEqual(ENTAILMENT_MIN);
    expect(r.maxContradiction).toBeLessThanOrEqual(CONTRADICTION_MAX);
    expect(r.unsupportedSentences).toEqual([]);
  });

  it('exempts a glossary sentence from entailment but not from contradiction', async () => {
    const def = 'Reparations means money paid for damage.';
    const text = `${def} It ended the war. It was signed in 1919. Germany paid.`;
    const neutral = await checkEntailment(ORIGINAL, text, ['reparations'], new NliClient(fakeBackend({ [def]: NEUTRAL }).backend));
    expect(neutral.exemptedSentences).toEqual([def]);
    expect(neutral.exemptionRate).toBeCloseTo(0.25);
    expect(neutral.unsupportedSentences).toEqual([]);
    expect(neutral.minEntailment).toBeCloseTo(0.95);

    const contradicted = await checkEntailment(
      ORIGINAL, text, ['reparations'], new NliClient(fakeBackend({ [def]: CONTRADICTED }).backend),
    );
    expect(contradicted.exemptedSentences).toEqual([def]);
    expect(contradicted.contradictedSentences).toEqual([def]);
    expect(contradicted.maxContradiction).toBeCloseTo(0.97);
  });

  it('checks a definition of a word that was not hinted normally', async () => {
    const def = 'Reparations means money paid for damage.';
    const r = await checkEntailment(
      ORIGINAL, `${def} It ended the war. It was signed in 1919. Germany paid.`, ['treaty'],
      new NliClient(fakeBackend({ [def]: NEUTRAL }).backend),
    );
    expect(r.exemptedSentences).toEqual([]);
    expect(r.unsupportedSentences).toEqual([def]);
  });

  it('removes a parenthetical definition before scoring', async () => {
    const { backend, batches } = fakeBackend();
    await checkEntailment(ORIGINAL, 'Germany paid reparations (money for damage).', ['reparations'], new NliClient(backend));
    expect(batches[0][0].hypothesis).toBe('Germany paid reparations.');
  });

  it('returns zero entailment for an empty output without calling the model', async () => {
    const { backend } = fakeBackend();
    const r = await checkEntailment(ORIGINAL, '   ', [], new NliClient(backend));
    expect(r).toMatchObject({ sentences: 0, minEntailment: 0, unsupportedSentences: [] });
    expect(backend.score).not.toHaveBeenCalled();
  });

  it('logs every exemption with the [Clarity] prefix', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const def = 'Reparations means money paid for damage.';
    await checkEntailment(
      ORIGINAL, `${def} It ended the war. It was signed in 1919. Germany paid.`, ['reparations'],
      new NliClient(fakeBackend().backend), { label: 'n3' },
    );
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[Clarity\] NLI n3 glossary exemption .*Reparations means/));
  });
});

// ---------------------------------------------------------------------------
// createWorkerBackend — load, score, failures
// ---------------------------------------------------------------------------

/** Fake worker that answers like nli.worker.ts, or as `behaviour` says. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<NliResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  received: NliRequest[] = [];

  constructor(private readonly behaviour: 'ok' | 'init-error' | 'silent' | 'score-error' = 'ok') {}

  postMessage(message: NliRequest) {
    this.received.push(message);
    const reply = (data: NliResponse) => queueMicrotask(() => this.onmessage?.({ data } as MessageEvent<NliResponse>));
    if (this.behaviour === 'silent') return;
    if (message.type === 'init') {
      reply(this.behaviour === 'init-error'
        ? { type: 'init-error', message: 'NLI model failed to load: 404 config.json' }
        : { type: 'ready', loadMs: 5 });
    } else if (this.behaviour === 'score-error') {
      reply({ type: 'score-error', id: message.id, message: 'boom' });
    } else {
      reply({ type: 'scores', id: message.id, probs: message.pairs.map(() => SUPPORTED) });
    }
  }

  terminate() { this.terminated = true; }
}

const URLS = { modelUrl: 'chrome-extension://x/models/', wasmUrl: 'chrome-extension://x/ort/' };

describe('createWorkerBackend', () => {
  it('loads the model once with the local URLs, then scores', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const worker = new FakeWorker();
    const create = vi.fn(() => worker);
    const backend = createWorkerBackend(create, URLS);
    await backend.score([{ premise: 'p', hypothesis: 'h.' }]);
    const probs = await backend.score([{ premise: 'p', hypothesis: 'h2.' }]);
    expect(probs).toEqual([SUPPORTED]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(worker.received[0]).toMatchObject({ type: 'init', ...URLS, modelId: 'Xenova/nli-deberta-v3-xsmall' });
  });

  it('throws NliUnavailableError when the model fails to load, and retries on the next call', async () => {
    const workers = [new FakeWorker('init-error'), new FakeWorker('ok')];
    const create = vi.fn(() => workers.shift() as FakeWorker);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const backend = createWorkerBackend(create, URLS);

    await expect(backend.score([{ premise: 'p', hypothesis: 'h.' }])).rejects.toBeInstanceOf(NliUnavailableError);
    await expect(backend.score([{ premise: 'p', hypothesis: 'h.' }])).resolves.toEqual([SUPPORTED]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('throws NliUnavailableError when the worker cannot be created', async () => {
    const backend = createWorkerBackend(() => { throw new Error('blocked by CSP'); }, URLS);
    await expect(backend.score([{ premise: 'p', hypothesis: 'h.' }])).rejects.toThrow(/could not start/);
  });

  it('times out a model that never loads and terminates its worker', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker('silent');
    const backend = createWorkerBackend(() => worker, { ...URLS, loadTimeoutMs: 1000 });
    const pending = backend.score([{ premise: 'p', hypothesis: 'h.' }]);
    const assertion = expect(pending).rejects.toBeInstanceOf(NliUnavailableError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(worker.terminated).toBe(true);
  });

  it('rejects a failed scoring request with a plain Error (not unavailable)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const backend = createWorkerBackend(() => new FakeWorker('score-error'), URLS);
    const err = await backend.score([{ premise: 'p', hypothesis: 'h.' }]).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NliUnavailableError);
    expect(String(err)).toMatch(/boom/);
  });

  it('treats a worker crash as unavailable', async () => {
    const worker = new FakeWorker('silent');
    const backend = createWorkerBackend(() => worker, URLS);
    const pending = backend.score([{ premise: 'p', hypothesis: 'h.' }]);
    worker.onerror?.({ message: 'wasm compile blocked' } as ErrorEvent);
    await expect(pending).rejects.toThrow(/crashed: wasm compile blocked/);
  });
});
