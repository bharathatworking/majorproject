import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { ClarityDocument, ContentNode, StoredResult } from '../../src/types';
import { installChromeMock, type ChromeMock } from '../mocks/chrome';
import { makeDocInput, makeReport } from '../mocks/fixtures';

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

/** Easy enough (estimated grade below 0) to be skipped at any target. */
const EASY: ContentNode = { id: 'n0', type: 'paragraph', text: 'The cat sat on the mat.', entities: [] };

const { runSimplification, selectNodesToRun, rotateFrom, EMBED_MISSING_NOTICE } = await import('../../src/lib/run/simplify');
const { DEFAULT_PROFILE } = await import('../../src/lib/storage/settings');
const { getDocument, upsertDocument, saveDocument } = await import('../../src/lib/storage/documents');
const { OllamaProvider, OllamaHttpError } = await import('../../src/lib/llm/ollama-provider');
const { MEANING_RETRY_INSTRUCTION } = await import('../../src/lib/quality/semantic');

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
  const node = nodes.find(n => user.endsWith(n.text));
  if (!node || failing.has(node.text)) return new Response('boom', { status: 500 });
  const reply = replies[node.id]?.shift() ?? `Simple ${node.id}.`;
  if (reply === FAIL) return new Response('boom', { status: 500 });
  return ndjson(reply);
});

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
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  embedSpy = vi.spyOn(OllamaProvider.prototype, 'embed').mockImplementation(fakeEmbed);
  fetchMock.mockClear();
  failing = new Set();
  prompts = [];
  replies = {};
  scores = {};
  chatStatus = null;
  models = [];
  nodes = NODES;
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    expect(cb.onNodeDone).toHaveBeenCalledWith('n0', reply, expect.closeTo(0.93));
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
    expect(prompts[0].startsWith(MEANING_RETRY_INSTRUCTION)).toBe(false);
    expect(prompts[1].startsWith(`${MEANING_RETRY_INSTRUCTION}\n\n`)).toBe(true);
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
    expect(cb.onNodeDone).toHaveBeenLastCalledWith('n0', first, expect.closeTo(0.7));
  });

  it('retries on a missing entity and keeps the retry that restores it', async () => {
    const first = 'She won the Nobel Prize in 1903.';
    const retry = 'Marie Curie won the Nobel Prize in 1903.';
    nodes = [CURIE];
    replies = { n0: [first, retry] };
    scores = { [first]: 0.95, [retry]: 0.86 };
    const doc = await storedDoc();

    await runSimplification(doc, callbacks(), 'all');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await savedResult(doc.id, 'n0'))?.simplifiedText).toBe(retry);
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
// runSimplification — speed: skip easy nodes, cache, start at visible node
// ---------------------------------------------------------------------------
describe('runSimplification speed paths', () => {
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
    expect(cb.onNodeDone).toHaveBeenCalledWith('n0', reply, expect.closeTo(0.91));
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

  it('uses the model from settings and names it when it is missing', async () => {
    await chrome.storage.sync.set({ llmModel: 'llama3.2:1b' });
    chatStatus = 404;
    const cb = callbacks();

    await runSimplification(await storedDoc(), cb, 'all');

    expect(models.length).toBeGreaterThan(0);
    expect(models.every(m => m === 'llama3.2:1b')).toBe(true);
    expect(cb.onBannerError).toHaveBeenCalledWith('Model not found on Ollama. Run: ollama pull llama3.2:1b');
  });

  it('logs per-node timings and a run summary', async () => {
    nodes = [EASY, NODES[1]];
    await setTargetGrade(4);

    await runSimplification(await storedDoc(), callbacks(), 'all');

    const lines = vi.mocked(console.log).mock.calls.map(c => String(c[0]));
    expect(lines).toContainEqual(expect.stringMatching(/^\[Clarity\] Node n0 \(skipped\) \d+\.\d\d s$/));
    expect(lines).toContainEqual(expect.stringMatching(/^\[Clarity\] Node n1 \(model\) /));
    expect(lines).toContainEqual(expect.stringMatching(
      /^\[Clarity\] Run: 2 nodes in .* 1 model, 0 cache, 1 skipped, 0 errors; .*model qwen2\.5:3b$/,
    ));
  });
});
