import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClarityDocument, ContentNode, StoredResult } from '../../src/types';
import { installChromeMock } from '../mocks/chrome';
import { makeDocInput, makeReport } from '../mocks/fixtures';

// The real segmenter needs DOMParser; a fixed node list keeps this test in the
// node environment (happy-dom is confined to segmenter.test.ts).
const NODES: ContentNode[] = [
  { id: 'n0', type: 'paragraph', text: 'Alpha paragraph text.', entities: [] },
  { id: 'n1', type: 'paragraph', text: 'Beta paragraph text.', entities: [] },
  { id: 'n2', type: 'paragraph', text: 'Gamma paragraph text.', entities: [] },
];
vi.mock('../../src/lib/segmentation/segmenter', () => ({
  segmentHtml: (_html: string, title: string, contentHash: string) => ({ title, contentHash, nodes: NODES }),
}));

const { runSimplification, selectNodesToRun } = await import('../../src/lib/run/simplify');
const { getDocument, upsertDocument, saveDocument } = await import('../../src/lib/storage/documents');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Node texts whose request should fail with HTTP 500. */
let failing: Set<string>;
/** User prompts sent to the model, in order. */
let prompts: string[];

function ndjson(content: string): Response {
  const body =
    JSON.stringify({ message: { content }, done: false }) + '\n' +
    JSON.stringify({ message: { content: '' }, done: true }) + '\n';
  return new Response(body, { status: 200 });
}

const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const { messages } = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
  const user = messages[1].content;
  prompts.push(user);
  const node = NODES.find(n => user.endsWith(n.text));
  if (!node || failing.has(node.text)) return new Response('boom', { status: 500 });
  return ndjson(`Simple ${node.id}.`);
});

function callbacks() {
  return {
    onProgress: vi.fn(), onNodeStart: vi.fn(), onNodeChunk: vi.fn(), onNodeDone: vi.fn(),
    onNodeError: vi.fn(), onBannerError: vi.fn(), onComplete: vi.fn(),
    signal: new AbortController().signal,
  };
}

async function storedDoc(): Promise<ClarityDocument> {
  return upsertDocument(makeDocInput('hash-run', { report: makeReport() }));
}

function result(nodeId: string, status: StoredResult['status'], simplifiedText = ''): StoredResult {
  const node = NODES.find(n => n.id === nodeId)!;
  return { nodeId, originalText: node.text, simplifiedText, status, type: 'paragraph' };
}

const statuses = (doc: ClarityDocument | null) =>
  Object.fromEntries((doc?.results ?? []).map(r => [r.nodeId, r.status]));

beforeEach(() => {
  installChromeMock();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock.mockClear();
  failing = new Set();
  prompts = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// selectNodesToRun — 'remaining' vs 'all'
// ---------------------------------------------------------------------------
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
