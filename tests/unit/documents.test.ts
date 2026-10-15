import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  addRunLog, getActiveId, getDocument, listDocuments, saveDocument, setActiveId, upsertDocument,
} from '../../src/lib/storage/documents';
import { MAX_RUN_LOGS } from '../../src/lib/run/run-log';
import type { RunLog } from '../../src/types';
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

// ---------------------------------------------------------------------------
// addRunLog — run logs are owned by addRunLog, not saveDocument
// ---------------------------------------------------------------------------
describe('addRunLog', () => {
  const runLog = (id: string) => ({ id }) as unknown as RunLog;

  it('appends to the stored document, keeping the newest MAX_RUN_LOGS', async () => {
    const doc = await upsertDocument(makeDocInput('h-log'));
    for (let i = 0; i < MAX_RUN_LOGS + 2; i++) await addRunLog(doc.id, runLog(`r${i}`));

    const ids = (await getDocument(doc.id))?.runLogs?.map(l => l.id);
    expect(ids).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
  });

  it('survives a saveDocument with an older copy of the document', async () => {
    const stale = await upsertDocument(makeDocInput('h-stale'));
    await addRunLog(stale.id, runLog('kept'));

    await saveDocument({ ...stale, title: 'Renamed', runLogs: [runLog('stale')] });

    const saved = await getDocument(stale.id);
    expect(saved?.title).toBe('Renamed');
    expect(saved?.runLogs?.map(l => l.id)).toEqual(['kept']);
  });

  it('does not let saveDocument add logs', async () => {
    const doc = await upsertDocument(makeDocInput('h-none'));
    await saveDocument({ ...doc, runLogs: [runLog('ignored')] });
    expect((await getDocument(doc.id))?.runLogs).toBeUndefined();
  });

  it('leaves a deleted document deleted', async () => {
    await addRunLog('missing-id', runLog('x'));
    expect(await getDocument('missing-id')).toBeNull();
  });
});
