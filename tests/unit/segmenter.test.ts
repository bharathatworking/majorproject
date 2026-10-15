// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { segmentHtml, simplifiableNodes } from '../../src/lib/segmentation/segmenter';
import {
  MAX_NODE_SENTENCES, MAX_NODE_WORDS, blocksToHtml, splitSentences, textToBlocks,
} from '../../src/lib/input/text-blocks';

const html = `
  <h2>Mission goals</h2>
  <div class="wrapper">
    <p>NASA launched the probe in 2024.</p>
    <section><blockquote>We are going back.</blockquote></section>
  </div>
  <ul>
    <li>Collect samples</li>
    <li>   </li>
    <li>Return safely</li>
  </ul>
  <table><tr><td>Cell</td></tr></table>
  <p>   </p>
  <h4>Results</h4>
`;

// ---------------------------------------------------------------------------
// segmentHtml — flat, deterministic node sequence
// ---------------------------------------------------------------------------
describe('segmentHtml', () => {
  const { nodes, title, contentHash } = segmentHtml(html, 'Probe', 'hash-1');

  it('passes title and hash through', () => {
    expect(title).toBe('Probe');
    expect(contentHash).toBe('hash-1');
  });

  it('assigns deterministic sequential IDs, skipping empty elements', () => {
    expect(nodes.map(n => n.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it('produces the same IDs on every call', () => {
    const again = segmentHtml(html, 'Probe', 'hash-1').nodes;
    expect(again.map(n => [n.id, n.text])).toEqual(nodes.map(n => [n.id, n.text]));
  });

  it('emits nodes in document order with their types', () => {
    expect(nodes.map(n => n.type)).toEqual([
      'heading', 'paragraph', 'blockquote', 'list-item', 'list-item', 'table', 'heading',
    ]);
  });

  it('records heading levels', () => {
    expect(nodes[0]).toMatchObject({ text: 'Mission goals', level: 2 });
    expect(nodes[6]).toMatchObject({ text: 'Results', level: 4 });
  });

  it('recurses into container elements', () => {
    expect(nodes[1].text).toBe('NASA launched the probe in 2024.');
    expect(nodes[2].text).toBe('We are going back.');
  });

  it('flattens list items into the top-level sequence', () => {
    expect(nodes.filter(n => n.type === 'list-item').map(n => n.text)).toEqual(['Collect samples', 'Return safely']);
  });

  it('marks tables to skip simplification', () => {
    expect(nodes[5]).toMatchObject({ type: 'table', skipSimplification: true, entities: [] });
  });

  it('leaves entity detection to the run loop', () => {
    expect(nodes.filter(n => n.type !== 'table').every(n => n.entities === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// simplifiableNodes — the node list shared by Reading and the run loop
// ---------------------------------------------------------------------------
describe('simplifiableNodes', () => {
  it('drops tables and keeps document order', () => {
    const { nodes } = segmentHtml(html, 'Probe', 'hash-1');
    expect(simplifiableNodes(nodes).map(n => n.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n6']);
  });
});

// ---------------------------------------------------------------------------
// Pasted text → HTML → nodes (lib/input/text-blocks.ts + segmentHtml)
// ---------------------------------------------------------------------------
describe('pasted text segmentation', () => {
  const longParagraph = Array.from({ length: 22 }, (_, i) =>
    `Point ${i + 1} explains one part of the plan in a few more words.`,
  ).join(' ');
  const pasted = [
    'Meeting plan',
    '',
    longParagraph,
    '1.\tBook a room',
    'o\tCheck the calendar',
    'o\tAsk Mary (she is in PST time zone)',
    '2.\tSend the agenda',
    '',
    'Thanks.',
  ].join('\n');
  const paste = () => segmentHtml(blocksToHtml(textToBlocks(pasted)), 'Meeting plan', 'hash-p').nodes;

  it('gives deterministic IDs in document order', () => {
    const nodes = paste();
    expect(nodes.map(n => n.id)).toEqual(nodes.map((_, i) => `n${i}`));
    expect(paste().map(n => [n.id, n.text])).toEqual(nodes.map(n => [n.id, n.text]));
  });

  it('keeps every node within the sentence and word limits', () => {
    const nodes = paste();
    expect(nodes.length).toBeGreaterThan(6);
    for (const node of nodes) {
      expect(splitSentences(node.text).length).toBeLessThanOrEqual(MAX_NODE_SENTENCES);
      expect(node.text.split(/\s+/).length).toBeLessThanOrEqual(MAX_NODE_WORDS);
    }
  });

  it('gives Word "o" sub-bullets depth 1 and numbered items ordered', () => {
    const items = paste().filter(n => n.type === 'list-item');
    expect(items.map(n => [n.text, n.depth ?? 0, n.ordered ?? false])).toEqual([
      ['Book a room', 0, true],
      ['Check the calendar', 1, false],
      ['Ask Mary (she is in PST time zone)', 1, false],
      ['Send the agenda', 0, true],
    ]);
  });

  it('leaves depth and ordered off plain <ul> items', () => {
    const { nodes } = segmentHtml(html, 'Probe', 'hash-1');
    const item = nodes.find(n => n.type === 'list-item');
    expect(item?.depth).toBeUndefined();
    expect(item?.ordered).toBeUndefined();
  });

  it('clamps an out-of-range data-depth', () => {
    const { nodes } = segmentHtml('<ul><li data-depth="9">a</li><li data-depth="x">b</li></ul>', 't', 'h');
    expect(nodes.map(n => n.depth)).toEqual([3, undefined]);
  });
});
