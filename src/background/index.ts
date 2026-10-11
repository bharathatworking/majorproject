/**
 * Background service worker.
 *
 * Architecture notes:
 * - NO module-level state. MV3 workers are killed when idle; any variables are
 *   lost on shutdown. All state lives in chrome.storage.session (ephemeral) or
 *   chrome.storage.local (persistent).
 * - capture:status (session): { state: 'extracting'|'error', tabTitle?, error?, at }
 *   The app reads this on mount and via storage.onChanged to show loading/error UI.
 * - appTabId (session): the tab id of the open Clarity tab, used for reuse.
 *
 * Message types handled:
 *   EXTRACTION_RESULT  — from content script: store document, clear capture status.
 *   EXTRACTION_FAILED  — from content script: write error into capture status.
 *
 * Removed (old side-panel architecture):
 *   EXTRACT_PAGE, GET_RESULTS, EXTRACTION_COMPLETE — no longer used.
 */

import { upsertDocument } from '../lib/storage/documents';

// crxjs resolves this ?script import to the IIFE bundle path at build time.
import extractorScriptPath from '../content-scripts/extractor.ts?script';

const APP_PATH = 'src/app/index.html';

const RESTRICTED_PAGE_MESSAGE =
  "Chrome doesn't let extensions read this page (chrome:// pages, the Web Store " +
  'and built-in viewers are blocked). Paste the text or upload the file instead.';

const MIN_TEXT_LENGTH = 100;
const NO_TEXT_MESSAGE = 'No readable article text found on this page.';

// ─── Action click: capture + open/focus the app ──────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  // If the user clicked the icon while already on the Clarity tab itself, just
  // focus it — there's nothing on that page to extract.
  if (tab.url?.startsWith(chrome.runtime.getURL(''))) {
    await openOrFocusApp();
    return;
  }

  if (!tab.id) {
    await openOrFocusApp();
    return;
  }

  // Signal "extracting" so the app can show a loading state immediately.
  await chrome.storage.session.set({
    'capture:status': {
      state: 'extracting',
      tabTitle: tab.title ?? '',
      at: Date.now(),
    },
  });

  // Inject FIRST — the activeTab grant is tied to this click gesture and must
  // be consumed synchronously before we yield to any async work.
  try {
    console.log('[Clarity] Injecting content script into tab', tab.id);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [extractorScriptPath],
    });
  } catch (err) {
    console.error('[Clarity] Failed to inject content script:', err);
    await chrome.storage.session.set({
      'capture:status': {
        state: 'error',
        error: RESTRICTED_PAGE_MESSAGE,
        at: Date.now(),
      },
    });
  }

  await openOrFocusApp();
});

// ─── Tab cleanup ──────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { appTabId } = await chrome.storage.session.get('appTabId');
  if (appTabId === tabId) {
    await chrome.storage.session.remove('appTabId');
  }
});

// ─── Message handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'EXTRACTION_RESULT') {
    handleExtractionResult(request.data).then(() => sendResponse({ status: 'ok' }));
    return true; // keep channel open for async sendResponse
  }

  if (request.type === 'EXTRACTION_FAILED') {
    const error: string = request.error ?? 'Unknown extraction error';
    console.error('[Clarity] EXTRACTION_FAILED:', error);
    chrome.storage.session.set({
      'capture:status': { state: 'error', error, at: Date.now() },
    });
    sendResponse({ status: 'ok' });
    return;
  }
});

async function handleExtractionResult(data: {
  title: string;
  content: string;
  textContent: string;
  contentHash: string;
  url: string;
}) {
  console.log('[Clarity] EXTRACTION_RESULT:', data.title, `(${data.textContent.length} chars)`);

  if (data.textContent.trim().length < MIN_TEXT_LENGTH) {
    await chrome.storage.session.set({
      'capture:status': { state: 'error', error: NO_TEXT_MESSAGE, at: Date.now() },
    });
    return;
  }

  try {
    // The app computes the readability report from textContent — not the background.
    // This keeps the service worker lean and puts metric computation (which can be
    // slow on long pages) in a context where we can show "Analyzing…" in the UI.
    await upsertDocument({
      source: 'page',
      title: data.title || data.url,
      sourceUrl: data.url,
      contentHash: data.contentHash,
      html: data.content,
      textContent: data.textContent,
      report: null,
    });

    // Clear capture status — docs:active was updated by upsertDocument, which will
    // trigger a storage.onChanged event in the app, switching it to the new doc.
    await chrome.storage.session.remove('capture:status');
  } catch (err) {
    console.error('[Clarity] Failed to store document:', err);
    await chrome.storage.session.set({
      'capture:status': { state: 'error', error: String(err), at: Date.now() },
    });
  }
}

// ─── Tab reuse ────────────────────────────────────────────────────────────────

async function openOrFocusApp(): Promise<void> {
  const { appTabId } = await chrome.storage.session.get('appTabId');

  if (appTabId) {
    try {
      const t = await chrome.tabs.get(appTabId as number);
      await chrome.tabs.update(appTabId as number, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return;
    } catch {
      // Tab was closed between when we stored the id and now — fall through.
    }
  }

  const t = await chrome.tabs.create({ url: chrome.runtime.getURL(APP_PATH) });
  await chrome.storage.session.set({ appTabId: t.id });
}
