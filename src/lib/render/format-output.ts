/**
 * Turns raw simplified model output into structured blocks for rendering.
 *
 * The model returns plain text that may contain bullet lists in several
 * shapes: one item per line ("- a\n- b"), numbered lines ("1. a"), or inline
 * runs ("Intro: • a • b"). Rendering that text as a single text node collapses
 * every newline, so all bullets ended up on one line. This module parses the
 * text into paragraph / list blocks that the Reading page renders as real
 * <p>, <ul>/<ol> and <li> elements (never via innerHTML).
 *
 * Design decisions:
 *  - Pure and DOM-free so it runs under vitest's node environment.
 *  - Tolerant of half-streamed text: dangling markers produce empty items,
 *    which are dropped, and unclosed ** markers are stripped.
 *  - "-", "*", "–" and numbers need a space after the marker so "-5°C" or
 *    "1.5 million" at the start of a line stay as text. "•" is unambiguous and
 *    needs no space.
 *  - A blank line between bullets keeps the list open (models often emit
 *    "- a\n\n- b"). Single newlines inside a paragraph are joined with a space.
 *  - Inline splitting only happens on "•": inline "-" and "–" are normal
 *    hyphens and dashes in prose.
 *  - Sub-bullets: "o" / "◦" (Word's second level) are depth 1, "▪" / "■"
 *    depth 2, and each 2 spaces (or a tab) of indentation before a marker adds
 *    a level; the larger wins. Depth never jumps more than one level below the
 *    previous item. The list block carries `depths` only when it is nested,
 *    and only top-level items decide whether the list is ordered.
 *  - nestByDepth turns flat items with depths into a tree; the Reading page
 *    uses it for both model-output lists and pasted list-item nodes.
 *  - flattenLists turns every list of an output into sentences of one
 *    paragraph. The run loop applies it to paragraph output when the reader's
 *    style didn't ask for bullets, and to list-item output always (one node
 *    stays one item). The Student preset's "Bullet summary" style keeps them
 *    (eval/fixtures UK run: every paragraph came back as one bullet per
 *    sentence).
 */

import type { Block } from '../../types';

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** Indentation, then a marker (sub-bullet or ordered number captured), then the item text. */
const BULLET_LINE =
  /^(?<indent>[ \t]*)(?:(?<sub1>◦|o(?=\s))\s*|(?<sub2>[▪■])\s*|•\s*|[-*–]\s+|(?<num>\d{1,2})[.)]\s+)(?<text>.*)$/;

/** A marker with nothing after it yet (common mid-stream): "-", "*", "1." … */
const BARE_MARKER = /^\s*(?:[-*–•◦▪■o]|\d{1,2}[.)])\s*$/;

const INLINE_BULLET = /\s*•\s*/;

const ENDS_WITH_PUNCTUATION = /[.!?:;]$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Nesting level of a bullet line: its marker's level or its indentation, whichever is larger. */
function bulletDepth(groups: Record<string, string | undefined>): number {
  const markerDepth = groups.sub2 !== undefined ? 2 : groups.sub1 !== undefined ? 1 : 0;
  const indent = (groups.indent ?? '').replace(/\t/g, '  ').length;
  return Math.max(markerDepth, Math.floor(indent / 2));
}

/** Remove **bold** / __bold__ markers, including unclosed ones left mid-stream. */
function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*\*/g, '');
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/** Parse simplified model output into paragraph and list blocks. */
export function parseSimplifiedText(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = stripEmphasis(text.replace(/\r\n?/g, '\n')).split('\n');

  let para: string[] = [];
  let list: { ordered: boolean; items: string[]; depths: number[] } | null = null;
  let afterBlank = false;

  const flushPara = () => {
    const joined = para.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) blocks.push({ kind: 'paragraph', text: joined });
    para = [];
  };

  const flushList = () => {
    if (list && list.items.length > 0) {
      const nested = list.depths.some(d => d > 0);
      blocks.push({
        kind: 'list', ordered: list.ordered, items: list.items, ...(nested && { depths: list.depths }),
      });
    }
    list = null;
  };

  const addItem = (ordered: boolean, item: string, depth = 0) => {
    const trimmed = item.trim();
    // Sub-items never switch the list type; top-level ones do
    const prevDepth = list?.depths.at(-1) ?? -1;
    const clamped = Math.min(depth, prevDepth + 1);
    if (list && clamped === 0 && list.ordered !== ordered) flushList();
    if (!list) list = { ordered, items: [], depths: [] };
    if (trimmed) {
      list.items.push(trimmed);
      list.depths.push(list.items.length === 1 ? 0 : clamped);
    }
  };

  for (const line of lines) {
    // Blank line: ends a paragraph but keeps an open list alive
    if (!line.trim()) {
      flushPara();
      afterBlank = true;
      continue;
    }

    // Dangling marker with no text yet: an empty item, so skip it
    if (BARE_MARKER.test(line)) continue;

    // Bullet line (may itself carry more inline "•" items)
    const m = BULLET_LINE.exec(line);
    if (m?.groups) {
      flushPara();
      const ordered = m.groups.num !== undefined;
      const depth = bulletDepth(m.groups);
      for (const item of (m.groups.text ?? '').split(INLINE_BULLET)) addItem(ordered, item, depth);
      afterBlank = false;
      continue;
    }

    // Plain line with inline "•" bullets
    if (line.includes('•')) {
      const [intro, ...items] = line.split(INLINE_BULLET);
      flushList();
      para.push(intro);
      flushPara();
      for (const item of items) addItem(false, item);
      afterBlank = false;
      continue;
    }

    // Indented continuation of the previous list item
    const openList = list as { ordered: boolean; items: string[]; depths: number[] } | null;
    if (openList && !afterBlank && /^\s/.test(line) && openList.items.length > 0) {
      const last = openList.items.length - 1;
      openList.items[last] = `${openList.items[last]} ${line.trim()}`;
      continue;
    }

    // Plain paragraph line
    flushList();
    para.push(line.trim());
    afterBlank = false;
  }

  flushPara();
  flushList();
  return blocks;
}

// ─── Nesting ──────────────────────────────────────────────────────────────────

export interface TreeItem<T> {
  item: T;
  /** Position in the flat input. */
  index: number;
  children: TreeItem<T>[];
}

/**
 * Flat items with depths → a tree. An item hangs under the closest earlier
 * item one level up; a depth more than one below the previous item is
 * clamped, and the first item is always top level.
 */
export function nestByDepth<T>(items: readonly T[], depthOf: (item: T, index: number) => number): TreeItem<T>[] {
  const roots: TreeItem<T>[] = [];
  const path: TreeItem<T>[] = [];   // path[d] = latest item at depth d
  items.forEach((item, index) => {
    const depth = Math.max(0, Math.min(Math.floor(depthOf(item, index)) || 0, path.length));
    const node: TreeItem<T> = { item, index, children: [] };
    if (depth === 0) roots.push(node);
    else path[depth - 1].children.push(node);
    path.length = depth;
    path.push(node);
  });
  return roots;
}

// ─── Flattening (paragraph input stays a paragraph) ──────────────────────────

const withPeriod = (item: string) => (ENDS_WITH_PUNCTUATION.test(item) ? item : `${item}.`);

/**
 * `text` with every list turned into one paragraph of sentences (an item
 * without end punctuation gets a period). A paragraph ending in ":" takes
 * the list after it ("Three parts:" + items → "Three parts: A. B. C.").
 * Other paragraphs stay as they are. Unchanged when there is no list.
 */
export function flattenLists(text: string): string {
  const blocks = parseSimplifiedText(text);
  if (!blocks.some(b => b.kind === 'list')) return text;
  const paragraphs: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      paragraphs.push(block.text);
      continue;
    }
    const sentences = block.items.filter(Boolean).map(withPeriod).join(' ');
    const last = paragraphs.length - 1;
    if (last >= 0 && paragraphs[last].endsWith(':')) paragraphs[last] += ` ${sentences}`;
    else paragraphs.push(sentences);
  }
  return paragraphs.join('\n\n');
}

// ─── Plain text (metrics + rolling context) ───────────────────────────────────

/**
 * Plain-text version of the output with bullet markers removed. Each list item
 * gets a closing period if it lacks punctuation, so the sentence counter treats
 * every item as its own sentence instead of merging the list into one.
 */
export function toPlainText(text: string): string {
  return parseSimplifiedText(text)
    .map(block =>
      block.kind === 'paragraph'
        ? block.text
        : block.items.map(withPeriod).join('\n'),
    )
    .join('\n\n');
}
