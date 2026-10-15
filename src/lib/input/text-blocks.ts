/**
 * Splits pasted plain text into node-sized blocks and turns them into the
 * simple HTML that segmentHtml reads.
 *
 * Design decisions:
 *  - Splitting happens here, when a document is created, never in the
 *    segmenter. Reading re-segments the stored HTML on every render, so a
 *    segmenter change would shift the node IDs of stored documents and break
 *    their stored results. Stored documents keep their HTML (dedup never
 *    rewrites it), so they are not migrated.
 *  - A block starts at every blank line and at every line that begins with a
 *    list marker. Other lines join the current block (Word wraps nothing, so
 *    a following line is usually more of the same item or paragraph).
 *  - List depth follows Word's default levels: "1." / "•" / "-" are depth 0,
 *    "a." / "o" are depth 1, "i." / "▪" are depth 2. "i.", "v." and "x." are
 *    letters when they follow "h.", "u." and "w.". Depth never jumps more
 *    than one level below the previous item, and a list starts at depth 0.
 *  - A block over MAX_NODE_SENTENCES sentences or MAX_NODE_WORDS words is
 *    split greedily at sentence boundaries. The first chunk of a split list
 *    item stays the item; the rest become paragraphs (an extra bullet would
 *    invent a list item the author never wrote). One sentence over the word
 *    limit stays whole.
 *  - The sentence splitter is local: lib/quality/nli.ts has one, but it must
 *    not enter the main chunk (paste runs from NewDocDialog).
 *  - Pure and DOM-free so it runs under vitest's node environment.
 */

import { escapeHtml } from '../utils/html';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TextBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list-item'; depth: number; ordered: boolean; text: string };

export interface ListMarker {
  depth: number;
  ordered: boolean;
  /** Item text after the marker. */
  text: string;
  /** The letter of an "a." style marker, used to read a following "i." as a letter. */
  letter?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_NODE_SENTENCES = 8;
export const MAX_NODE_WORDS = 150;

// ─── Patterns ─────────────────────────────────────────────────────────────────

const NUMBER_MARKER = /^\d{1,3}[.)]\s+(.*)$/;
const LETTER_MARKER = /^([a-z]{1,4})[.)]\s+(.*)$/;
const ROMAN = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/;
/** "•" / "●" (and Word's Symbol-font bullet U+F0B7) need no space; "-", "*", "–" do. */
const BULLET_MARKER = /^(?:[•●]\s*|[-*–]\s+)(.*)$/;
/** Word's second-level "o" (Courier New), or "◦". */
const SUB_BULLET_MARKER = /^(?:◦\s*|o\s+)(.*)$/;
/** Word's third-level "▪" (Wingdings, sometimes pasted as U+F0A7), or "■". */
const SUB_SUB_BULLET_MARKER = /^[▪■]\s*(.*)$/;

/** After . ! or ? (and any closing quotes or brackets), before a capital or digit. */
const SENTENCE_BREAK = /(?<=[.!?]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/;
/** A piece ending in one of these did not end a sentence ("Dr. Smith", "J. Smith"). */
const ABBREVIATION = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|No|Fig|approx|e\.g|i\.e)|\b[A-Z])\.$/;

// ─── Markers ──────────────────────────────────────────────────────────────────

/**
 * The list marker at the start of a (trimmed) line, or null. `prevLetter` is
 * the letter of the previous "a." style marker in the same list.
 */
export function parseListMarker(line: string, prevLetter: string | null = null): ListMarker | null {
  let m = NUMBER_MARKER.exec(line);
  if (m) return { depth: 0, ordered: true, text: m[1] };

  m = LETTER_MARKER.exec(line);
  if (m) {
    const label = m[1];
    const followsLetter =
      label.length === 1 && prevLetter !== null && label.charCodeAt(0) === prevLetter.charCodeAt(0) + 1;
    if (ROMAN.test(label) && !followsLetter) return { depth: 2, ordered: true, text: m[2] };
    if (label.length === 1) return { depth: 1, ordered: true, text: m[2], letter: label };
    return null;
  }

  m = BULLET_MARKER.exec(line);
  if (m) return { depth: 0, ordered: false, text: m[1] };
  m = SUB_BULLET_MARKER.exec(line);
  if (m) return { depth: 1, ordered: false, text: m[1] };
  m = SUB_SUB_BULLET_MARKER.exec(line);
  if (m) return { depth: 2, ordered: false, text: m[1] };
  return null;
}

// ─── Sentences ────────────────────────────────────────────────────────────────

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Sentences of a prose block; abbreviations and initials don't end one. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const piece of text.split(SENTENCE_BREAK)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const last = sentences.length - 1;
    if (last >= 0 && ABBREVIATION.test(sentences[last])) sentences[last] += ` ${trimmed}`;
    else sentences.push(trimmed);
  }
  return sentences;
}

/**
 * Greedy chunks of at most MAX_NODE_SENTENCES sentences and MAX_NODE_WORDS
 * words, split only at sentence boundaries.
 */
export function chunkSentences(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const sentence of splitSentences(text)) {
    const w = countWords(sentence);
    if (current.length > 0 && (current.length >= MAX_NODE_SENTENCES || words + w > MAX_NODE_WORDS)) {
      chunks.push(current.join(' '));
      current = [];
      words = 0;
    }
    current.push(sentence);
    words += w;
  }
  if (current.length > 0) chunks.push(current.join(' '));
  return chunks;
}

// ─── Blocks ───────────────────────────────────────────────────────────────────

/** Oversized blocks become several; a list item keeps its first chunk. */
function splitOversized(block: TextBlock): TextBlock[] {
  const chunks = chunkSentences(block.text);
  if (chunks.length <= 1) return [block];
  return chunks.map((text, i) =>
    i === 0 ? { ...block, text } : { kind: 'paragraph' as const, text },
  );
}

/** Pasted text → paragraph and list-item blocks (rules in the file header). */
export function textToBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let current: TextBlock | null = null;
  let prevDepth = -1;              // previous list item's depth; -1 outside a list
  let prevLetter: string | null = null;

  const flush = () => {
    if (current) {
      const joined = current.text.replace(/\s+/g, ' ').trim();
      if (joined) blocks.push({ ...current, text: joined });
    }
    current = null;
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    const marker = parseListMarker(trimmed, prevLetter);
    if (marker) {
      flush();
      const depth = Math.min(marker.depth, prevDepth + 1);
      if (depth === 0) prevLetter = null;
      if (marker.letter) prevLetter = marker.letter;
      prevDepth = depth;
      current = { kind: 'list-item', depth, ordered: marker.ordered, text: marker.text };
      continue;
    }

    if (current) {
      current.text += ` ${trimmed}`;
      continue;
    }

    // A paragraph after a blank line ends the list
    prevDepth = -1;
    prevLetter = null;
    current = { kind: 'paragraph', text: trimmed };
  }
  flush();

  return blocks.flatMap(splitOversized);
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

/**
 * Escaped HTML for segmentHtml: <p> per paragraph and <li data-depth="d">
 * runs inside <ul> or <ol>; a new list opens whenever `ordered` changes.
 */
export function blocksToHtml(blocks: readonly TextBlock[]): string {
  const out: string[] = [];
  let openList: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (openList) out.push(`</${openList}>`);
    openList = null;
  };

  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      closeList();
      out.push(`<p>${escapeHtml(block.text)}</p>`);
      continue;
    }
    const tag = block.ordered ? 'ol' : 'ul';
    if (openList !== tag) {
      closeList();
      out.push(`<${tag}>`);
      openList = tag;
    }
    out.push(`<li data-depth="${block.depth}">${escapeHtml(block.text)}</li>`);
  }
  closeList();
  return out.join('\n');
}

/** Long prose (a PDF page) → one <p> per chunk. */
export function proseToHtml(text: string): string {
  return chunkSentences(text).map(chunk => `<p>${escapeHtml(chunk)}</p>`).join('\n');
}
