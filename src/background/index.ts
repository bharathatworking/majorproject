import { computeReadabilityReport } from '../lib/metrics/engine';
import { BASE_COMMON_WORDS } from '../lib/metrics/common-words';
// The ?script query tells crxjs to bundle this file as a standalone IIFE
// content script and replace this import with the resolved output path string.
// This is the documented crxjs pattern for dynamically-injected content scripts.
import extractorScriptPath from '../content-scripts/extractor.ts?script';

chrome.runtime.onInstalled.addListener(() => {
  // Do NOT call setPanelBehavior({ openPanelOnActionClick: true }) here.
  // That mode opens the panel asynchronously, breaking the activeTab grant:
  // by the time the panel sends EXTRACT_PAGE and the background calls
  // chrome.tabs.query(), Chrome no longer considers the tab "active" in the
  // grant sense, and scripting.executeScript() is rejected with a host
  // permission error. Use an explicit onClicked listener instead (below).
});

// Primary extraction trigger: called synchronously within the user's click
// gesture, so the activeTab permission covers the target tab for the entire
// duration of the executeScript call.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  // Open the side panel for this specific tab first.
  await chrome.sidePanel.open({ tabId: tab.id });

  try {
    console.log('[Clarity] Injecting content script into tab', tab.id);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // crxjs resolves this import to the actual IIFE output path at build time.
      files: [extractorScriptPath],
    });
  } catch (err) {
    console.error('[Clarity] Failed to inject content script:', err);
  }
});

// Store extracted data so the side panel can poll for it after injection completes.
let latestExtraction: {
  title: string;
  textContent: string;
  content: string;
  contentHash: string;
} | null = null;

let latestReport: ReturnType<typeof computeReadabilityReport> | null = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // --- Side panel asks background to inject the content script ---
  if (request.type === 'EXTRACT_PAGE') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab?.id) {
        sendResponse({ status: 'error', error: 'No active tab' });
        return;
      }
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        // extractorScriptPath is resolved by crxjs at build time to the
        // actual output path of the bundled IIFE (e.g. src/content-scripts/extractor.js)
        files: [extractorScriptPath],
      }).then(() => {
        console.log('[Clarity] Content script injected into tab', activeTab.id);
        sendResponse({ status: 'injected' });
      }).catch(err => {
        console.error('[Clarity] Failed to inject content script:', err);
        sendResponse({ status: 'error', error: err.message });
      });
    });
    return true; // keep channel open for async sendResponse
  }

  // --- Content script sends back extracted article data ---
  if (request.type === 'EXTRACTION_RESULT') {
    latestExtraction = {
      title: request.data.title,
      textContent: request.data.textContent,
      content: request.data.content,
      contentHash: request.data.contentHash,
    };
    console.log('[Clarity] EXTRACTION_RESULT received:', latestExtraction.title,
      `(${latestExtraction.textContent.length} chars)`);
    // Compute readability report right here in the background
    latestReport = computeReadabilityReport(latestExtraction.textContent, BASE_COMMON_WORDS);
    // Broadcast to any listening side panel
    chrome.runtime.sendMessage({
      type: 'EXTRACTION_COMPLETE',
      extraction: latestExtraction,
      report: latestReport,
    }).catch(() => {
      // Side panel may not be listening yet — that's fine, it will poll via GET_RESULTS
    });
    sendResponse({ status: 'ok' });
    return;
  }

  // --- Content script reports an extraction failure ---
  if (request.type === 'EXTRACTION_FAILED') {
    const error = request.error ?? 'Unknown extraction error';
    console.error('[Clarity] EXTRACTION_FAILED received:', error);
    // Clear any stale data from a previous successful extraction
    latestExtraction = null;
    latestReport = null;
    // Broadcast to the side panel so it can show an error state
    chrome.runtime.sendMessage({
      type: 'EXTRACTION_FAILED',
      error,
    }).catch(() => {
      // Side panel may not be open yet — nothing to do
    });
    sendResponse({ status: 'ok' });
    return;
  }

  // --- Side panel polls for results (backup if it missed the broadcast) ---
  if (request.type === 'GET_RESULTS') {
    sendResponse({
      extraction: latestExtraction,
      report: latestReport,
    });
    return;
  }
});
