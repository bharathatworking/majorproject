import type { ContentNode, SegmentedDocument } from '../../types';

/**
 * Parses sanitized article HTML into a flat sequence of ContentNodes.
 *
 * Fixes vs. the original implementation:
 *
 * 1. **Deterministic node IDs** — IDs are now `n0, n1, n2, …` scoped to each
 *    call. The old `Math.random()` suffix meant stored results couldn't be
 *    reliably matched back to nodes after a page reload.
 *
 * 2. **List items flattened into the top-level sequence** — Previously, `<ul>`/
 *    `<ol>` elements were emitted as a `list` node with `text: ''` and their
 *    `<li>` children nested inside. The filter `n.text.trim().length > 0` that
 *    guards the simplification loop silently dropped every list node, so no list
 *    item was ever simplified. Now each `<li>` is emitted directly as a
 *    `list-item` node at the top level.
 *
 * 3. **No NER here** — nodes come back without `entities`. The Reading page
 *    segments on every render and never needs them, and detecting them here
 *    pulled compromise (~400 kB) into the main chunk. The run loop
 *    (lib/run/simplify.ts) detects entities only for nodes it sends to the
 *    model.
 *
 * 4. **List depth** — an `<li data-depth="d">` (written by lib/input/text-blocks.ts
 *    for pasted Word sub-bullets) gets `depth` (clamped to MAX_LIST_DEPTH, left
 *    out at 0), and items of an `<ol>` get `ordered: true`. Neither changes the
 *    node IDs, so stored documents still match their results.
 */

const MAX_LIST_DEPTH = 3;

/** Nesting depth from `data-depth`, clamped to 0..MAX_LIST_DEPTH. */
function listDepth(li: Element): number {
  const depth = Number.parseInt(li.getAttribute('data-depth') ?? '', 10);
  return Number.isFinite(depth) ? Math.min(Math.max(depth, 0), MAX_LIST_DEPTH) : 0;
}

/** Flat ContentNodes of the HTML, with IDs n0, n1, … in document order. */
export function segmentHtml(html: string, title: string, contentHash: string): SegmentedDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  const nodes: ContentNode[] = [];
  let counter = 0;
  const nextId = () => `n${counter++}`;

  function walk(el: Element) {
    const tag = el.tagName.toLowerCase();

    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
      const text = el.textContent?.trim() ?? '';
      if (text) {
        nodes.push({
          id: nextId(),
          type: 'heading',
          level: parseInt(tag[1], 10),
          text,
        });
      }
      return;
    }

    if (tag === 'p') {
      const text = el.textContent?.trim() ?? '';
      if (text) {
        nodes.push({ id: nextId(), type: 'paragraph', text });
      }
      return;
    }

    if (tag === 'blockquote') {
      const text = el.textContent?.trim() ?? '';
      if (text) {
        nodes.push({ id: nextId(), type: 'blockquote', text });
      }
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      // Each <li> becomes its own list-item node in the flat sequence.
      // Consecutive list-item nodes are grouped into a <ul> visually by the
      // Reading page renderer.
      Array.from(el.children).forEach(li => {
        if (li.tagName.toLowerCase() === 'li') {
          const text = li.textContent?.trim() ?? '';
          if (text) {
            const depth = listDepth(li);
            nodes.push({
              id: nextId(),
              type: 'list-item',
              text,
              ...(depth > 0 && { depth }),
              ...(tag === 'ol' && { ordered: true }),
            });
          }
        }
      });
      return;
    }

    if (tag === 'table') {
      const text = el.textContent?.trim() ?? '';
      if (text) {
        nodes.push({
          id: nextId(),
          type: 'table',
          text,
          skipSimplification: true,
          entities: [],
        });
      }
      return;
    }

    // Recurse for any other container elements
    Array.from(el.children).forEach(child => walk(child));
  }

  Array.from(body.children).forEach(child => walk(child));

  return { title, nodes, contentHash };
}

/**
 * Nodes a run simplifies, in document order. Reading and the run loop both use
 * this filter, so a node index means the same node in both.
 */
export function simplifiableNodes(nodes: ContentNode[]): ContentNode[] {
  return nodes.filter(n => n.type !== 'table' && !n.skipSimplification && n.text.trim().length > 0);
}
