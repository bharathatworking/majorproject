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
 *  - Hard-wrapped text (a PDF, or text copied from a PDF viewer: most lines
 *    about the same length, no blank lines between paragraphs; wrapWidth)
 *    also ends a block after a short line that ends a sentence or a label,
 *    so "Users: 20 managers…" after "3. Formative: … TeamCal." starts a new
 *    paragraph instead of joining list item 3. A long line ending in "." is
 *    only wrapped there, and the block goes on.
 *  - Headings: a line that starts a block, has at most MAX_TITLE_WORDS
 *    words, starts with a capital or digit, has no ending punctuation
 *    (. ! ? : ; , …) and is followed (blank lines allowed) by a longer,
 *    non-list line of more than MAX_TITLE_WORDS words becomes a `heading`
 *    block (<h2>): "Etymology and terminology" + its section. Headings are
 *    kept as is and never sent to the model (lib/run/simplify.ts). Before
 *    this rule, a lowercase section title became a 3-word paragraph that the
 *    model turned into two bullets (eval/fixtures UK run).
 *  - Title lines that are not headings merge into the paragraph after them:
 *    a line of at most MAX_TITLE_WORDS words without end punctuation, in
 *    Title Case or ending in ":" ("User Test Plan Example" before a short
 *    label line, "Situating Context:"), followed (blank lines allowed) by a
 *    line starting with a capital: "Title" + "Text…" reads "Title. Text…".
 *    Before a list marker it stays its own paragraph ("Objectives:").
 *  - Inline numbered items ("Objectives: 1. Formative: … 2. Summative: …
 *    3. …", as flattened PDF text has them) become list items: a run of at
 *    least 2 markers 1., 2., … at the start, after a sentence end or after
 *    ":" splits the paragraph into its lead-in and the items.
 *  - A bare list marker is never a sentence: splitSentences attaches "3."
 *    (or "b.", "ii.") to the sentence after it, so no node ends in "3.".
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
import { splitSentenceText } from '../utils/sentences';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TextBlock =
  | { kind: 'heading'; text: string }
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

/** A title line has at most this many words. */
export const MAX_TITLE_WORDS = 8;

/** Hard-wrapped text: its typical long line (90th percentile) is 30 to this many characters… */
const WRAP_MAX_WIDTH = 130;
const WRAP_MIN_WIDTH = 30;
/** …and at least this share of its prose lines reach WRAP_FULL_SHARE of that width. */
const WRAP_MIN_FULL_LINES = 0.5;
const WRAP_FULL_SHARE = 0.6;
/** In wrapped text, a line shorter than this share of the width can end a block. */
const WRAP_SHORT_SHARE = 0.8;

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

/** A piece that is only a list marker: "3.", "b)", "ii.". */
const BARE_MARKER = /^(?:\d{1,3}|[a-z]|[ivx]{1,4})[.)]$/;
/** A sentence ending in the letter or roman marker of the next item: "… errors b." */
const TRAILING_MARKER = /\s((?:[a-z]|[ivx]{1,4})[.)])$/;
/** Ends a sentence or a label (closing quotes or brackets allowed). */
const BLOCK_END = /[.!?:]["'”’)\]]*$/;
/** Inline list marker "1." / "2)" at the start, after a sentence end or ":", before a capital. */
const INLINE_MARKER = /(^|[.!?:]["'”’)\]]*\s+)(\d{1,3})[.)]\s+(?=["'“‘(]?[A-Z])/g;
/** Ends in sentence or label punctuation (closing quotes or brackets allowed): not a heading. */
const ENDING_PUNCTUATION = /[.!?:;,…]["'”’)\]]*$/;
/** Short words a Title Case line may keep lowercase. */
const TITLE_SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'vs']);

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

/**
 * Sentences of a prose block (lib/utils/sentences.ts with requireStart:
 * abbreviations, initials, decimals and a mid-sentence "..." don't end one),
 * and a list marker belongs to the sentence after it: "TeamCal. 3.
 * Formative: …" gives "TeamCal." and "3. Formative: …".
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let carry = '';
  for (const piece of splitSentenceText(text, { requireStart: true })) {
    let trimmed = piece.trim();
    if (!trimmed) continue;
    if (BARE_MARKER.test(trimmed)) {
      carry = carry ? `${carry} ${trimmed}` : trimmed;
      continue;
    }
    if (carry) {
      trimmed = `${carry} ${trimmed}`;
      carry = '';
    }
    sentences.push(trimmed);
  }
  if (carry) {
    if (sentences.length > 0) sentences[sentences.length - 1] += ` ${carry}`;
    else sentences.push(carry);
  }
  // "… usability errors b." + "Qualitative: …": the marker moves to the next sentence
  for (let i = 0; i < sentences.length - 1; i++) {
    const m = TRAILING_MARKER.exec(sentences[i]);
    if (m) {
      sentences[i] = sentences[i].slice(0, m.index).trim();
      sentences[i + 1] = `${m[1]} ${sentences[i + 1]}`;
    }
  }
  return sentences.filter(Boolean);
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

/**
 * The line width of hard-wrapped text (90th-percentile prose line length), or
 * null when the text is not hard-wrapped (see file header).
 */
export function wrapWidth(lines: readonly string[]): number | null {
  const prose = lines.map(l => l.trim()).filter(l => l !== '' && !parseListMarker(l));
  if (prose.length < 3) return null;
  const lengths = prose.map(l => l.length).sort((a, b) => a - b);
  const width = lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))];
  if (width < WRAP_MIN_WIDTH || width > WRAP_MAX_WIDTH) return null;
  const full = lengths.filter(n => n >= width * WRAP_FULL_SHARE).length;
  return full / prose.length >= WRAP_MIN_FULL_LINES ? width : null;
}

/** A short title or label line (see file header). */
export function isTitleLine(line: string): boolean {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_TITLE_WORDS || parseListMarker(line)) return false;
  if (line.endsWith(':')) return /^[A-Z]/.test(line) && !/[.!?]/.test(line);
  if (/[.!?,;"”')\]]$/.test(line)) return false;
  return words.every((w, i) => /^[A-Z0-9]/.test(w) || (i > 0 && TITLE_SMALL_WORDS.has(w.toLowerCase())));
}

/**
 * A heading line (see file header): `next` is the following non-empty line,
 * which must be a longer paragraph line.
 */
export function isHeadingLine(line: string, next: string): boolean {
  const words = countWords(line);
  if (words === 0 || words > MAX_TITLE_WORDS || parseListMarker(line)) return false;
  if (!/^["'“‘(]?[A-Z0-9]/.test(line) || ENDING_PUNCTUATION.test(line)) return false;
  const nextWords = countWords(next);
  return nextWords > MAX_TITLE_WORDS && nextWords > words && !parseListMarker(next);
}

/** "Title" + "Text…" → "Title. Text…"; "Label:" + "Text…" → "Label: Text…". */
function joinTitle(title: string, text: string): string {
  return title.endsWith(':') ? `${title} ${text}` : `${title}. ${text}`;
}

/**
 * A paragraph's inline numbered items (see file header): its lead-in
 * paragraph and the items, or null without a run of 2+ markers.
 */
export function splitInlineList(text: string): TextBlock[] | null {
  const markers = [...text.matchAll(INLINE_MARKER)].map(m => ({
    value: Number(m[2]),
    /** Where the marker itself starts (after the sentence end and space). */
    at: (m.index ?? 0) + m[1].length,
    /** Where the item text starts. */
    after: (m.index ?? 0) + m[0].length,
  }));
  // Runs 1, 2, 3, …: "1." starts a run; a number out of sequence is prose
  const runs: (typeof markers)[] = [];
  for (const m of markers) {
    const run = runs[runs.length - 1];
    if (m.value === 1) runs.push([m]);
    else if (run && m.value === run[run.length - 1].value + 1) run.push(m);
  }
  const cuts = runs.filter(r => r.length >= 2).flat();
  if (cuts.length === 0) return null;

  const blocks: TextBlock[] = [];
  const lead = text.slice(0, cuts[0].at).trim();
  if (lead) blocks.push({ kind: 'paragraph', text: lead });
  cuts.forEach((m, i) => {
    const item = text.slice(m.after, i + 1 < cuts.length ? cuts[i + 1].at : text.length).trim();
    if (item) blocks.push({ kind: 'list-item', depth: 0, ordered: true, text: item });
  });
  return blocks;
}

/** Pasted text → paragraph and list-item blocks (rules in the file header). */
export function textToBlocks(text: string): TextBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
  const width = wrapWidth(lines);
  const blocks: TextBlock[] = [];
  let current: TextBlock | null = null;
  /** Lines of `current`: the last, the longest length and how many (wrapped-text block end). */
  let lastLine = '';
  let blockWidth = 0;
  let blockLines = 0;
  /** A title line waiting for the paragraph it merges into. */
  let pendingTitle: string | null = null;
  let prevDepth = -1;              // previous list item's depth; -1 outside a list
  let prevLetter: string | null = null;

  const flush = () => {
    if (current) {
      const joined = current.text.replace(/\s+/g, ' ').trim();
      if (joined) blocks.push({ ...current, text: joined });
    }
    current = null;
  };
  const flushTitle = () => {
    if (pendingTitle) blocks.push({ kind: 'paragraph', text: pendingTitle });
    pendingTitle = null;
  };
  /**
   * In wrapped text, the last line is short: shorter than WRAP_SHORT_SHARE of
   * its block's longest line (nested list items wrap narrower than the page),
   * or of the text's width while the block has one line.
   */
  const lastLineShort = () =>
    width !== null && lastLine.length < (blockLines > 1 ? blockWidth : width) * WRAP_SHORT_SHARE;
  /** The block ends after a short line that ends a sentence or label, or before a label after a short line. */
  const endsBlock = (line: string) =>
    lastLineShort() && (BLOCK_END.test(lastLine) || (isTitleLine(line) && line.endsWith(':')));
  /** Records a line of `current`; `first` starts a new block. */
  const addLine = (line: string, first: boolean) => {
    if (first) {
      blockWidth = 0;
      blockLines = 0;
    }
    lastLine = line;
    blockWidth = Math.max(blockWidth, line.length);
    blockLines++;
  };

  lines.forEach((trimmed, i) => {
    if (!trimmed) {
      flush();
      return;
    }

    const marker = parseListMarker(trimmed, prevLetter);
    if (marker) {
      flush();
      flushTitle();
      const depth = Math.min(marker.depth, prevDepth + 1);
      if (depth === 0) prevLetter = null;
      if (marker.letter) prevLetter = marker.letter;
      prevDepth = depth;
      current = { kind: 'list-item', depth, ordered: marker.ordered, text: marker.text };
      addLine(trimmed, true);
      return;
    }

    if (current && !endsBlock(trimmed)) {
      current.text += ` ${trimmed}`;
      addLine(trimmed, false);
      return;
    }

    // A new paragraph; it ends any list
    flush();
    prevDepth = -1;
    prevLetter = null;
    const next = lines.slice(i + 1).find(l => l !== '') ?? '';
    if (pendingTitle === null && isHeadingLine(trimmed, next)) {
      blocks.push({ kind: 'heading', text: trimmed.replace(/\s+/g, ' ') });
      return;
    }
    if (pendingTitle === null && isTitleLine(trimmed) && /^["'“‘(]?[A-Z]/.test(next) && !parseListMarker(next)) {
      pendingTitle = trimmed;
      return;
    }
    current = { kind: 'paragraph', text: pendingTitle ? joinTitle(pendingTitle, trimmed) : trimmed };
    pendingTitle = null;
    addLine(trimmed, true);
  });
  flush();
  flushTitle();

  return blocks
    .flatMap(b => (b.kind === 'paragraph' ? splitInlineList(b.text) ?? [b] : [b]))
    .flatMap(splitOversized);
}

/**
 * PDF pages (pdf.js text, a newline at each line end) → HTML. The pages are
 * read as one text, so a sentence that crosses a page break stays whole.
 */
export function pdfPagesToHtml(pages: readonly string[]): string {
  return blocksToHtml(textToBlocks(pages.join('\n')));
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

/**
 * Escaped HTML for segmentHtml: <h2> per heading, <p> per paragraph and
 * <li data-depth="d"> runs inside <ul> or <ol>; a new list opens whenever
 * `ordered` changes.
 */
export function blocksToHtml(blocks: readonly TextBlock[]): string {
  const out: string[] = [];
  let openList: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (openList) out.push(`</${openList}>`);
    openList = null;
  };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      closeList();
      out.push(`<h2>${escapeHtml(block.text)}</h2>`);
      continue;
    }
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
