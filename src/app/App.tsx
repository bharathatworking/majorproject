import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Sidebar } from './components/Sidebar';
import { ToastContainer } from './components/Toast';
import { NewDocDialog } from './components/NewDocDialog';
import { Dashboard } from './pages/Dashboard';
import { Reading } from './pages/Reading';
import { Settings } from './pages/Settings';
import { useDocuments } from './hooks/useDocuments';
import { useRunState } from './hooks/useRunState';
import { useDisplayPrefs } from './hooks/useDisplayPrefs';
import { OllamaProvider } from '../lib/llm/ollama-provider';
import type { CaptureStatus, ClarityDocument, LLMAvailability, NavPage, NewDocTab, RunMode } from '../types';
import type { ToastItem } from './components/Toast';

// ─── Constants ──────────────────────────────────────────────────────────────

const VALID_PAGES: NavPage[] = ['dashboard', 'reading', 'progress', 'settings'];
const AVAILABILITY_POLL_MS = 30_000;
const ollamaProvider = new OllamaProvider();

// Chart.js is only needed on Progress, so that page is its own chunk
const Progress = lazy(() => import('./pages/Progress').then(m => ({ default: m.Progress })));

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseHash(): NavPage {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (VALID_PAGES.includes(raw as NavPage) ? raw : 'dashboard') as NavPage;
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [nav, setNav] = useState<NavPage>(parseHash);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Tab the New document dialog opens on; null while the dialog is closed
  const [newDocTab, setNewDocTab] = useState<NewDocTab | null>(null);
  const [availability, setAvailability] = useState<LLMAvailability | 'checking'>('checking');
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Reading page shows this doc — separate from activeDoc so a background
  // capture arriving during a run doesn't flip the reading view.
  const [readingDoc, setReadingDoc] = useState<ClarityDocument | null>(null);

  const tabIdRef   = useRef<number | null>(null);
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  const { docs, activeId, activeDoc, loading, switchDoc, removeDoc, setActiveDoc } = useDocuments();
  const { runState, startRun, cancelRun, dismissError, dismissNotice } = useRunState();
  const { prefs: displayPrefs, updatePrefs } = useDisplayPrefs();

  // ── 1. Register this tab ────────────────────────────────────────────────────
  useEffect(() => {
    chrome.tabs.getCurrent().then(tab => {
      if (tab?.id !== undefined) {
        tabIdRef.current = tab.id;
        chrome.storage.session.set({ appTabId: tab.id });
      }
    });
    const onPageHide = () => chrome.storage.session.remove('appTabId');
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // ── 2. Load initial capture:status ─────────────────────────────────────────
  useEffect(() => {
    chrome.storage.session.get<{ 'capture:status'?: CaptureStatus }>('capture:status').then(data => {
      setCaptureStatus(data['capture:status'] ?? null);
    });
  }, []);

  // ── 3. Live storage listener (capture:status via session) ──────────────────
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'session' && 'capture:status' in changes) {
        setCaptureStatus((changes['capture:status'].newValue as CaptureStatus) ?? null);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // ── 4. Sync readingDoc with activeDoc (guarded by run lock) ────────────────
  // When a new document arrives from a toolbar click while a run is active,
  // we show a toast but DO NOT switch the reading view.
  const prevActiveIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevActiveIdRef.current;
    prevActiveIdRef.current = activeDoc?.id ?? null;

    if (runState?.active && prevId !== null && activeDoc?.id !== prevId) {
      // New doc arrived during an active run — toast, don't switch reading view
      setToasts(prev => [...prev, {
        id: crypto.randomUUID(),
        message: `New document captured: ${activeDoc?.title ?? 'document'}`,
        type: 'info',
      }]);
    } else {
      setReadingDoc(activeDoc);
    }
  }, [activeDoc?.id]);   // intentionally not including runState to avoid loops

  // When run ends, sync reading doc to latest active doc
  useEffect(() => {
    if (!runState?.active) setReadingDoc(activeDoc);
  }, [runState?.active]);

  // Keep readingDoc fresh when the same document is re-saved (per-node results,
  // simplifiedReport). The final save can land after the run-end sync above.
  useEffect(() => {
    if (activeDoc) setReadingDoc(prev => (prev?.id === activeDoc.id ? activeDoc : prev));
  }, [activeDoc]);

  // ── 5. Ollama availability polling ─────────────────────────────────────────
  const checkAvailability = useCallback(async () => {
    const status = await ollamaProvider.checkAvailability();
    setAvailability(status);
  }, []);

  useEffect(() => {
    checkAvailability();
    pollRef.current = setInterval(checkAvailability, AVAILABILITY_POLL_MS);
    window.addEventListener('focus', checkAvailability);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      window.removeEventListener('focus', checkAvailability);
    };
  }, [checkAvailability]);

  // ── 6. Hash-based navigation ────────────────────────────────────────────────
  const navigate = useCallback((page: NavPage) => {
    setNav(page);
    window.location.hash = `#/${page}`;
  }, []);

  useEffect(() => {
    const handler = () => setNav(parseHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  // ── 7. Responsive sidebar ───────────────────────────────────────────────────
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    setSidebarCollapsed(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSidebarCollapsed(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // ── 8. Toast helpers ────────────────────────────────────────────────────────
  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // ── 9. Handlers ─────────────────────────────────────────────────────────────
  const handleSwitchDoc = useCallback(async (id: string) => {
    await switchDoc(id);
    navigate('dashboard');
  }, [switchDoc, navigate]);

  const handleDocUpdated = useCallback((doc: ClarityDocument) => {
    setActiveDoc(doc);
    setReadingDoc(prev => prev?.id === doc.id ? doc : prev);
  }, [setActiveDoc]);

  const handleStartRun = useCallback(async (doc: ClarityDocument, mode: RunMode, startIndex = 0) => {
    setReadingDoc(doc);            // lock the reading view to this doc
    navigate('reading');           // switch to Reading tab
    await startRun(doc, mode, startIndex);
  }, [startRun, navigate]);

  if (loading) return <PageSpinner />;

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        docs={docs}
        activeId={activeId}
        nav={nav}
        availability={availability}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(c => !c)}
        onSwitchDoc={handleSwitchDoc}
        onRemoveDoc={removeDoc}
        onNav={navigate}
        onNewDoc={() => setNewDocTab('paste')}
      />

      <main className="main-content" id="main-content">
        {nav === 'dashboard' && (
          <Dashboard
            activeDoc={activeDoc}
            captureStatus={captureStatus}
            onClearCaptureStatus={() => setCaptureStatus(null)}
            onStartReading={() => navigate('reading')}
            onNewDoc={setNewDocTab}
            onDocUpdated={handleDocUpdated}
          />
        )}
        {nav === 'reading' && (
          <Reading
            activeDoc={readingDoc}
            runState={runState}
            displayPrefs={displayPrefs}
            onStartRun={handleStartRun}
            onCancelRun={cancelRun}
            onDismissError={dismissError}
            onDismissNotice={dismissNotice}
            onUpdatePrefs={updatePrefs}
          />
        )}
        {nav === 'progress' && (
          <Suspense fallback={<PageSpinner />}>
            <Progress activeDoc={activeDoc} />
          </Suspense>
        )}
        {nav === 'settings' && <Settings displayPrefs={displayPrefs} onUpdatePrefs={updatePrefs} />}
      </main>

      {newDocTab && (
        <NewDocDialog
          initialTab={newDocTab}
          onClose={() => setNewDocTab(null)}
          onSuccess={() => { setNewDocTab(null); navigate('dashboard'); }}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// ─── PageSpinner ────────────────────────────────────────────────────────────

/** Full-area spinner for the initial load and lazily loaded pages. */
function PageSpinner() {
  return (
    <div className="app-loading" role="status" aria-label="Loading">
      <span className="spinner" aria-hidden="true" />
    </div>
  );
}
