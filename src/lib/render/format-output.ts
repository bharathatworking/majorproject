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
 */

import type { Block } from '../../types';

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** Unordered marker (group 1) or ordered number (group 2), then the item text (group 3). */
const BULLET_LINE = /^\s*(?:•\s*|([-*–])\s+|(\d{1,2})[.)]\s+)(.*)$/;

/** A marker with nothing after it yet (common mid-stream): "-", "*", "1." … */
const BARE_MARKER = /^\s*(?:[-*–•]|\d{1,2}[.)])\s*$/;

const INLINE_BULLET = /\s*•\s*/;

const ENDS_WITH_PUNCTUATION = /[.!?:;]$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  let list: { ordered: boolean; items: string[] } | null = null;
  let afterBlank = false;

  const flushPara = () => {
    const joined = para.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) blocks.push({ kind: 'paragraph', text: joined });
    para = [];
  };

  const flushList = () => {
    if (list && list.items.length > 0) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    }
    list = null;
  };

  const addItem = (ordered: boolean, item: string) => {
    if (list && list.ordered !== ordered) flushList();
    if (!list) list = { ordered, items: [] };
    const trimmed = item.trim();
    if (trimmed) list.items.push(trimmed);
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
    if (m) {
      flushPara();
      const ordered = m[2] !== undefined;
      for (const item of m[3].split(INLINE_BULLET)) addItem(ordered, item);
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
    const openList = list as { ordered: boolean; items: string[] } | null;
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
        : block.items
            .map(item => (ENDS_WITH_PUNCTUATION.test(item) ? item : `${item}.`))
            .join('\n'),
    )
    .join('\n\n');
}
