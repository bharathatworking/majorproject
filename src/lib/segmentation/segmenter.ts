import type { ContentNode, SegmentedDocument } from '../../types';
import { detectEntities } from './ner';

let nodeCounter = 0;
function generateId() {
  return `node_${++nodeCounter}_${Math.random().toString(36).substr(2, 9)}`;
}

export function segmentHtml(html: string, title: string, contentHash: string): SegmentedDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  const nodes: ContentNode[] = [];

  // Flatten the DOM into a sequence of block-level ContentNodes
  function walk(el: Element) {
    const tagName = el.tagName.toLowerCase();

    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
      const text = el.textContent?.trim() || '';
      if (text) {
        nodes.push({
          id: generateId(),
          type: 'heading',
          level: parseInt(tagName[1], 10),
          text,
          entities: detectEntities(text)
        });
      }
      return;
    }

    if (tagName === 'p') {
      const text = el.textContent?.trim() || '';
      if (text) {
        nodes.push({
          id: generateId(),
          type: 'paragraph',
          text,
          entities: detectEntities(text)
        });
      }
      return;
    }

    if (tagName === 'blockquote') {
      const text = el.textContent?.trim() || '';
      if (text) {
        nodes.push({
          id: generateId(),
          type: 'blockquote',
          text,
          entities: detectEntities(text)
        });
      }
      return;
    }

    if (tagName === 'ul' || tagName === 'ol') {
      const children: ContentNode[] = [];
      Array.from(el.children).forEach(li => {
        if (li.tagName.toLowerCase() === 'li') {
          const text = li.textContent?.trim() || '';
          if (text) {
            children.push({
              id: generateId(),
              type: 'list-item',
              text,
              entities: detectEntities(text)
            });
          }
        }
      });
      if (children.length > 0) {
        nodes.push({
          id: generateId(),
          type: 'list',
          text: '', // Lists don't have direct text in this model, their items do
          children
        });
      }
      return;
    }

    if (tagName === 'table') {
      const text = el.textContent?.trim() || '';
      if (text) {
        nodes.push({
          id: generateId(),
          type: 'table',
          text,
          skipSimplification: true, // Do not rewrite tables
          entities: [] // Not bothering to run NER on tables since we skip them
        });
      }
      return;
    }

    // Otherwise, traverse children
    Array.from(el.children).forEach(child => walk(child));
  }

  Array.from(body.children).forEach(child => walk(child));

  return {
    title,
    nodes,
    contentHash
  };
}
