/**
 * Creates a Clarity document from pasted plain text.
 *
 * - Title:   first non-empty line, truncated to 80 chars
 * - HTML:    blocks from text-blocks.ts: split at blank lines and list-marker
 *            lines, with oversized blocks split at sentence boundaries;
 *            list items carry their depth (Word "o" sub-bullets)
 * - Hash:    SHA-256 of trimmed text (same method as extractor.ts)
 * - Minimum: 50 characters to prevent storing empty or trivial snippets
 */

import { upsertDocument } from '../storage/documents';
import { sha256 } from '../utils/hash';
import { blocksToHtml, textToBlocks } from './text-blocks';
import type { ClarityDocument } from '../../types';

const MIN_LENGTH = 50;

export async function createDocumentFromPaste(rawText: string): Promise<ClarityDocument> {
  const trimmed = rawText.trim();
  if (trimmed.length < MIN_LENGTH) {
    throw new Error(`Text must be at least ${MIN_LENGTH} characters. (Got ${trimmed.length})`);
  }

  // Title: first non-empty line
  const firstLine = trimmed.split('\n').find(l => l.trim()) ?? 'Pasted text';
  const title = firstLine.trim().slice(0, 80);

  const html = blocksToHtml(textToBlocks(trimmed));

  const contentHash = await sha256(trimmed);

  return upsertDocument({
    source: 'paste',
    title,
    contentHash,
    html,
    textContent: trimmed,
    report: null,
  });
}
