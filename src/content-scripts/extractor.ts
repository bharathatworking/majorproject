/**
 * Content script entry point — injected on-demand by the background worker.
 *
 * All extraction logic lives in src/lib/extraction/extractor.ts and is shared
 * with any future callers (e.g. tests). This file is intentionally thin.
 *
 * crxjs bundles this as a standalone IIFE via the ?script import in
 * background/index.ts, inlining all npm dependencies and internal imports.
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
        url: location.href,   // Phase 1 addition: sourceUrl for the stored document
      },
    });
  } catch (err) {
    console.error('[Clarity] Extraction failed:', err);
    chrome.runtime.sendMessage({
      type: 'EXTRACTION_FAILED',
      error: String(err),
    });
  }
})();
