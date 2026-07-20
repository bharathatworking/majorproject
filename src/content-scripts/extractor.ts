/**
 * Content script entry point — injected on-demand by the background worker.
 *
 * All extraction logic lives in src/lib/extraction/extractor.ts and is shared
 * with any future callers (e.g. tests, an options page preview). This file is
 * intentionally thin: run the library function, send the result back.
 *
 * crxjs bundles this as a standalone IIFE via the ?script import in
 * background/index.ts, inlining all npm dependencies (@mozilla/readability,
 * dompurify) and internal module imports alike.
 */

import { extractArticle } from '../lib/extraction/extractor';

(async () => {
  try {
    const result = await extractArticle(document);
    chrome.runtime.sendMessage({
      type: 'EXTRACTION_RESULT',
      data: {
        title: result.title,
        content: result.content,
        textContent: result.textContent,
        contentHash: result.contentHash,
      },
    });
  } catch (err) {
    console.error('[Clarity] Extraction failed:', err);
    // Send a distinct failure message — NOT a blank EXTRACTION_RESULT.
    // The background and side panel both handle this type to surface a real
    // error state rather than silently computing metrics on empty text.
    chrome.runtime.sendMessage({
      type: 'EXTRACTION_FAILED',
      error: String(err),
    });
  }
})();
