/**
 * Extracts text from a text-based PDF and creates a Clarity document.
 *
 * Uses pdfjs-dist v6.x (ESM) with a bundled worker loaded via Vite's ?url import
 * so the worker script resolves to chrome-extension://…/pdf.worker.min.mjs at
 * runtime — this satisfies MV3's script-src 'self' CSP without any relaxation.
 *
 * pdf.js v6 has no eval()/new Function() code path (the old isEvalSupported
 * option was removed), so it runs under the extension CSP (no 'unsafe-eval')
 * without any configuration.
 *
 * pdf.js (~450 kB) is imported dynamically on the first PDF, so it stays out of
 * the app's main chunk. The worker ?url import is only a path string, so it
 * stays static.
 *
 * OCR is NOT supported. This module only works with text-based (not scanned) PDFs.
 */

import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { upsertDocument } from '../storage/documents';
import { sha256 } from '../utils/hash';
import { escapeHtml } from '../utils/html';
import type { ClarityDocument } from '../../types';

const MIN_TEXT_LENGTH = 100;

export async function createDocumentFromPDF(file: File): Promise<ClarityDocument> {
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    throw new Error('Only PDF files (.pdf) are supported.');
  }

  const pdfjsLib = await import('pdfjs-dist');
  // Use the bundled worker; the ?url import resolves to its chrome-extension:// path
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  const arrayBuffer = await file.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    disableFontFace: true,       // no external font requests
    useSystemFonts: false,
  });

  const pdf = await loadingTask.promise;

  // Extract text page by page. Each page becomes a paragraph block.
  const pageTexts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();

    // Join text items, inserting a space between items and a newline when
    // the item marks the end of a line (hasEOL).
    let pageText = '';
    for (const item of textContent.items) {
      if ('str' in item) {
        pageText += item.str;
        if ('hasEOL' in item && item.hasEOL) pageText += '\n';
        else pageText += ' ';
      }
    }
    pageText = pageText.replace(/\s+/g, ' ').trim();
    if (pageText) pageTexts.push(pageText);
  }

  const textContent = pageTexts.join('\n\n');

  if (textContent.trim().length < MIN_TEXT_LENGTH) {
    throw new Error(
      'No readable text found in this PDF. ' +
      'Make sure it is a text-based PDF, not a scanned image.',
    );
  }

  // Title: filename without extension
  const title = file.name.replace(/\.pdf$/i, '').trim() || 'PDF document';

  // HTML: one <p> per page
  const html = pageTexts.map(p => `<p>${escapeHtml(p)}</p>`).join('\n');

  // SHA-256 hash for dedup
  const contentHash = await sha256(textContent);

  return upsertDocument({
    source: 'pdf',
    title,
    fileName: file.name,
    contentHash,
    html,
    textContent,
    report: null,
  });
}
