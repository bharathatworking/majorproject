import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  checkEntailment, createWorkerBackend, hypothesisFor, needsContext, NLI_BENCH_PAIRS, NliClient,
  NliUnavailableError, prepareNli,
  splitSentences, type BenchStore, type NliBackend, type NliPair, type NliProbs, type NliRequest,
  type NliResponse, type WorkerLike,
} from '../../src/lib/quality/nli';
import {
  CONTRADICTION_MAX, ENTAILMENT_MIN, NLI_CONTRADICTION_AGG, NLI_TOP_PREMISES,
} from '../../src/lib/quality/config';
import type { NliBackendName, NliBenchRecord, NliDtype } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SUPPORTED: NliProbs = { entailment: 0.95, contradiction: 0.01, neutral: 0.04 };
const NEUTRAL: NliProbs = { entailment: 0.1, contradiction: 0.05, neutral: 0.85 };
const CONTRADICTED: NliProbs = { entailment: 0.01, contradiction: 0.97, neutral: 0.02 };

/**
 * Fake backend: probabilities per sentence (default SUPPORTED), recording
 * every batch. A hypothesis with context ("<previous> <sentence>") is looked
 * up by the sentence it ends with.
 */
function fakeBackend(table: Record<string, NliProbs> = {}) {
  const batches: NliPair[][] = [];
  const lookup = (hypothesis: string) =>
    table[hypothesis] ?? Object.entries(table).find(([k]) => hypothesis.endsWith(` ${k}`))?.[1] ?? SUPPORTED;
  const backend: NliBackend = {
    score: vi.fn(async (pairs: NliPair[]) => {
      batches.push(pairs);
      return pairs.map(p => lookup(p.hypothesis));
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

  it.each([['webgpu', 32], ['wasm', 8]] as [NliBackendName, number][])(
    'batches %s pairs by %i (the backend it loaded on)',
    async (backendName, size) => {
      const { backend, batches } = fakeBackend();
      backend.load = vi.fn(async () => ({ backend: backendName, adapter: null, loadMs: 0 }));
      const client = new NliClient(backend);
      const pairs = Array.from({ length: 40 }, (_, i) => ({ premise: 'p', hypothesis: `h${i}.` }));
      await client.scorePairs(pairs);
      expect(backend.load).toHaveBeenCalledTimes(1);
      expect(batches.map(b => b.length)).toEqual(
        Array.from({ length: Math.ceil(40 / size) }, (_, i) => Math.min(size, 40 - i * size)),
      );
      expect(client.currentBatchSize).toBe(size);
    },
  );

  it('uses the wasm batch size for a backend without load()', async () => {
    const { backend, batches } = fakeBackend();
    await new NliClient(backend).scorePairs(Array.from({ length: 9 }, (_, i) => ({ premise: 'p', hypothesis: `h${i}.` })));
    expect(batches.map(b => b.length)).toEqual([8, 1]);
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
  const S0 = 'The Treaty of Versailles was signed in 1919.';
  const S1 = 'It ended the war.';

  it('scores each sentence against the original sentences and their 2-sentence window, in one call', async () => {
    const { backend, batches } = fakeBackend();
    const r = await checkEntailment(
      ORIGINAL, 'The treaty was signed in the year 1919. The treaty finally ended the long war.', [], new NliClient(backend),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      { premise: S0, hypothesis: 'The treaty was signed in the year 1919.' },
      { premise: S1, hypothesis: 'The treaty was signed in the year 1919.' },
      { premise: `${S0} ${S1}`, hypothesis: 'The treaty was signed in the year 1919.' },
      { premise: S0, hypothesis: 'The treaty finally ended the long war.' },
      { premise: S1, hypothesis: 'The treaty finally ended the long war.' },
      { premise: `${S0} ${S1}`, hypothesis: 'The treaty finally ended the long war.' },
    ]);
    expect(r).toMatchObject({ pairs: 6, ranking: 'all', truncatedPairs: 0 });
  });

  it('takes the best entailment over the premises, and contradiction per NLI_CONTRADICTION_AGG', async () => {
    const hyp = 'It was signed in 1919.';
    const byPremise: Record<string, NliProbs> = {
      [S0]: SUPPORTED,
      [S1]: { entailment: 0.05, contradiction: 0.3, neutral: 0.65 },
      [`${S0} ${S1}`]: NEUTRAL,
    };
    const backend: NliBackend = { score: async pairs => pairs.map(p => byPremise[p.premise]) };
    const r = await checkEntailment(ORIGINAL, hyp, [], new NliClient(backend));
    expect(r.minEntailment).toBeCloseTo(0.95);
    expect(r.unsupportedSentences).toEqual([]);
    if (NLI_CONTRADICTION_AGG === 'best-entailing') {
      // The contradiction of S0, which entails it best; S1's 0.3 is ignored
      expect(r.maxContradiction).toBeCloseTo(0.01);
      expect(r.contradictedSentences).toEqual([]);
    } else {
      expect(r.maxContradiction).toBeCloseTo(0.3);
      expect(r.contradictedSentences).toEqual([hyp]);
    }
  });

  it('still fails a sentence whose best-entailing premise contradicts it', async () => {
    const hyp = 'It was signed in 1945.';
    const backend: NliBackend = {
      score: async pairs => pairs.map(p => (p.premise === S0
        ? { entailment: 0.1, contradiction: 0.95, neutral: 0.05 }
        : { entailment: 0.02, contradiction: 0.1, neutral: 0.88 })),
    };
    const r = await checkEntailment(ORIGINAL, hyp, [], new NliClient(backend));
    expect(r.contradictedSentences).toEqual([hyp]);
    expect(r.unsupportedSentences).toEqual([hyp]);
  });

  const LONG = 'Alpha founded the city. Beta built a bridge. Gamma wrote a poem.';

  it('prunes to the top premises by embedding similarity', async () => {
    const { backend, batches } = fakeBackend();
    // Premises: Alpha, Beta, Gamma, Alpha+Beta, Beta+Gamma; the hypothesis is most like Gamma
    const vectors: Record<string, number[]> = {
      'Alpha founded the city.': [1, 0, 0],
      'Beta built a bridge.': [0, 1, 0],
      'Gamma wrote a poem.': [0, 0, 1],
      'Alpha founded the city. Beta built a bridge.': [0.7, 0.7, 0],
      'Beta built a bridge. Gamma wrote a poem.': [0, 0.6, 0.8],
      'Gamma wrote a poem about it.': [0, 0.1, 1],
    };
    const embed = vi.fn(async (texts: string[]) => texts.map(t => vectors[t]));
    const r = await checkEntailment(LONG, 'Gamma wrote a poem about it.', [], new NliClient(backend), { embed });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(r.ranking).toBe('embedding');
    expect(batches[0].map(p => p.premise)).toEqual([
      'Gamma wrote a poem.', 'Beta built a bridge. Gamma wrote a poem.', 'Beta built a bridge.',
    ]);
    expect(r.pairs).toBe(NLI_TOP_PREMISES);
  });

  it('falls back to word overlap when embedding fails or is not given', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { backend, batches } = fakeBackend();
    const failing = vi.fn(async (): Promise<number[][]> => { throw new Error('404'); });
    const r = await checkEntailment(LONG, 'Gamma wrote a poem.', [], new NliClient(backend), { embed: failing });
    expect(r.ranking).toBe('lexical');
    expect(batches[0][0].premise).toBe('Gamma wrote a poem.');

    const none = await checkEntailment(LONG, 'Beta built a bridge.', [], new NliClient(fakeBackend().backend));
    expect(none.ranking).toBe('lexical');
  });

  it('counts pairs the worker flagged as truncated', async () => {
    const backend: NliBackend = { score: async pairs => pairs.map(() => ({ ...SUPPORTED, truncated: true })) };
    const r = await checkEntailment(ORIGINAL, 'It ended the war.', [], new NliClient(backend));
    expect(r.truncatedPairs).toBe(3);
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
    expect(r.passed).toBe(false);
    expect(r.sentenceScores.map(x => [x.sentence, x.exempt])).toEqual([
      ['It was signed in 1945.', false], ['It ended the war.', false], ['France was happy.', false],
    ]);
    expect(r.sentenceScores[2].entailment).toBeCloseTo(0.1);
    expect(r.sentenceScores[0].contradiction).toBeCloseTo(0.97);
  });

  it('passes the thresholds for supported sentences', async () => {
    const r = await checkEntailment(ORIGINAL, 'It ended the war.', [], new NliClient(fakeBackend().backend));
    expect(r.minEntailment).toBeGreaterThanOrEqual(ENTAILMENT_MIN);
    expect(r.maxContradiction).toBeLessThanOrEqual(CONTRADICTION_MAX);
    expect(r.unsupportedSentences).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.toleratedSentences).toEqual([]);
  });

  // Short and referring sentences are scored with the previous sentence
  describe('hypothesis context', () => {
    it('needs context below 7 words or after a referring word', () => {
      expect(needsContext('That’s called inflation.')).toBe(true);
      expect(needsContext('Anatocism is the same.')).toBe(true);
      expect(needsContext('It happened over many long years in the north.')).toBe(true);
      expect(needsContext('They were signed by every country at the conference.')).toBe(true);
      expect(needsContext('The treaty finally ended the long war.')).toBe(false);
      expect(needsContext('Items are sent to the address on the form.')).toBe(false);
      expect(needsContext('Thermal energy moves from hot to cold things.')).toBe(false);
    });

    it('combines with the previous sentence, never for the first', () => {
      const s = ['When prices go up, you can buy less with your money.', 'That’s called inflation.'];
      expect(hypothesisFor(s, 1)).toBe(`${s[0]} ${s[1]}`);
      expect(hypothesisFor(s, 0)).toBe(s[0]);
      expect(hypothesisFor(['Anatocism is the same.'], 0)).toBe('Anatocism is the same.');
    });

    it('scores the combined hypothesis but reports the sentence alone', async () => {
      const original = 'Compound interest is interest earned on a principal sum and on previous interest. It is also called anatocism.';
      const first = 'Compound interest is interest earned on the money and on old interest.';
      const { backend, batches } = fakeBackend({ 'Anatocism is the same.': NEUTRAL });
      const r = await checkEntailment(original, `${first} Anatocism is the same.`, [], new NliClient(backend));
      expect(batches[0].filter(p => p.hypothesis === `${first} Anatocism is the same.`)).toHaveLength(3);
      expect(batches[0].some(p => p.hypothesis === 'Anatocism is the same.')).toBe(false);
      expect(r.sentenceScores[1]).toMatchObject({
        sentence: 'Anatocism is the same.', hypothesis: `${first} Anatocism is the same.`,
      });
      expect(r.sentenceScores[0].hypothesis).toBeUndefined();
      expect(r.unsupportedSentences).toEqual(['Anatocism is the same.']);
    });

    it('still decides glossary exemptions on the sentence itself', async () => {
      const def = 'Reparations means money paid for damage.';
      const r = await checkEntailment(
        ORIGINAL, `The treaty finally ended the long war. ${def}`, ['reparations'],
        new NliClient(fakeBackend({ [def]: NEUTRAL }).backend),
      );
      expect(r.exemptedSentences).toEqual([def]);
      expect(r.sentenceScores[1].hypothesis).toBe(`The treaty finally ended the long war. ${def}`);
    });
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
        : {
            type: 'ready', loadMs: 5, backend: 'webgpu',
            dtype: (message.device === 'webgpu-fp16' ? 'fp16' : 'q8') as NliDtype,
            adapter: { vendor: 'nvidia', architecture: 'ampere', description: '' },
          });
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
    expect(worker.received[0]).toMatchObject({
      type: 'init', ...URLS, modelId: 'Xenova/nli-deberta-v3-xsmall', device: 'auto',
    });
  });

  it('reports and logs the backend and adapter vendor, and passes the requested device', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const worker = new FakeWorker();
    const backend = createWorkerBackend(() => worker, { ...URLS, getDevice: async () => 'wasm' });
    const info = await backend.load();
    expect(info).toMatchObject({ backend: 'webgpu', adapter: { vendor: 'nvidia' } });
    expect(worker.received[0]).toMatchObject({ type: 'init', device: 'wasm' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[Clarity\] NLI model .* loaded on webgpu \(nvidia ampere\)/));
  });

  it('passes the fp16 experiment device and reports the dtype it loaded', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const worker = new FakeWorker();
    const backend = createWorkerBackend(() => worker, { ...URLS, getDevice: async () => 'webgpu-fp16' });
    const info = await backend.load();
    expect(worker.received[0]).toMatchObject({ type: 'init', device: 'webgpu-fp16' });
    expect(info.dtype).toBe('fp16');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(
      /loaded on webgpu fp16 \(nvidia ampere\) in \d+ ms \(webgpu-fp16 requested by debug:nliDevice\)$/,
    ));
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

// ---------------------------------------------------------------------------
// Benchmark — NliClient.bench and prepareNli
// ---------------------------------------------------------------------------
describe('NLI benchmark', () => {
  const CTX = { version: '1.0.0', webgpuAdapter: true, device: 'auto' as const };
  const STORED: NliBenchRecord = {
    backend: 'webgpu', adapterVendor: 'nvidia', ms: 40, predictedParagraphMs: 90,
    version: '1.0.0', webgpuAdapter: true, device: 'auto', at: 1,
  };

  function memoryStore(initial: NliBenchRecord | null = null) {
    let value = initial;
    return {
      get: vi.fn(async () => value),
      save: vi.fn(async (r: NliBenchRecord) => { value = r; }),
    } satisfies BenchStore;
  }

  function loadingBackend(backend: 'webgpu' | 'wasm') {
    return {
      score: vi.fn(async (pairs: NliPair[]) => pairs.map(() => SUPPORTED)),
      load: vi.fn(async () => ({
        backend,
        adapter: backend === 'webgpu' ? { vendor: 'nvidia', architecture: '', description: '' } : null,
        loadMs: 1,
      })),
    };
  }

  it('times one batch after an untimed warm-up, bypassing the cache', async () => {
    const backend = loadingBackend('wasm');
    const client = new NliClient(backend);
    await client.scorePairs([...NLI_BENCH_PAIRS]);
    expect(await client.bench([...NLI_BENCH_PAIRS])).toBeGreaterThanOrEqual(0);
    expect(backend.score).toHaveBeenCalledTimes(3);
    expect(NLI_BENCH_PAIRS).toHaveLength(8);
  });

  it('loads, benchmarks and stores a fresh record', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = memoryStore();
    const record = await prepareNli(new NliClient(loadingBackend('webgpu')), CTX, store);
    expect(record).toMatchObject({
      backend: 'webgpu', adapterVendor: 'nvidia', dtype: 'q8', version: '1.0.0', webgpuAdapter: true, device: 'auto',
    });
    expect(record.predictedParagraphMs).toBeGreaterThanOrEqual(0);
    expect(store.save).toHaveBeenCalledWith(record);
  });

  it('reuses a stored record of the same setup without benchmarking again', async () => {
    const backend = loadingBackend('webgpu');
    const store = memoryStore(STORED);
    expect(await prepareNli(new NliClient(backend), CTX, store)).toEqual(STORED);
    expect(backend.score).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('benchmarks again when the actual backend or the version changed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // WebGPU failed this time, so the worker fell back to wasm
    const onWasm = await prepareNli(new NliClient(loadingBackend('wasm')), CTX, memoryStore(STORED));
    expect(onWasm.backend).toBe('wasm');
    const updated = await prepareNli(
      new NliClient(loadingBackend('webgpu')), { ...CTX, version: '1.1.0' }, memoryStore(STORED),
    );
    expect(updated.version).toBe('1.1.0');
  });

  it('throws NliUnavailableError when the model cannot load', async () => {
    const backend: NliBackend = {
      score: async () => [],
      load: async () => { throw new NliUnavailableError('missing'); },
    };
    await expect(prepareNli(new NliClient(backend), CTX, memoryStore())).rejects.toBeInstanceOf(NliUnavailableError);
  });
});
