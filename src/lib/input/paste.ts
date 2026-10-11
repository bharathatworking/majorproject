/**
 * Creates a Clarity document from pasted plain text.
 *
 * - Title:   first non-empty line, truncated to 80 chars
 * - HTML:    blank-line-delimited blocks → <p> tags
 * - Hash:    SHA-256 of trimmed text (same method as extractor.ts)
 * - Minimum: 50 characters to prevent storing empty or trivial snippets
 */

import { upsertDocument } from '../storage/documents';
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

  // HTML: split on one or more blank lines → paragraph blocks
  const paragraphs = trimmed.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  // Single-line pastes (no blank-line separators) become one paragraph
  const html = (paragraphs.length > 0 ? paragraphs : [trimmed])
    .map(p => `<p>${escapeHtml(p)}</p>`)
    .join('\n');

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
