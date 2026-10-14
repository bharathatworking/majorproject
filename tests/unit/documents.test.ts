import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getActiveId, getDocument, listDocuments, saveDocument, setActiveId, upsertDocument,
} from '../../src/lib/storage/documents';
import { installChromeMock, type ChromeMock } from '../mocks/chrome';
import { makeDocInput } from '../mocks/fixtures';

let mock: ChromeMock;
let clock: number;

/** Advances the fake clock so every write gets a distinct, ordered updatedAt. */
function tick() {
  clock += 1000;
  vi.setSystemTime(clock);
}

beforeEach(() => {
  mock = installChromeMock();
  clock = Date.UTC(2026, 0, 1);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// upsertDocument — dedup by contentHash
// ---------------------------------------------------------------------------
describe('upsertDocument dedup', () => {
  it('reuses the existing document for identical content', async () => {
    const first = await upsertDocument(makeDocInput('hash-a', { title: 'Old title' }));
    tick();
    const second = await upsertDocument(makeDocInput('hash-a', { title: 'New title' }));

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('New title');
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    const index = await listDocuments();
    expect(index).toHaveLength(1);
    expect(index[0].title).toBe('New title');
    expect(await getActiveId()).toBe(first.id);
  });

  it('keeps existing results when content is re-captured', async () => {
    const doc = await upsertDocument(makeDocInput('hash-a'));
    await saveDocument({
      ...doc,
      results: [{
        nodeId: 'n0', originalText: 'Some text.', simplifiedText: 'Text.', status: 'done', type: 'paragraph',
      }],
    });
    tick();
    const again = await upsertDocument(makeDocInput('hash-a'));

    expect(again.results).toHaveLength(1);
    expect(again.results[0].simplifiedText).toBe('Text.');
    expect((await listDocuments())[0].hasResults).toBe(true);
  });

  it('stores a new document for different content', async () => {
    const a = await upsertDocument(makeDocInput('hash-a'));
    tick();
    const b = await upsertDocument(makeDocInput('hash-b'));

    expect(b.id).not.toBe(a.id);
    expect(await listDocuments()).toHaveLength(2);
    expect(await getActiveId()).toBe(b.id);
  });

  it('drops a stale index entry whose document is missing', async () => {
    const a = await upsertDocument(makeDocInput('hash-a'));
    mock.areas.local.data.delete(`doc:${a.id}`);
    tick();
    const again = await upsertDocument(makeDocInput('hash-a'));

    expect(again.id).not.toBe(a.id);
    const index = await listDocuments();
    expect(index.map(e => e.id)).toEqual([again.id]);
    expect(await getDocument(again.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upsertDocument — 10-document cap
// ---------------------------------------------------------------------------
describe('upsertDocument cap', () => {
  async function insertMany(count: number) {
    const docs = [];
    for (let i = 0; i < count; i++) {
      tick();
      docs.push(await upsertDocument(makeDocInput(`hash-${i}`)));
    }
    return docs;
  }

  it('keeps at most 10 documents, evicting the oldest', async () => {
    const docs = await insertMany(11);

    const index = await listDocuments();
    expect(index).toHaveLength(10);
    expect(index.map(e => e.id)).not.toContain(docs[0].id);
    expect(await getDocument(docs[0].id)).toBeNull();
    expect(mock.areas.local.data.has(`doc:${docs[0].id}`)).toBe(false);
    expect(await getDocument(docs[10].id)).not.toBeNull();
  });

  it('never evicts the active document, even when it is the oldest', async () => {
    const docs = await insertMany(10);
    await setActiveId(docs[0].id);
    tick();
    const extra = await upsertDocument(makeDocInput('hash-extra'));

    const ids = (await listDocuments()).map(e => e.id);
    expect(ids).toHaveLength(10);
    expect(ids).toContain(docs[0].id);     // active and oldest: kept
    expect(ids).not.toContain(docs[1].id); // oldest non-active: evicted
    expect(ids).toContain(extra.id);
  });

  it('lists documents newest first', async () => {
    const docs = await insertMany(3);
    expect((await listDocuments()).map(e => e.id)).toEqual([docs[2].id, docs[1].id, docs[0].id]);
  });
});
