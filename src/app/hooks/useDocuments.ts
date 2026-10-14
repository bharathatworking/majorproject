import { useState, useEffect, useCallback } from 'react';
import {
  listDocuments,
  getDocument,
  getActiveId,
  setActiveId as setActiveIdStorage,
  deleteDocument,
} from '../../lib/storage/documents';
import type { ClarityDocument, DocumentIndexEntry } from '../../types';

export interface UseDocumentsReturn {
  docs: DocumentIndexEntry[];
  activeId: string | null;
  activeDoc: ClarityDocument | null;
  loading: boolean;
  switchDoc: (id: string) => Promise<void>;
  removeDoc: (id: string) => Promise<void>;
  setActiveDoc: React.Dispatch<React.SetStateAction<ClarityDocument | null>>;
}

/**
 * Hook that owns the document list and active document state.
 *
 * Initial state is loaded from chrome.storage.local. Subsequent changes
 * (from the background worker or other tabs) are delivered via
 * chrome.storage.onChanged so the sidebar and dashboard always stay current.
 */
export function useDocuments(): UseDocumentsReturn {
  const [docs, setDocs] = useState<DocumentIndexEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDoc, setActiveDoc] = useState<ClarityDocument | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Initial load ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [index, id] = await Promise.all([listDocuments(), getActiveId()]);
      if (cancelled) return;
      setDocs(index);
      setActiveId(id);
      if (id) {
        const doc = await getDocument(id);
        if (!cancelled) setActiveDoc(doc);
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Storage change listener ─────────────────────────────────────────────────
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;

      if ('docs:index' in changes) {
        setDocs((changes['docs:index'].newValue as DocumentIndexEntry[]) ?? []);
      }

      if ('docs:active' in changes) {
        const newId = (changes['docs:active'].newValue as string) ?? null;
        setActiveId(newId);
        if (newId) {
          getDocument(newId).then(doc => setActiveDoc(doc));
        } else {
          setActiveDoc(null);
        }
        return;
      }

      // The active document itself was rewritten (e.g. saveDocument after each
      // simplified node, or the post-run simplifiedReport). Without this, the
      // app keeps the pre-run copy and finished results vanish when the run ends.
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith('doc:')) continue;
        const updated = (change.newValue as ClarityDocument | undefined) ?? null;
        if (!updated) continue;
        setActiveDoc(prev => (prev?.id === updated.id ? updated : prev));
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────────────
  const switchDoc = useCallback(async (id: string) => {
    await setActiveIdStorage(id);
    // storage.onChanged delivers the update to state
  }, []);

  const removeDoc = useCallback(async (id: string) => {
    await deleteDocument(id);
    // storage.onChanged updates state
  }, []);

  return { docs, activeId, activeDoc, loading, switchDoc, removeDoc, setActiveDoc };
}
