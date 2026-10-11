/**
 * Document store for Clarity.
 *
 * Storage layout in chrome.storage.local:
 *   doc:<id>       — full ClarityDocument object
 *   docs:index     — InternalIndexEntry[] (sidebar list + contentHash for dedup)
 *   docs:active    — string (active document id)
 *
 * All mutating operations are serialized through a promise queue to prevent
 * read-modify-write races when multiple events fire in quick succession.
 */

import type { ClarityDocument, DocumentIndexEntry } from '../../types';

const MAX_DOCS = 10;
const DOC_PREFIX = 'doc:';
const INDEX_KEY = 'docs:index';
const ACTIVE_KEY = 'docs:active';

/**
 * Internal index entry — identical to the public DocumentIndexEntry but adds
 * `contentHash` for O(1) dedup without loading full documents.
 * The extra field is transparent to callers: `listDocuments` strips it.
 */
interface InternalIndexEntry extends DocumentIndexEntry {
  contentHash: string;
}

// ─── Write queue ─────────────────────────────────────────────────────────────
// Ensures that concurrent upserts/saves/deletes don't interleave their reads
// and writes. Each enqueued fn executes only after the previous one resolves
// (or rejects — the queue itself never stops moving).
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn);
  writeQueue = result.catch(() => {});
  return result;
}

// ─── Read helpers (no queue needed — reads are idempotent) ───────────────────

export async function listDocuments(): Promise<DocumentIndexEntry[]> {
  const { [INDEX_KEY]: raw } = await chrome.storage.local.get(INDEX_KEY);
  return ((raw as InternalIndexEntry[]) ?? []).map(toPublicEntry);
}

export async function getDocument(id: string): Promise<ClarityDocument | null> {
  const key = `${DOC_PREFIX}${id}`;
  const { [key]: doc } = await chrome.storage.local.get(key);
  return (doc as ClarityDocument) ?? null;
}

export async function getActiveId(): Promise<string | null> {
  const { [ACTIVE_KEY]: id } = await chrome.storage.local.get(ACTIVE_KEY);
  return (id as string) ?? null;
}

// ─── Write helpers ────────────────────────────────────────────────────────────

export function setActiveId(id: string): Promise<void> {
  return enqueue(() => chrome.storage.local.set({ [ACTIVE_KEY]: id }));
}

/**
 * Insert or refresh a document, deduplicated by contentHash.
 *
 * - **Existing hash:** refresh `updatedAt` and `title`, make active, keep
 *   existing `results`, `report`, and `simplifiedReport` intact.
 * - **New hash:** insert; if at MAX_DOCS cap, evict the oldest non-active
 *   document first.
 *
 * Returns the final stored document.
 */
export function upsertDocument(
  incoming: Omit<ClarityDocument, 'id' | 'createdAt' | 'updatedAt' | 'results' | 'simplifiedReport'>,
): Promise<ClarityDocument> {
  return enqueue(async () => {
    const stored = await chrome.storage.local.get([INDEX_KEY, ACTIVE_KEY]);
    let index: InternalIndexEntry[] = stored[INDEX_KEY] ?? [];
    const currentActiveId: string | null = stored[ACTIVE_KEY] ?? null;

    // Fast dedup: index stores contentHash so we don't load all full documents
    const existingEntry = index.find(e => e.contentHash === incoming.contentHash);

    let doc: ClarityDocument;

    if (existingEntry) {
      // Load and refresh the existing document
      const key = `${DOC_PREFIX}${existingEntry.id}`;
      const { [key]: raw } = await chrome.storage.local.get(key);
      const existing = raw as ClarityDocument;
      doc = {
        ...existing,
        title: incoming.title,
        updatedAt: Date.now(),
        ...(incoming.sourceUrl !== undefined && { sourceUrl: incoming.sourceUrl }),
      };
      await chrome.storage.local.set({ [key]: doc });
      index = index.map(e =>
        e.id === doc.id ? { ...e, title: doc.title, updatedAt: doc.updatedAt } : e,
      );
    } else {
      // New document
      doc = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        results: [],
        simplifiedReport: null,
        ...incoming,
      };

      // Enforce cap: evict the oldest non-active document
      if (index.length >= MAX_DOCS) {
        const sorted = [...index].sort((a, b) => a.updatedAt - b.updatedAt);
        const toEvict = sorted.find(e => e.id !== currentActiveId);
        if (toEvict) {
          index = index.filter(e => e.id !== toEvict.id);
          await chrome.storage.local.remove(`${DOC_PREFIX}${toEvict.id}`);
        }
      }

      await chrome.storage.local.set({ [`${DOC_PREFIX}${doc.id}`]: doc });
      const newEntry: InternalIndexEntry = {
        id: doc.id,
        title: doc.title,
        source: doc.source,
        updatedAt: doc.updatedAt,
        hasResults: false,
        contentHash: doc.contentHash,
      };
      index = [...index, newEntry];
    }

    // Sort newest-first and flush
    index.sort((a, b) => b.updatedAt - a.updatedAt);
    await chrome.storage.local.set({ [INDEX_KEY]: index, [ACTIVE_KEY]: doc.id });
    return doc;
  });
}

/**
 * Persist a full document after the app updates it (e.g. adds a computed report
 * or saves per-node simplification results).
 */
export function saveDocument(doc: ClarityDocument): Promise<void> {
  return enqueue(async () => {
    const now = Date.now();
    const updated: ClarityDocument = { ...doc, updatedAt: now };
    await chrome.storage.local.set({ [`${DOC_PREFIX}${doc.id}`]: updated });

    const { [INDEX_KEY]: rawIndex } = await chrome.storage.local.get(INDEX_KEY);
    let index: InternalIndexEntry[] = rawIndex ?? [];
    index = index.map(e =>
      e.id === doc.id
        ? {
            ...e,
            title: updated.title,
            updatedAt: now,
            hasResults: updated.results.some(r => r.status === 'done'),
          }
        : e,
    );
    index.sort((a, b) => b.updatedAt - a.updatedAt);
    await chrome.storage.local.set({ [INDEX_KEY]: index });
  });
}

export function deleteDocument(id: string): Promise<void> {
  return enqueue(async () => {
    await chrome.storage.local.remove(`${DOC_PREFIX}${id}`);
    const stored = await chrome.storage.local.get([INDEX_KEY, ACTIVE_KEY]);
    let index: InternalIndexEntry[] = stored[INDEX_KEY] ?? [];
    const activeId: string | null = stored[ACTIVE_KEY] ?? null;
    index = index.filter(e => e.id !== id);
    const updates: Record<string, unknown> = { [INDEX_KEY]: index };
    // If we deleted the active doc, promote the next newest
    if (activeId === id) updates[ACTIVE_KEY] = index[0]?.id ?? null;
    await chrome.storage.local.set(updates);
  });
}

/**
 * Removes all doc:* keys, docs:index, and docs:active.
 * Deliberately does NOT touch progress:weekly or any other namespace.
 */
export function clearAllDocuments(): Promise<void> {
  return enqueue(async () => {
    const { [INDEX_KEY]: rawIndex } = await chrome.storage.local.get(INDEX_KEY);
    const index: InternalIndexEntry[] = rawIndex ?? [];
    const docKeys = index.map(e => `${DOC_PREFIX}${e.id}`);
    if (docKeys.length > 0) await chrome.storage.local.remove(docKeys);
    await chrome.storage.local.remove([INDEX_KEY, ACTIVE_KEY]);
  });
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function toPublicEntry(e: InternalIndexEntry): DocumentIndexEntry {
  return { id: e.id, title: e.title, source: e.source, updatedAt: e.updatedAt, hasResults: e.hasResults };
}
