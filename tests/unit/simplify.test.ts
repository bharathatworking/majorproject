import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { ClarityDocument, ContentNode, EntailmentCheck, NliBenchRecord, StoredResult } from '../../src/types';
import { installChromeMock, type ChromeMock } from '../mocks/chrome';
import { makeDocInput, makeEntailment, makeReport } from '../mocks/fixtures';

// The real segmenter needs DOMParser; a fixed node list keeps this test in the
// node environment (happy-dom is confined to segmenter.test.ts).
const NODES: ContentNode[] = [
  { id: 'n0', type: 'paragraph', text: 'Alpha paragraph text.', entities: [] },
  { id: 'n1', type: 'paragraph', text: 'Beta paragraph text.', entities: [] },
  { id: 'n2', type: 'paragraph', text: 'Gamma paragraph text.', entities: [] },
];

/** Long enough (>= 8 words) for the meaning check. */
const CURIE: ContentNode = {
  id: 'n0',
  type: 'paragraph',
  text: 'Marie Curie received the Nobel Prize in Physics in 1903 for her research on radiation.',
  entities: [{ text: 'Marie Curie', type: 'person', start: 0, end: 11 }],
};
const DARWIN: ContentNode = {
  id: 'n1',
  type: 'paragraph',
  text: 'Charles Darwin published his theory of evolution by natural selection in the year 1859.',
  entities: [{ text: 'Charles Darwin', type: 'person', start: 0, end: 14 }],
};

/** Nodes the mocked segmenter returns; tests may swap it. */
let nodes: ContentNode[] = NODES;
vi.mock('../../src/lib/segmentation/segmenter', () => ({
  segmentHtml: (_html: string, title: string, contentHash: string) => ({ title, contentHash, nodes }),
  simplifiableNodes: (list: ContentNode[]) => list,
}));

/**
 * NLI mock: the worker and model never load in node. `nliMode` 'unavailable'
 * makes checkEntailment throw NliUnavailableError (model not loadable), 'error'
 * a plain Error (one failed request); otherwise it answers nliResults[text] or
 * a passing result.
 */
let nliMode: 'ok' | 'unavailable' | 'error';
let nliResults: Record<string, EntailmentCheck>;
/** What the mocked prepareNli (model load + benchmark) returns; default a fast WebGPU setup. */
let nliBenchResult: NliBenchRecord;
const FAST_WEBGPU: NliBenchRecord = {
  backend: 'webgpu', adapterVendor: 'nvidia', ms: 40, predictedParagraphMs: 90,
  version: 'dev', webgpuAdapter: false, device: 'auto', at: 1,
};
vi.mock('../../src/lib/quality/nli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/quality/nli')>();
  return {
    ...actual,
    getNliClient: vi.fn(() => ({})),
    prepareNli: vi.fn(async () => {
      if (nliMode === 'unavailable') throw new actual.NliUnavailableError('model files missing');
      return nliBenchResult;
    }),
    checkEntailment: vi.fn(async (_original: string, simplified: string) => {
      if (nliMode === 'unavailable') throw new actual.NliUnavailableError('model files missing');
      if (nliMode === 'error') throw new Error('NLI scoring timed out');
      return nliResults[simplified] ?? makeEntailment();
    }),
  };
});

/**
 * Combined-score stub: these tests are about the run loop (retries, caching,
 * notices, logs), not the frozen weights, which checker.test.ts and
 * meaning.test.ts cover. A version "passes" when its fixtures are all at the
 * old per-check levels (similarity ≥ 0.87, every entity, entailment ≥ 0.5,
 * contradiction ≤ 0.2): passing scores are 0.6 + 0.4·m and failing ones
 * 0.4·m, m = similarity × entity recall × entailment (measured parts), so
 * either side of both frozen thresholds and ordered as before; a check
 * below its level gets a negative contribution, which names the reason.
 */
vi.mock('../../src/lib/quality/checker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/quality/checker')>();
  type Features = Partial<Record<import('../../src/types').CheckerFeature, number | null>>;
  const levels = (f: Features) => ({
    sbert: f.sbert == null ? 0 : f.sbert - 0.87,
    entity: f.entity == null ? 0 : f.entity - 1,
    nliMin: f.nliMin == null ? 0 : f.nliMin - 0.5,
    contra: f.contra == null ? 0 : 0.2 - f.contra,
  });
  return {
    ...actual,
    combinedScore: (model: { features: readonly string[] }, f: Features) => {
      const all = levels(f);
      const contributions = Object.fromEntries(Object.entries(all).filter(([k]) => model.features.includes(k)));
      const passes = Object.values(contributions).every(c => c >= -1e-12);
      const m = Math.max(0, Math.min(1, f.sbert ?? 1)) * (f.entity ?? 1) *
        (model.features.includes('nliMin') ? Math.max(0, Math.min(1, f.nliMin ?? 1)) : 1);
      return { score: passes ? 0.6 + 0.4 * m : 0.4 * m, contributions, missing: [] };
    },
  };
});

/** Easy enough (estimated grade below 0) to be skipped at any target. */
const EASY: ContentNode = { id: 'n0', type: 'paragraph', text: 'The cat sat on the mat.', entities: [] };

const {
  runSimplification, selectNodesToRun, rotateFrom, EMBED_MISSING_NOTICE, NLI_MISSING_NOTICE,
} = await import('../../src/lib/run/simplify');
const { cleanForModel } = await import('../../src/lib/segmentation/clutter');
const { DEFAULT_PROFILE } = await import('../../src/lib/storage/settings');
const { getDocument, upsertDocument, saveDocument } = await import('../../src/lib/storage/documents');
const { beforeAfterOf, getWeeklyProgress } = await import('../../src/lib/storage/progress');
const { DEFAULT_LLM_MODEL, OllamaProvider, OllamaHttpError } = await import('../../src/lib/llm/ollama-provider');
const { RETRY_OPENING, driftReason, unsupportedReason } = await import('../../src/lib/quality/meaning');
const {
  COMBINED_SCORE_FULL, COMBINED_SCORE_LITE, ENTAILMENT_MIN, MAX_MODEL_CALLS_PER_NODE, NLI_CONTRADICTION_AGG, NLI_PARAGRAPH_RULE, QUALITY_THRESHOLD,
} = await import('../../src/lib/quality/config');
const nli = await import('../../src/lib/quality/nli');
const checkEntailmentMock = vi.mocked(nli.checkEntailment);
const prepareNliMock = vi.mocked(nli.prepareNli);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Node texts whose request should fail with HTTP 500. */
let failing: Set<string>;
/** User prompts sent to the model, in order. */
let prompts: string[];
/** Per-node reply queue (first attempt, retry); FAIL answers HTTP 500. Default: "Simple <id>." */
let replies: Record<string, string[]>;
const FAIL = '__FAIL__';
/** Similarity to the original that the mocked embed gives each simplified text (default 1). */
let scores: Record<string, number>;
/** When set, every chat request answers with this HTTP status. */
let chatStatus: number | null;
/** `model` field of each chat request, in order. */
let models: string[];
let mock: ChromeMock;

function ndjson(content: string): Response {
  const body =
    JSON.stringify({ message: { content }, done: false }) + '\n' +
    JSON.stringify({ message: { content: '' }, done: true }) + '\n';
  return new Response(body, { status: 200 });
}

const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const { messages, model } = JSON.parse(String(init?.body)) as {
    messages: { content: string }[]; model: string;
  };
  const user = messages[1].content;
  prompts.push(user);
  models.push(model);
  if (chatStatus !== null) return new Response('nope', { status: chatStatus });
  const node = nodes.find(n => user.endsWith(n.text) || user.endsWith(cleanForModel(n.text)));
  if (!node || failing.has(node.text)) return new Response('boom', { status: 500 });
  const reply = replies[node.id]?.shift() ?? `Simple ${node.id}.`;
  if (reply === FAIL) return new Response('boom', { status: 500 });
  return ndjson(reply);
});

/** Capabilities /api/show reports for the run's model (default: no thinking). */
let showCapabilities: string[];
/** When set, /api/show answers with this HTTP status (404 = model not pulled). */
let showStatus: number | null;
/** /api/show requests; kept apart from fetchMock, which counts only /api/chat calls. */
const showMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
  showStatus !== null
    ? new Response('{"error":"model not found"}', { status: showStatus })
    : new Response(JSON.stringify({ capabilities: showCapabilities }), { status: 200 }));

/** Routes /api/show to showMock and everything else (/api/chat) to fetchMock. */
const routedFetch = (url: string | URL | Request, init?: RequestInit) =>
  String(url).endsWith('/api/show') ? showMock(url, init) : fetchMock(url, init);

/** Unit vector whose cosine with [1, 0] is exactly `sim`. */
const vec = (sim: number) => [sim, Math.sqrt(1 - sim * sim)];

/** Mocked provider embed: originals map to [1, 0], outputs to their score. */
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map(t => (nodes.some(n => n.text === t) ? [1, 0] : vec(scores[t] ?? 1))),
  );
}
let embedSpy: MockInstance<(texts: string[]) => Promise<number[][]>>;

function callbacks() {
  return {
    onProgress: vi.fn(), onNodeStart: vi.fn(), onNodeChunk: vi.fn(), onNodeDone: vi.fn(),
    onNodeError: vi.fn(), onBannerError: vi.fn(), onNotice: vi.fn(), onComplete: vi.fn(),
    signal: new AbortController().signal,
  };
}

async function storedDoc(hash = 'hash-run'): Promise<ClarityDocument> {
  return upsertDocument(makeDocInput(hash, { report: makeReport() }));
}

/** Saves a profile with the given target grade (fixtures are skipped at the default 12). */
function setTargetGrade(grade: number): Promise<void> {
  return chrome.storage.sync.set({ userProfile: { ...DEFAULT_PROFILE, targetGradeLevel: grade } });
}

const cacheKeys = () =>
  [...mock.areas.local.data.keys()].filter(k => k.startsWith('cache:') && k !== 'cache:index');

function result(nodeId: string, status: StoredResult['status'], simplifiedText = ''): StoredResult {
  const node = NODES.find(n => n.id === nodeId)!;
  return { nodeId, originalText: node.text, simplifiedText, status, type: 'paragraph' };
}

const statuses = (doc: ClarityDocument | null) =>
  Object.fromEntries((doc?.results ?? []).map(r => [r.nodeId, r.status]));

beforeEach(async () => {
  mock = installChromeMock();
  await setTargetGrade(1);
  vi.stubGlobal('fetch', routedFetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  embedSpy = vi.spyOn(OllamaProvider.prototype, 'embed').mockImplementation(fakeEmbed);
  fetchMock.mockClear();
  showMock.mockClear();
  showCapabilities = ['completion'];
  showStatus = null;
  failing = new Set();
  prompts = [];
  replies = {};
  scores = {};
  chatStatus = null;
  models = [];
  nodes = NODES;
  nliMode = 'ok';
  nliResults = {};
  nliBenchResult = FAST_WEBGPU;
  checkEntailmentMock.mockClear();
  prepareNliMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// selectNodesToRun — 'remaining' vs 'all'
// ---------------------------------------------------------------------------
describe('rotateFrom', () => {
  it('starts at the index and wraps around', () => {
    expect(rotateFrom(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('clamps out-of-range and non-finite starts', () => {
    expect(rotateFrom(['a', 'b'], -3)).toEqual(['a', 'b']);
    expect(rotateFrom(['a', 'b'], 9)).toEqual(['a', 'b']);
    expect(rotateFrom(['a', 'b'], NaN)).toEqual(['a', 'b']);
  });
});

describe('selectNodesToRun', () => {
  const results = [result('n0', 'done', 'x'), result('n1', 'error')];

  it("'remaining' keeps pending, failed and never-run nodes", () => {
    expect(selectNodesToRun(NODES, results, 'remaining').map(n => n.id)).toEqual(['n1', 'n2']);
  });

  it("'all' keeps every node", () => {
    expect(selectNodesToRun(NODES, results, 'all').map(n => n.id)).toEqual(['n0', 'n1', 'n2']);
  });
});

// ---------------------------------------------------------------------------
// runSimplification — persistence and run modes
// ---------------------------------------------------------------------------
describe('runSimplification', () => {
  it('persists error status for failures after the last success', async () => {
    failing = new Set([NODES[1].text, NODES[2].text]);
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    expect(statuses(await getDocument(doc.id))).toEqual({ n0: 'done', n1: 'error', n2: 'error' });
    expect(cb.onNodeError).toHaveBeenCalledTimes(2);
    expect(cb.onBannerError).toHaveBeenCalledTimes(1);
    expect(cb.onComplete).toHaveBeenCalledTimes(1);
  });

  it('persists errors when every node fails', async () => {
    failing = new Set(NODES.map(n => n.text));
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    const saved = await getDocument(doc.id);
    expect(statuses(saved)).toEqual({ n0: 'error', n1: 'error', n2: 'error' });
    expect(saved?.simplifiedReport).toBeNull();
  });

  it("'remaining' re-runs only pending and failed nodes, with context from done ones", async () => {
    const doc = await storedDoc();
    await saveDocument({ ...doc, results: [result('n0', 'done', 'Stored alpha.'), result('n1', 'error')] });
    const cb = callbacks();

    await runSimplification((await getDocument(doc.id))!, cb, 'remaining');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toContain('[Context from previous section: "Stored alpha."]');
    expect(cb.onProgress).toHaveBeenLastCalledWith(2, 2);
    const saved = await getDocument(doc.id);
    expect(statuses(saved)).toEqual({ n0: 'done', n1: 'done', n2: 'done' });
    expect(saved?.results.find(r => r.nodeId === 'n0')?.simplifiedText).toBe('Stored alpha.');
    expect(saved?.simplifiedReport).not.toBeNull();
  });

  it("'remaining' does nothing when every node is done", async () => {
    const doc = await storedDoc();
    const done = { ...doc, results: NODES.map(n => result(n.id, 'done', 'Done.')) };
    const cb = callbacks();

    await runSimplification(done, cb, 'remaining');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cb.onComplete).toHaveBeenCalledTimes(1);
  });

  it("'all' re-runs every node, replacing done results", async () => {
    const doc = await storedDoc();
    const done = { ...doc, results: NODES.map(n => result(n.id, 'done', 'Old.')) };

    await runSimplification(done, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const saved = await getDocument(doc.id);
    expect(saved?.results.map(r => r.simplifiedText)).toEqual(['Simple n0.', 'Simple n1.', 'Simple n2.']);
  });

  it('names uncommon words from the node in the prompt', async () => {
    // Grade 16 against the default adult target 12 → 'moderate', so the hint is sent
    const doc = await upsertDocument(makeDocInput('hash-hint', { report: makeReport({ estimatedGradeLevel: 16 }) }));

    await runSimplification(doc, callbacks(), 'all');

    // "Alpha" and "text" are common; "paragraph" is not
    expect(prompts[0]).toContain('Replace them with simpler words or briefly explain them: paragraph\n');
  });
});

// ---------------------------------------------------------------------------
// runSimplification — semantic preservation (meaning + entity check, one retry)
// ---------------------------------------------------------------------------
describe('runSimplification meaning check', () => {
  const savedResult = async (docId: string, nodeId: string) =>
    (await getDocument(docId))?.results.find(r => r.nodeId === nodeId);

  it('skips headings and texts under 8 words', async () => {
    nodes = [...NODES, { id: 'n3', type: 'heading', level: 2, text: CURIE.text, entities: [] }];
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(embedSpy).not.toHaveBeenCalled();
    expect(checkEntailmentMock).not.toHaveBeenCalled();
    // The heading never reaches the model
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await getDocument(doc.id))?.results.every(r => r.similarity === undefined)).toBe(true);
  });

  it('stores the similarity and does not retry when the check passes', async () => {
    const reply = 'Marie Curie won the Nobel Prize in 1903.';
    nodes = [CURIE];
    replies = { n0: [reply] };
    scores = { [reply]: 0.93 };
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(embedSpy).toHaveBeenCalledWith([CURIE.text, reply]);
    expect((await savedResult(doc.id, 'n0'))?.similarity).toBeCloseTo(0.93);
    expect(cb.onNodeDone).toHaveBeenCalledWith('n0', reply, expect.objectContaining({ similarity: expect.closeTo(0.93) }));
  });

  it('retries a low score with the meaning instruction and keeps a better retry', async () => {
    const first = 'Marie Curie liked science.';
    const retry = 'Marie Curie won a top science prize in 1903.';
    nodes = [CURIE];
    replies = { n0: [first, retry] };
    scores = { [first]: 0.6, [retry]: 0.88 };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prompts[0].startsWith(RETRY_OPENING)).toBe(false);
    expect(prompts[1].startsWith(RETRY_OPENING)).toBe(true);
    expect(prompts[1]).toContain(`Fix this: ${driftReason(0.6)} Output only the rewritten text.\n\n`);
    const saved = await savedResult(doc.id, 'n0');
    expect(saved?.simplifiedText).toBe(retry);
    expect(saved?.similarity).toBeCloseTo(0.88);
  });

  it('keeps the first version when the retry scores lower', async () => {
    const first = 'Marie Curie studied rays.';
    const retry = 'Marie Curie was a person.';
    nodes = [CURIE];
    replies = { n0: [first, retry] };
    scores = { [first]: 0.7, [retry]: 0.5 };
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    const saved = await savedResult(doc.id, 'n0');
    expect(saved?.simplifiedText).toBe(first);
    expect(saved?.similarity).toBeCloseTo(0.7);
    expect(cb.onNodeDone).toHaveBeenLastCalledWith('n0', first, expect.objectContaining({ similarity: expect.closeTo(0.7) }));
  });

  it('retries on a missing entity and keeps the retry that restores it', async () => {
    const first = 'She won the Nobel Prize in 1903.';
    const retry = 'Marie Curie won the Nobel Prize in 1903.';
    nodes = [CURIE];
    replies = { n0: [first, retry] };
    scores = { [first]: 0.95, [retry]: 0.9 };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain('left out "Marie Curie"');
    expect((await savedResult(doc.id, 'n0'))?.simplifiedText).toBe(retry);
  });

  /** A faithful rewrite of CURIE with a copied entity list under it (eval/fixtures UK run). */
  const CURIE_TEXT = 'Marie Curie won the Nobel Prize in Physics in 1903 for her work on radiation.';
  const ECHO_LINE = '- Marie Curie, 1903, Nobel Prize, Physics';

  it('fails a version that copied the entity list (echo) and keeps the clean retry', async () => {
    const first = `${CURIE_TEXT}\n${ECHO_LINE}`;
    nodes = [CURIE];
    replies = { n0: [first, CURIE_TEXT] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prompts[1].startsWith(RETRY_OPENING)).toBe(true);
    expect((await savedResult(doc.id, 'n0'))?.simplifiedText).toBe(CURIE_TEXT);
    const log = (await getDocument(doc.id))?.runLogs?.at(-1)?.nodes[0];
    expect(log?.candidates[0].failures).toEqual(['echo']);
    expect(log?.candidates[0].reasons[0]).toContain('only lists names or numbers');
  });

  it('removes the echo lines, without a model call, when every version echoed', async () => {
    const echoed = `${CURIE_TEXT}\n${ECHO_LINE}`;
    nodes = [CURIE];
    replies = { n0: [echoed, echoed] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const saved = await savedResult(doc.id, 'n0');
    expect(saved?.simplifiedText).toBe(CURIE_TEXT);
    expect(saved?.passed).toBe(true);
    expect(saved?.echo).toBeUndefined();
    const log = (await getDocument(doc.id))?.runLogs?.at(-1)?.nodes[0];
    expect(log?.modelCalls).toBe(2);
    expect(log?.candidates.map(c => c.chosen)).toEqual([false, false, true]);
    expect(log?.candidates[2].echoStripped).toBe(true);
  });

  it('skips the meaning score with one notice when the embedding model is missing', async () => {
    nodes = [CURIE, DARWIN];
    replies = { n0: ['Marie Curie won a prize.'], n1: ['Charles Darwin wrote about evolution.'] };
    embedSpy.mockRejectedValue(new OllamaHttpError(404));
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(cb.onNotice).toHaveBeenCalledTimes(1);
    expect(cb.onNotice).toHaveBeenCalledWith(EMBED_MISSING_NOTICE);
    expect(cb.onBannerError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const saved = await getDocument(doc.id);
    expect(statuses(saved)).toEqual({ n0: 'done', n1: 'done' });
    expect(saved?.results.every(r => r.similarity === undefined)).toBe(true);
  });

  it('keeps the first version when the retry request fails', async () => {
    const first = 'Marie Curie liked science.';
    nodes = [CURIE];
    replies = { n0: [first, FAIL] };
    scores = { [first]: 0.5 };
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    const saved = await savedResult(doc.id, 'n0');
    expect(saved?.status).toBe('done');
    expect(saved?.simplifiedText).toBe(first);
    expect(cb.onNodeError).not.toHaveBeenCalled();
    expect(cb.onBannerError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runSimplification — thesis standard: NLI, stored verdict, fallback, metric
// ---------------------------------------------------------------------------
describe('runSimplification thesis meaning standard', () => {
  const GOOD_CURIE = 'Marie Curie won the Nobel Prize in 1903.';
  const GOOD_DARWIN = 'Charles Darwin wrote about evolution in 1859.';
  const lastLog = async (docId: string) => (await getDocument(docId))?.runLogs?.at(-1);

  beforeEach(() => {
    scores = { [GOOD_CURIE]: 0.92, [GOOD_DARWIN]: 0.92 };
  });

  it('stores the full verdict on the result', async () => {
    nodes = [CURIE];
    replies = { n0: [GOOD_CURIE] };
    nliResults = { [GOOD_CURIE]: makeEntailment({ minEntailment: 0.9, maxContradiction: 0.03 }) };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect((await getDocument(doc.id))?.results[0]).toMatchObject({
      similarity: expect.closeTo(0.92), entityRecall: 1, minEntailment: 0.9, maxContradiction: 0.03,
      nliChecked: true, passed: true, reasons: [],
    });
  });

  it('passes no hinted words when the reader keeps terms', async () => {
    await chrome.storage.sync.set({
      userProfile: { ...DEFAULT_PROFILE, targetGradeLevel: 1, domainFamiliarity: 'expert' },
    });
    nodes = [CURIE];
    replies = { n0: [GOOD_CURIE] };
    const doc = await upsertDocument(makeDocInput('hash-keep', { report: makeReport({ estimatedGradeLevel: 16 }) }));

    await runSimplification(doc, callbacks(), 'all');

    expect(checkEntailmentMock.mock.calls[0][2]).toEqual([]);
  });

  it('scores every simplified sentence against the original, with the hinted words', async () => {
    nodes = [CURIE];
    replies = { n0: [GOOD_CURIE] };
    // Grade 16 against target 1 → the lexical hint is sent and reused for NLI
    const doc = await upsertDocument(makeDocInput('hash-nli', { report: makeReport({ estimatedGradeLevel: 16 }) }));

    await runSimplification(doc, callbacks(), 'all');

    expect(checkEntailmentMock).toHaveBeenCalledTimes(1);
    const [original, simplified, hinted] = checkEntailmentMock.mock.calls[0];
    expect(original).toBe(CURIE.text);
    expect(simplified).toBe(GOOD_CURIE);
    // Exactly the words the prompt named
    expect((hinted as string[]).length).toBeGreaterThan(0);
    expect(prompts[0]).toContain(`briefly explain them: ${(hinted as string[]).join(', ')}\n`);
  });

  it('retries an unsupported sentence, naming it in the prompt', async () => {
    const first = 'Marie Curie won the Nobel Prize in 1903. She was born in Paris.';
    nodes = [CURIE];
    replies = { n0: [first, GOOD_CURIE] };
    scores = { [first]: 0.9, [GOOD_CURIE]: 0.92 };
    nliResults = {
      [first]: makeEntailment({ minEntailment: 0.04, unsupportedSentences: ['She was born in Paris.'] }),
    };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain(`Fix this: ${unsupportedReason('She was born in Paris.')}`);
    const saved = (await getDocument(doc.id))?.results[0];
    expect(saved).toMatchObject({ simplifiedText: GOOD_CURIE, passed: true });
    const node = (await lastLog(doc.id))?.nodes[0];
    expect(node?.candidates[0].reasons).toEqual([unsupportedReason('She was born in Paris.')]);
    expect(node?.candidates[0].scores.passed).toBe(false);
    expect(node?.meaningStatus).toBe('passed');
  });

  it('stores a failing verdict with its reasons when the retry fails too', async () => {
    const bad = 'Marie Curie won the Nobel Prize in 1945.';
    nodes = [CURIE];
    replies = { n0: [bad, bad] };
    scores = { [bad]: 0.9 };
    nliResults = { [bad]: makeEntailment({ minEntailment: 0.01, maxContradiction: 0.98, contradictedSentences: [bad] }) };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    const saved = (await getDocument(doc.id))?.results[0];
    expect(saved).toMatchObject({ status: 'done', passed: false, nliChecked: true });
    expect(saved?.reasons?.[0]).toBe(`This sentence contradicts the original: "${bad}"`);
    expect(cacheKeys()).toHaveLength(0);
    expect((await lastLog(doc.id))?.summary.meaning).toMatchObject({ passed: 0, failed: 1, passRate: 0, coverage: 1 });
  });

  it('falls back to SBERT + entities with one notice when the NLI model cannot load', async () => {
    nliMode = 'unavailable';
    nodes = [CURIE, DARWIN];
    replies = { n0: [GOOD_CURIE], n1: [GOOD_DARWIN] };
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    // Load tried once (Auto measures first), then off for the rest of the run
    expect(prepareNliMock).toHaveBeenCalledTimes(1);
    expect(checkEntailmentMock).not.toHaveBeenCalled();
    expect(cb.onNotice).toHaveBeenCalledTimes(1);
    expect(cb.onNotice).toHaveBeenCalledWith(NLI_MISSING_NOTICE);
    expect(cb.onBannerError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const saved = await getDocument(doc.id);
    expect(statuses(saved)).toEqual({ n0: 'done', n1: 'done' });
    for (const r of saved?.results ?? []) {
      expect(r).toMatchObject({ nliChecked: false, passed: true, similarity: expect.closeTo(0.92) });
      expect(r.minEntailment).toBeUndefined();
    }
  });

  it('warns that a run without NLI is not thesis-grade and counts it as not fully checked', async () => {
    nliMode = 'unavailable';
    nodes = [CURIE, DARWIN];
    replies = { n0: [GOOD_CURIE], n1: [GOOD_DARWIN] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect((await lastLog(doc.id))?.summary.meaning).toMatchObject({
      passed: 0, failed: 0, notFullyChecked: 2, passRate: null, coverage: 0, thesisGrade: false,
    });
    expect(vi.mocked(console.warn).mock.calls.map(c => String(c[0])))
      .toContainEqual(expect.stringMatching(/^\[Clarity\] Meaning coverage 0% is below 90%: the pass rate is not thesis-grade/));
  });

  it('a failed NLI request skips NLI for that node only, without a notice', async () => {
    nodes = [CURIE, DARWIN];
    replies = { n0: [GOOD_CURIE], n1: [GOOD_DARWIN] };
    checkEntailmentMock.mockRejectedValueOnce(new Error('NLI scoring timed out'));
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    expect(cb.onNotice).not.toHaveBeenCalled();
    const saved = await getDocument(doc.id);
    expect(saved?.results.map(r => r.nliChecked)).toEqual([false, true]);
  });

  it('summarizes passed, failed, not fully checked and excluded nodes in the run log', async () => {
    nodes = [
      { ...EASY, id: 'n9' }, CURIE, DARWIN,
      { id: 'n3', type: 'heading', level: 2, text: 'Famous scientists of the modern era', entities: [] },
    ];
    replies = { n0: [GOOD_CURIE], n1: [GOOD_DARWIN, GOOD_DARWIN] };
    nliResults = { [GOOD_DARWIN]: makeEntailment({ minEntailment: 0.1, unsupportedSentences: [GOOD_DARWIN] }) };
    await setTargetGrade(4);
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    const log = await lastLog(doc.id);
    expect(log?.nodes.map(n => [n.nodeId, n.meaningStatus])).toEqual([
      ['n9', 'excluded'], ['n0', 'passed'], ['n1', 'failed'], ['n3', 'excluded'],
    ]);
    expect(log?.summary.meaning).toMatchObject({ passed: 1, failed: 1, notFullyChecked: 0, excluded: 2 });
    expect(log?.summary.meaning.passRate).toBeCloseTo(0.5);
    expect(log?.summary.meaning.coverage).toBe(1);
    expect(log?.summary.meaning.thesisGrade).toBe(true);
    expect(log?.summary.meaning.avgNliMs).toBe(100);
    expect(log?.summary.meaning.failureBreakdown).toEqual({
      similarity: 0, entities: 0, unsupported: 1, contradiction: 0, echo: 0, failedParagraphs: 1,
    });
    expect(log?.nodes[2].meaning?.failures).toEqual(['unsupported']);
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0])))
      .toContainEqual('[Clarity] Meaning failures: similarity 0, entities 0, unsupported 1, contradiction 0, echo 0 (of 1 failed)');
  });

  it('logs each candidate with its text, failure kinds and NLI time split, and each node with its original', async () => {
    const bad = 'She won a prize.';
    nodes = [CURIE];
    replies = { n0: [bad, GOOD_CURIE] };
    scores = { [bad]: 0.8 };
    nliResults = { [bad]: makeEntailment({ minEntailment: 0.1, unsupportedSentences: [bad], rankMs: 30, scoreMs: 70 }) };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    const node = (await lastLog(doc.id))?.nodes[0];
    expect(node?.originalText).toBe(CURIE.text);
    expect(node?.candidates[0]).toMatchObject({
      text: bad, failures: ['similarity', 'entities', 'unsupported'], nliRankMs: 30, nliScoreMs: 70,
    });
    expect(node?.candidates[1]).toMatchObject({ text: GOOD_CURIE, failures: [] });
  });

  it('logs "NLI above budget" once with console.info, never console.warn', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    nodes = [CURIE, DARWIN];
    replies = { n0: [GOOD_CURIE], n1: [GOOD_DARWIN] };
    nliResults = { [GOOD_CURIE]: makeEntailment({ ms: 1500 }), [GOOD_DARWIN]: makeEntailment({ ms: 1300 }) };

    await runSimplification(await storedDoc(), callbacks(), 'all');

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0]))
      .toBe('[Clarity] NLI above budget: 1400 ms per paragraph on average (budget 1000 ms)');
    expect(vi.mocked(console.warn).mock.calls.map(c => String(c[0]))).not.toContainEqual(expect.stringMatching(/NLI|budget/));
  });

  it('stays quiet within the NLI budget', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    nodes = [CURIE];
    replies = { n0: [GOOD_CURIE] };
    nliResults = { [GOOD_CURIE]: makeEntailment({ ms: 1000 }) };

    await runSimplification(await storedDoc(), callbacks(), 'all');

    expect(info).not.toHaveBeenCalled();
  });

  it('records glossary exemptions in the run log', async () => {
    nodes = [CURIE];
    replies = { n0: [GOOD_CURIE] };
    nliResults = { [GOOD_CURIE]: makeEntailment({ exemptedSentences: ['Radiation means energy.'], exemptionRate: 0.25, sentences: 4 }) };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    const log = await lastLog(doc.id);
    expect(log?.nodes[0].meaning).toMatchObject({ exemptedSentences: ['Radiation means energy.'], exemptionRate: 0.25 });
    expect(log?.nodes[0].candidates[0].exemptedSentences).toEqual(['Radiation means energy.']);
    expect(log?.summary.meaning).toMatchObject({ exemptedSentences: 1, exemptionRate: 0.25 });
  });

  it('caches the verdict with the text and reuses it', async () => {
    nodes = [CURIE];
    replies = { n0: [GOOD_CURIE] };
    await runSimplification(await storedDoc('hash-a'), callbacks(), 'remaining');
    checkEntailmentMock.mockClear();

    const second = await storedDoc('hash-b');
    await runSimplification(second, callbacks(), 'remaining');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(checkEntailmentMock).not.toHaveBeenCalled();
    expect((await getDocument(second.id))?.results[0]).toMatchObject({ nliChecked: true, passed: true });
    expect((await lastLog(second.id))?.nodes[0]).toMatchObject({ source: 'cache', meaningStatus: 'passed' });
  });

  it('treats a cached verdict without NLI as a miss once NLI is available again', async () => {
    nliMode = 'unavailable';
    nodes = [CURIE];
    replies = { n0: [GOOD_CURIE, GOOD_CURIE] };
    await runSimplification(await storedDoc('hash-a'), callbacks(), 'remaining');
    nliMode = 'ok';

    const second = await storedDoc('hash-b');
    await runSimplification(second, callbacks(), 'remaining');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await getDocument(second.id))?.results[0]).toMatchObject({ nliChecked: true });
  });
});

// ---------------------------------------------------------------------------
// runSimplification — speed: skip easy nodes, cache, start at visible node
// ---------------------------------------------------------------------------
describe('runSimplification speed paths', () => {
  it('keeps a heading as written: no model call, not checked, not in the pass rate', async () => {
    const heading: ContentNode = { id: 'n0', type: 'heading', level: 2, text: 'Etymology and terminology' };
    nodes = [heading, { ...CURIE, id: 'n1' }];
    replies = { n1: ['Marie Curie won the Nobel Prize in Physics in 1903 for her work on radiation.'] };
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    expect(prompts).toHaveLength(1);
    // Rolling context for the next paragraph, never a text to rewrite
    expect(prompts.some(p => p.endsWith('Etymology and terminology'))).toBe(false);
    expect(cb.onNodeDone).toHaveBeenCalledWith('n0', 'Etymology and terminology', undefined, true);
    const saved = await getDocument(doc.id);
    expect(saved?.results.find(r => r.nodeId === 'n0')).toMatchObject({
      status: 'done', simplifiedText: 'Etymology and terminology', skipped: true, type: 'heading',
    });
    const log = saved?.runLogs?.at(-1);
    expect(log?.nodes[0]).toMatchObject({ source: 'heading', modelCalls: 0, meaningStatus: 'excluded' });
    expect(log?.summary.counts.heading).toBe(1);
    expect(log?.summary.meaning).toMatchObject({ excluded: 1, passed: 1 });
  });

  it('sends the model the text without citation markers or hatnote, and stores the original', async () => {
    const raw = 'See also: Britain (place name) The Acts of Union 1707 joined England and Scotland into one kingdom.[o][19]';
    nodes = [{ id: 'n0', type: 'paragraph', text: raw }];
    replies = { n0: ['In 1707 the Acts of Union joined England and Scotland into one kingdom.'] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(prompts).toHaveLength(1);
    expect(prompts[0].endsWith('TEXT TO REWRITE:\nThe Acts of Union 1707 joined England and Scotland into one kingdom.')).toBe(true);
    expect(prompts[0]).not.toMatch(/\[(?:o|19)\]|See also/);
    const saved = await getDocument(doc.id);
    expect(saved?.results[0].originalText).toBe(raw);
    const log = saved?.runLogs?.at(-1)?.nodes[0];
    expect(log?.originalText).toBe(raw);
    expect(log?.modelInput).toBe('The Acts of Union 1707 joined England and Scotland into one kingdom.');
  });

  it('keeps a node that is only a hatnote as is, without the model', async () => {
    nodes = [{ id: 'n0', type: 'paragraph', text: 'Main article: History of the United Kingdom' }, NODES[1]];
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(prompts).toHaveLength(1);
    const saved = await getDocument(doc.id);
    expect(saved?.results.find(r => r.nodeId === 'n0')).toMatchObject({ simplifiedText: 'Main article: History of the United Kingdom', skipped: true });
    expect(saved?.runLogs?.at(-1)?.nodes.find(n => n.nodeId === 'n0')).toMatchObject({ source: 'skipped', modelInput: '' });
  });

  it('keeps an already simple node as is, without the model or the meaning check', async () => {
    nodes = [EASY, NODES[1]];
    await setTargetGrade(4);
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    expect(prompts).toHaveLength(1);
    expect(prompts[0].endsWith(NODES[1].text)).toBe(true);
    expect(embedSpy).not.toHaveBeenCalled();
    expect(cb.onNodeDone).toHaveBeenCalledWith('n0', EASY.text, undefined, true);
    expect(cb.onProgress).toHaveBeenLastCalledWith(2, 2);
    const saved = await getDocument(doc.id);
    expect(saved?.results.find(r => r.nodeId === 'n0')).toMatchObject({
      status: 'done', simplifiedText: EASY.text, skipped: true,
    });
    expect(saved?.results.find(r => r.nodeId === 'n1')?.skipped).toBeUndefined();
    expect(saved?.simplifiedReport).not.toBeNull();
  });

  it('does not skip a node above the target grade', async () => {
    nodes = [CURIE];
    replies = { n0: ['Marie Curie won the Nobel Prize in 1903.'] };
    await setTargetGrade(4);
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getDocument(doc.id))?.results[0].skipped).toBeUndefined();
  });

  it('reuses cached results for the same text, spec and model', async () => {
    await runSimplification(await storedDoc('hash-a'), callbacks(), 'remaining');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cacheKeys()).toHaveLength(3);

    fetchMock.mockClear();
    const second = await storedDoc('hash-b');
    const cb = callbacks();
    await runSimplification(second, cb, 'remaining');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cb.onNodeStart).not.toHaveBeenCalled();
    const saved = await getDocument(second.id);
    expect(saved?.results.map(r => [r.status, r.simplifiedText])).toEqual([
      ['done', 'Simple n0.'], ['done', 'Simple n1.'], ['done', 'Simple n2.'],
    ]);
  });

  it("'all' ignores the cache and asks the model again", async () => {
    await runSimplification(await storedDoc('hash-a'), callbacks(), 'all');
    fetchMock.mockClear();

    await runSimplification(await storedDoc('hash-b'), callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('misses the cache when the model changes', async () => {
    await runSimplification(await storedDoc('hash-a'), callbacks(), 'remaining');
    await chrome.storage.sync.set({ llmModel: 'llama3.2:1b' });
    fetchMock.mockClear();

    await runSimplification(await storedDoc('hash-b'), callbacks(), 'remaining');

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('caches the similarity with the text', async () => {
    const reply = 'Marie Curie won the Nobel Prize in 1903.';
    nodes = [CURIE];
    replies = { n0: [reply] };
    scores = { [reply]: 0.91 };
    await runSimplification(await storedDoc('hash-a'), callbacks(), 'remaining');

    const second = await storedDoc('hash-b');
    const cb = callbacks();
    await runSimplification(second, cb, 'remaining');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cb.onNodeDone).toHaveBeenCalledWith('n0', reply, expect.objectContaining({ similarity: expect.closeTo(0.91) }));
    expect((await getDocument(second.id))?.results[0].similarity).toBeCloseTo(0.91);
  });

  it('does not cache a version that fails the meaning check', async () => {
    nodes = [CURIE];
    replies = { n0: ['Marie Curie liked science.', 'Marie Curie liked rays.'] };
    scores = { 'Marie Curie liked science.': 0.5, 'Marie Curie liked rays.': 0.6 };

    await runSimplification(await storedDoc(), callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cacheKeys()).toHaveLength(0);
  });

  it('does not cache failed nodes', async () => {
    failing = new Set([NODES[1].text]);

    await runSimplification(await storedDoc(), callbacks(), 'all');

    expect(cacheKeys()).toHaveLength(2);
  });

  it('starts at startIndex, wraps around, and keeps document-order context', async () => {
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all', 1);

    expect(prompts.map(p => NODES.findIndex(n => p.endsWith(n.text)))).toEqual([1, 2, 0]);
    // n1 runs first, before n0 is done: no context. n2 follows n1 in the document.
    expect(prompts[0]).not.toContain('[Context from previous section');
    expect(prompts[1]).toContain('[Context from previous section: "Simple n1."]');
    // n0 is the first node in the document, so it never gets context
    expect(prompts[2]).not.toContain('[Context from previous section');
    expect(statuses(await getDocument(doc.id))).toEqual({ n0: 'done', n1: 'done', n2: 'done' });
  });

  it('uses the model from settings', async () => {
    await chrome.storage.sync.set({ llmModel: 'llama3.2:1b' });

    await runSimplification(await storedDoc(), callbacks(), 'all');

    expect(JSON.parse(String(showMock.mock.calls[0][1]?.body))).toEqual({ model: 'llama3.2:1b' });
    expect(models.length).toBe(NODES.length);
    expect(models.every(m => m === 'llama3.2:1b')).toBe(true);
  });

  it('stops before any node when the model is not pulled, naming the default but no command', async () => {
    await chrome.storage.sync.set({ llmModel: 'llama3.2:1b' });
    showStatus = 404;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cb = callbacks();

    await runSimplification(await storedDoc(), cb, 'all');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cb.onBannerError).toHaveBeenCalledTimes(1);
    const banner = String(cb.onBannerError.mock.calls[0][0]);
    expect(banner).toContain('llama3.2:1b');
    expect(banner).toContain(`The default is ${DEFAULT_LLM_MODEL}.`);
    expect(banner).not.toContain('ollama pull');
    const logged = log.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toContain('ollama pull llama3.2:1b');
    expect(logged).toContain(`ollama pull ${DEFAULT_LLM_MODEL}`);
  });

  it('names only the default model when the default is missing', async () => {
    showStatus = 404;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cb = callbacks();

    await runSimplification(await storedDoc(), cb, 'all');

    const banner = String(cb.onBannerError.mock.calls[0][0]);
    expect(banner).toContain(`The default model ${DEFAULT_LLM_MODEL} isn't installed`);
    expect(banner).not.toContain('ollama pull');
    expect(log.mock.calls.some(c => String(c[0]).includes(`ollama pull ${DEFAULT_LLM_MODEL}`))).toBe(true);
  });

  it('gives the same banner when the chat request 404s mid-run', async () => {
    await chrome.storage.sync.set({ llmModel: 'llama3.2:1b' });
    chatStatus = 404;
    const cb = callbacks();

    await runSimplification(await storedDoc(), cb, 'all');

    const banner = String(cb.onBannerError.mock.calls[0][0]);
    expect(banner).toContain(`The model llama3.2:1b isn't installed in Ollama.`);
    expect(banner).not.toContain('ollama pull');
  });

  it('sends think: false on every chat call to a thinking model, and no think otherwise', async () => {
    const bodies = () => fetchMock.mock.calls.map(c => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);

    showCapabilities = ['completion', 'thinking'];
    await runSimplification(await storedDoc(), callbacks(), 'all');
    expect(bodies().length).toBe(NODES.length);
    expect(bodies().every(b => b.think === false)).toBe(true);

    fetchMock.mockClear();
    showCapabilities = ['completion'];
    await runSimplification(await storedDoc('hash-run-2'), callbacks(), 'all');
    expect(bodies().length).toBe(NODES.length);
    expect(bodies().every(b => !('think' in b))).toBe(true);
  });

  it('logs per-node timings and a run summary', async () => {
    nodes = [EASY, NODES[1]];
    await setTargetGrade(4);

    await runSimplification(await storedDoc(), callbacks(), 'all');

    const lines = vi.mocked(console.log).mock.calls.map(c => String(c[0]));
    expect(lines).toContainEqual(expect.stringMatching(/^\[Clarity\] Node n0 \(skipped, meaning excluded\) \d+\.\d\d s$/));
    expect(lines).toContainEqual(expect.stringMatching(/^\[Clarity\] Node n1 \(model, meaning excluded\) /));
    expect(lines).toContainEqual(expect.stringMatching(
      /^\[Clarity\] Run: 2 nodes in .* 1 model, 0 cache, 0 headings, 1 skipped, 0 errors; .*model \S+; quality full; meaning passed n\/a \(0\/0\), coverage n\/a; NLI avg n\/a per paragraph \(backend webgpu nvidia\), truncated pairs 0\/0$/,
    ));
    expect(lines.find(l => l.startsWith('[Clarity] Run:'))).toContain(`model ${DEFAULT_LLM_MODEL};`);
    expect(lines).toContainEqual(expect.stringMatching(/^\[Clarity\] Quality mode full \(auto: WebGPU, benchmark 40 ms/));
  });
});

// ---------------------------------------------------------------------------
// runSimplification — stage 7: extra quality (prompt variants) and run log
// ---------------------------------------------------------------------------
describe('runSimplification extra quality', () => {
  /** Passes 6C, short and plain: scores above the quality threshold. */
  const GOOD = 'Marie Curie won a big prize in 1903.';
  /** Passes 6C (similarity 0.9, entity kept) but reads far above the target. */
  const HARD =
    'Marie Curie received the prestigious Nobel Prize in Physics in 1903, recognizing ' +
    'extraordinary investigations concerning radioactivity.';
  const STEP_MARK = 'Work in two steps, silently.';
  const EXAMPLE_MARK = 'Here is an example of the kind of rewrite wanted';

  const enableExtraQuality = () => chrome.storage.sync.set({ extraQuality: true });
  const lastLog = async (docId: string) => (await getDocument(docId))?.runLogs?.at(-1);

  beforeEach(async () => {
    nodes = [CURIE];
    await setTargetGrade(4);
  });

  it('keeps a standard version above the threshold with one call', async () => {
    await enableExtraQuality();
    replies = { n0: [GOOD] };
    scores = { [GOOD]: 0.95 };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const node = (await lastLog(doc.id))?.nodes[0];
    expect(node).toMatchObject({ source: 'model', variantUsed: 'standard', modelCalls: 1, retries: 0 });
    expect(node?.candidates[0].scores.total).toBeGreaterThanOrEqual(QUALITY_THRESHOLD);
  });

  it('tries both other variants when standard scores low, and keeps the best', async () => {
    await enableExtraQuality();
    replies = { n0: [HARD, 'Marie Curie liked science.', GOOD] };
    scores = { [HARD]: 0.9, 'Marie Curie liked science.': 0.82, [GOOD]: 0.93 };
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(prompts[0]).not.toContain(STEP_MARK);
    expect(prompts[1]).toContain(STEP_MARK);
    expect(prompts[2]).toContain(EXAMPLE_MARK);
    // Standard passed 6C, so the variants carry no meaning-retry instruction
    expect(prompts.slice(1).some(p => p.startsWith(RETRY_OPENING))).toBe(false);
    // Only the standard version is streamed
    expect(cb.onNodeChunk.mock.calls.map(c => c[1])).toEqual([HARD]);

    const saved = (await getDocument(doc.id))?.results[0];
    expect(saved?.simplifiedText).toBe(GOOD);
    expect(saved?.similarity).toBeCloseTo(0.93);
    const node = (await lastLog(doc.id))?.nodes[0];
    expect(node).toMatchObject({ variantUsed: 'example-guided', modelCalls: 3, retries: 2 });
    expect(node?.candidates.map(c => [c.variant, c.chosen])).toEqual([
      ['standard', false], ['stepwise', false], ['example-guided', true],
    ]);
    expect(node?.candidates[0].scores.total).toBeLessThan(QUALITY_THRESHOLD);
  });

  it('adds the meaning-retry instruction to the variants when standard fails 6C', async () => {
    await enableExtraQuality();
    replies = { n0: ['She liked science.', 'Marie Curie liked rays.', 'Marie Curie won in 1903.'] };
    scores = { 'She liked science.': 0.5, 'Marie Curie liked rays.': 0.6, 'Marie Curie won in 1903.': 0.9 };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(prompts[0].startsWith(RETRY_OPENING)).toBe(false);
    for (const prompt of prompts.slice(1)) {
      expect(prompt.startsWith(RETRY_OPENING)).toBe(true);
      expect(prompt).toContain('left out "Marie Curie"');
    }
    expect((await getDocument(doc.id))?.results[0].simplifiedText).toBe('Marie Curie won in 1903.');
    const node = (await lastLog(doc.id))?.nodes[0];
    expect(node?.candidates.map(c => c.retryInstruction)).toEqual([false, true, true]);
    expect(node?.candidates[0].missingEntities).toEqual(['Marie Curie']);
  });

  it('never makes more than 3 calls, even when every candidate is poor', async () => {
    await enableExtraQuality();
    // All keep the entity but fail the meaning threshold; a 4th reply is never asked for
    const [a, b, c, d] = ['was bad', 'was sad', 'was mad', 'was glad'].map(w => `Marie Curie ${w}.`);
    replies = { n0: [a, b, c, d] };
    scores = { [a]: 0.3, [b]: 0.4, [c]: 0.35, [d]: 0.9 };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(MAX_MODEL_CALLS_PER_NODE);
    const saved = (await getDocument(doc.id))?.results[0];
    expect(saved?.status).toBe('done');
    expect(saved?.simplifiedText).toBe(b);
  });

  it('keeps going when a variant request fails', async () => {
    await enableExtraQuality();
    replies = { n0: [HARD, FAIL, GOOD] };
    scores = { [HARD]: 0.9, [GOOD]: 0.93 };
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cb.onNodeError).not.toHaveBeenCalled();
    expect((await getDocument(doc.id))?.results[0].simplifiedText).toBe(GOOD);
    const node = (await lastLog(doc.id))?.nodes[0];
    expect(node?.modelCalls).toBe(3);
    expect(node?.candidates.map(c => c.variant)).toEqual(['standard', 'example-guided']);
  });

  it('never sends a heading to the model, even with extra quality', async () => {
    await enableExtraQuality();
    nodes = [{ id: 'n0', type: 'heading', level: 2, text: CURIE.text, entities: [] }];
    replies = { n0: [HARD] };

    await runSimplification(await storedDoc(), callbacks(), 'all');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('off: still logs the scored 6C retry, at most 2 calls', async () => {
    replies = { n0: ['Marie Curie liked science.', GOOD] };
    scores = { 'Marie Curie liked science.': 0.6, [GOOD]: 0.9 };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const log = await lastLog(doc.id);
    expect(log?.extraQuality).toBe(false);
    expect(log?.nodes[0]).toMatchObject({ variantUsed: 'standard', modelCalls: 2, retries: 1 });
    expect(log?.nodes[0].candidates.map(c => [c.retryInstruction, c.chosen])).toEqual([
      [false, false], [true, true],
    ]);
  });

  it('off: a low score alone does not trigger extra calls', async () => {
    replies = { n0: [HARD] };
    scores = { [HARD]: 0.9 };

    await runSimplification(await storedDoc(), callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches extra-quality results separately', async () => {
    replies = { n0: [GOOD, GOOD] };
    scores = { [GOOD]: 0.95 };
    await runSimplification(await storedDoc('hash-a'), callbacks(), 'remaining');
    await enableExtraQuality();
    fetchMock.mockClear();

    await runSimplification(await storedDoc('hash-b'), callbacks(), 'remaining');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cacheKeys()).toHaveLength(2);
  });
});

describe('runSimplification quality mode', () => {
  const GOOD_CURIE = 'Marie Curie won the Nobel Prize in 1903.';
  const DRIFT = 'Marie Curie liked science in 1903.';
  const SLOW_WASM: NliBenchRecord = {
    backend: 'wasm', adapterVendor: null, ms: 2000, predictedParagraphMs: 4500,
    version: 'dev', webgpuAdapter: false, device: 'auto', at: 1,
  };
  const lastLog = async (docId: string) => (await getDocument(docId))?.runLogs?.at(-1);
  const setMode = (qualityMode: string) => chrome.storage.sync.set({ qualityMode });

  beforeEach(() => {
    nodes = [CURIE];
    scores = { [GOOD_CURIE]: 0.92, [DRIFT]: 0.5 };
  });

  it('Lite skips NLI entirely and marks the result lite, not fully checked', async () => {
    await setMode('lite');
    replies = { n0: [GOOD_CURIE] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(prepareNliMock).not.toHaveBeenCalled();
    expect(checkEntailmentMock).not.toHaveBeenCalled();
    expect((await getDocument(doc.id))?.results[0]).toMatchObject({
      status: 'done', passed: true, nliChecked: false, lite: true, similarity: expect.closeTo(0.92),
    });
    const log = await lastLog(doc.id);
    expect(log).toMatchObject({ qualitySetting: 'lite', qualityMode: 'lite', qualityModeReason: 'set to Lite', nli: null });
    expect(log?.summary.meaning).toMatchObject({ notFullyChecked: 1, passRate: null });
  });

  it('Lite allows one retry and turns best-of-N off even with Extra quality on', async () => {
    await setMode('lite');
    await chrome.storage.sync.set({ extraQuality: true });
    replies = { n0: [DRIFT, GOOD_CURIE] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const log = await lastLog(doc.id);
    expect(log?.extraQuality).toBe(false);
    expect(log?.nodes[0]).toMatchObject({ modelCalls: 2, variantUsed: 'standard' });
    expect((await getDocument(doc.id))?.results[0].simplifiedText).toBe(GOOD_CURIE);
  });

  it('Auto picks Lite when the benchmark is slow and there is no WebGPU', async () => {
    nliBenchResult = SLOW_WASM;
    replies = { n0: [GOOD_CURIE] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(prepareNliMock).toHaveBeenCalledTimes(1);
    expect(checkEntailmentMock).not.toHaveBeenCalled();
    const log = await lastLog(doc.id);
    expect(log).toMatchObject({ qualitySetting: 'auto', qualityMode: 'lite' });
    expect(log?.qualityModeReason).toMatch(/no WebGPU.*4500 ms per paragraph > 3000/);
    expect((await getDocument(doc.id))?.results[0]).toMatchObject({ lite: true, nliChecked: false });
  });

  it('Auto picks Full on WebGPU and records the backend in the run log', async () => {
    replies = { n0: [GOOD_CURIE] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(checkEntailmentMock).toHaveBeenCalledTimes(1);
    const log = await lastLog(doc.id);
    expect(log).toMatchObject({
      qualityMode: 'full',
      nli: { backend: 'webgpu', adapterVendor: 'nvidia', dtype: 'q8', benchMs: 40, predictedParagraphMs: 90 },
    });
    expect((await getDocument(doc.id))?.results[0].lite).toBeUndefined();
  });

  it('records fp16 weights in the run log and the summary line', async () => {
    nliBenchResult = { ...FAST_WEBGPU, dtype: 'fp16', device: 'webgpu-fp16' };
    nodes = [CURIE];
    replies = { n0: ['Marie Curie won the Nobel Prize in 1903.'] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect((await getDocument(doc.id))?.runLogs?.at(-1)?.nli).toMatchObject({ backend: 'webgpu', dtype: 'fp16' });
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0])))
      .toContainEqual(expect.stringMatching(/\(backend webgpu fp16 nvidia\)/));
  });

  it('Auto decides from a matching stored benchmark without loading the model', async () => {
    await chrome.storage.local.set({ 'nli:bench': SLOW_WASM });
    replies = { n0: [GOOD_CURIE] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(prepareNliMock).not.toHaveBeenCalled();
    expect((await lastLog(doc.id))?.qualityMode).toBe('lite');
  });

  it('Auto measures again when the stored benchmark is from another version', async () => {
    await chrome.storage.local.set({ 'nli:bench': { ...SLOW_WASM, version: '0.9.0' } });
    replies = { n0: [GOOD_CURIE] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(prepareNliMock).toHaveBeenCalledTimes(1);
    expect((await lastLog(doc.id))?.qualityMode).toBe('full');
  });

  it('embeds the original once per node and passes the embedder to NLI for premise ranking', async () => {
    await setMode('full');
    replies = { n0: [DRIFT, GOOD_CURIE] };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    const embedded = embedSpy.mock.calls.flatMap(c => c[0]);
    expect(embedded.filter(t => t === CURIE.text)).toHaveLength(1);
    expect(checkEntailmentMock).toHaveBeenCalledTimes(2);
    const options = checkEntailmentMock.mock.calls[0][4];
    expect(options).toMatchObject({ label: 'n0', embed: expect.any(Function) });
  });
});

describe('runSimplification run log', () => {
  it('records every node with its source, time and the run settings', async () => {
    nodes = [EASY, NODES[1]];
    await setTargetGrade(4);
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    const logs = (await getDocument(doc.id))?.runLogs;
    expect(logs).toHaveLength(1);
    const log = logs![0];
    expect(log).toMatchObject({
      cancelled: false, mode: 'all', model: DEFAULT_LLM_MODEL, extraQuality: false,
      targetGrade: 4, qualityThreshold: QUALITY_THRESHOLD,
      weights: { meaning: 0.5, readability: 0.3, length: 0.2 },
    });
    expect(log.summary.counts).toEqual({ model: 1, cache: 0, heading: 0, skipped: 1, error: 0 });
    expect(log.nodes.map(n => [n.nodeId, n.source, n.modelCalls])).toEqual([
      ['n0', 'skipped', 0], ['n1', 'model', 1],
    ]);
    expect(log.nodes[1].candidates).toHaveLength(1);
    expect(typeof log.nodes[1].ms).toBe('number');
  });

  it('logs cache hits and errors', async () => {
    await runSimplification(await storedDoc('hash-a'), callbacks(), 'remaining');
    failing = new Set([NODES[2].text]);
    const keys = cacheKeys();
    const second = await storedDoc('hash-b');
    // Drop n2's cache entry (the last one written) so it goes to the failing model
    await chrome.storage.local.remove(keys[keys.length - 1]);

    await runSimplification(second, callbacks(), 'remaining');

    const log = (await getDocument(second.id))?.runLogs?.[0];
    expect(log?.nodes.map(n => n.source)).toEqual(['cache', 'cache', 'error']);
    expect(log?.nodes[2]).toMatchObject({ modelCalls: 1, variantUsed: null, candidates: [] });
  });

  it('keeps the last 5 runs', async () => {
    const doc = await storedDoc();
    for (let i = 0; i < 6; i++) await runSimplification((await getDocument(doc.id))!, callbacks(), 'all');
    expect((await getDocument(doc.id))?.runLogs).toHaveLength(5);
  });

  it('records the meaning standard of the run', async () => {
    const doc = await storedDoc();
    await runSimplification(doc, callbacks(), 'all');
    expect((await getDocument(doc.id))?.runLogs?.[0].meaningThresholds).toEqual({
      similarity: 0.87, entailmentMin: ENTAILMENT_MIN, contradictionMax: 0.2, glossaryExemptionMaxRate: 0.3,
      nliModel: 'Xenova/nli-deberta-v3-xsmall',
      premiseStrategy: 'summac-sentences+pairs/top3', contradictionAggregation: NLI_CONTRADICTION_AGG,
      paragraphRule: NLI_PARAGRAPH_RULE,
      hypothesisContext: 'prev-sentence-if-<7-words-or-referring',
      entityRecallMin: 1,
      verdict: 'combined-score',
      scoreModels: { full: COMBINED_SCORE_FULL, lite: COMBINED_SCORE_LITE },
    });
  });

  it('after a run: keeps the report, saves the simplified report and records one session', async () => {
    const doc = await storedDoc();
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    const saved = await getDocument(doc.id);
    expect(saved?.report).toEqual(makeReport());
    expect(beforeAfterOf(saved)).not.toBeNull();
    expect((await getWeeklyProgress()).map(w => w.sessionCount)).toEqual([1]);
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0]))).toContain('[Clarity] Session recorded (1 this week)');
    expect(cb.onComplete).toHaveBeenCalledTimes(1);
  });

  it('counts every finished run as a session', async () => {
    const doc = await storedDoc();
    await runSimplification(doc, callbacks(), 'all');
    await runSimplification((await getDocument(doc.id))!, callbacks(), 'all');
    expect((await getWeeklyProgress()).map(w => w.sessionCount)).toEqual([2]);
  });

  it('records the session when the cancel arrives after the last node', async () => {
    const doc = await storedDoc();
    const controller = new AbortController();
    let done = 0;
    const cb = {
      ...callbacks(),
      signal: controller.signal,
      onNodeDone: vi.fn(() => { if (++done === NODES.length) controller.abort(); }),
    };

    await runSimplification(doc, cb, 'all');

    expect((await getWeeklyProgress()).map(w => w.sessionCount)).toEqual([1]);
    expect(beforeAfterOf(await getDocument(doc.id))).not.toBeNull();
  });

  it('a run cancelled midway saves the simplified report of its done nodes but records no session', async () => {
    const doc = await storedDoc();
    const controller = new AbortController();
    const cb = { ...callbacks(), signal: controller.signal, onNodeDone: vi.fn(() => controller.abort()) };

    await runSimplification(doc, cb, 'all');

    expect(mock.areas.local.data.has('progress:weekly')).toBe(false);
    expect((await getDocument(doc.id))?.simplifiedReport).not.toBeNull();
  });

  it('still records the session and completes when saving the simplified report fails', async () => {
    const doc = await storedDoc();
    const realSet = mock.areas.local.set.bind(mock.areas.local);
    vi.spyOn(mock.areas.local, 'set').mockImplementation(async (items: Record<string, unknown>) => {
      const value = items[`doc:${doc.id}`] as { simplifiedReport?: unknown } | undefined;
      if (value?.simplifiedReport) throw new Error('QUOTA_BYTES quota exceeded');
      return realSet(items);
    });
    const cb = callbacks();

    await runSimplification(doc, cb, 'all');

    expect((await getWeeklyProgress()).map(w => w.sessionCount)).toEqual([1]);
    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls.map(c => String(c[0])))
      .toContain('[Clarity] Saving the simplified report failed');
  });

  it('saves a log marked cancelled when the run is cancelled', async () => {
    const doc = await storedDoc();
    const controller = new AbortController();
    const cb = { ...callbacks(), signal: controller.signal, onNodeDone: vi.fn(() => controller.abort()) };

    await runSimplification(doc, cb, 'all');

    // Cancelled while n0 finished: n0 is logged, n1 and n2 never start
    const log = (await getDocument(doc.id))?.runLogs?.[0];
    expect(log?.cancelled).toBe(true);
    expect(log?.nodes.map(n => n.nodeId)).toEqual(['n0']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cb.onComplete).toHaveBeenCalledTimes(1);
  });
});
