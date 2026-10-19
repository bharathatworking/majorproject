import { describe, it, expect } from 'vitest';
import {
  flattenLists, nestByDepth, parseSimplifiedText, toPlainText, type TreeItem,
} from '../../src/lib/render/format-output';

// ---------------------------------------------------------------------------
// parseSimplifiedText — turns raw model output into paragraph / list blocks
// ---------------------------------------------------------------------------
describe('parseSimplifiedText', () => {
  it('splits newline "-" bullets into one list', () => {
    expect(parseSimplifiedText('- First point\n- Second point\n- Third point')).toEqual([
      { kind: 'list', ordered: false, items: ['First point', 'Second point', 'Third point'] },
    ]);
  });

  it('accepts *, – and • line markers', () => {
    expect(parseSimplifiedText('* a\n– b\n• c\n•d')).toEqual([
      { kind: 'list', ordered: false, items: ['a', 'b', 'c', 'd'] },
    ]);
  });

  it('splits inline • bullets into an intro paragraph and a list', () => {
    expect(parseSimplifiedText('Intro: • a • b • c')).toEqual([
      { kind: 'paragraph', text: 'Intro:' },
      { kind: 'list', ordered: false, items: ['a', 'b', 'c'] },
    ]);
  });

  it('splits a line that starts with • and continues inline', () => {
    expect(parseSimplifiedText('• a • b • c')).toEqual([
      { kind: 'list', ordered: false, items: ['a', 'b', 'c'] },
    ]);
  });

  it('parses numbered lists with "1." and "1)"', () => {
    expect(parseSimplifiedText('1. Mix the flour.\n2. Add water.\n3) Bake it.')).toEqual([
      { kind: 'list', ordered: true, items: ['Mix the flour.', 'Add water.', 'Bake it.'] },
    ]);
  });

  it('starts a new list when switching between ordered and unordered', () => {
    expect(parseSimplifiedText('1. one\n2. two\n- a\n- b')).toEqual([
      { kind: 'list', ordered: true,  items: ['one', 'two'] },
      { kind: 'list', ordered: false, items: ['a', 'b'] },
    ]);
  });

  it('handles paragraph + list + paragraph', () => {
    const text = 'Plants need three things:\n- Water\n- Light\n- Soil\n\nWithout them, they die.';
    expect(parseSimplifiedText(text)).toEqual([
      { kind: 'paragraph', text: 'Plants need three things:' },
      { kind: 'list', ordered: false, items: ['Water', 'Light', 'Soil'] },
      { kind: 'paragraph', text: 'Without them, they die.' },
    ]);
  });

  it('keeps one list across blank lines between bullets', () => {
    expect(parseSimplifiedText('- a\n\n- b\n\n- c')).toEqual([
      { kind: 'list', ordered: false, items: ['a', 'b', 'c'] },
    ]);
  });

  it('appends an indented line to the previous item', () => {
    expect(parseSimplifiedText('- a long item\n  that wraps\n- b')).toEqual([
      { kind: 'list', ordered: false, items: ['a long item that wraps', 'b'] },
    ]);
  });

  it('removes **bold** and __bold__ markers', () => {
    expect(parseSimplifiedText('**Note:** this is __key__.\n- **Fast** cars')).toEqual([
      { kind: 'paragraph', text: 'Note: this is key.' },
      { kind: 'list', ordered: false, items: ['Fast cars'] },
    ]);
  });

  it('returns plain paragraphs when there are no bullets', () => {
    expect(parseSimplifiedText('First line\nsame paragraph.\n\nSecond paragraph.')).toEqual([
      { kind: 'paragraph', text: 'First line same paragraph.' },
      { kind: 'paragraph', text: 'Second paragraph.' },
    ]);
  });

  it('does not treat negative numbers or decimals as bullets', () => {
    expect(parseSimplifiedText('-5 degrees is cold.\n1.5 million people live there.')).toEqual([
      { kind: 'paragraph', text: '-5 degrees is cold. 1.5 million people live there.' },
    ]);
  });

  it('trims items and skips empty ones', () => {
    expect(parseSimplifiedText('-    a   \n- \n-\n•  \n- b')).toEqual([
      { kind: 'list', ordered: false, items: ['a', 'b'] },
    ]);
  });

  it('returns no blocks for empty or whitespace input', () => {
    expect(parseSimplifiedText('')).toEqual([]);
    expect(parseSimplifiedText('  \n\n \r\n ')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    expect(parseSimplifiedText('Intro\r\n- a\r\n- b')).toEqual([
      { kind: 'paragraph', text: 'Intro' },
      { kind: 'list', ordered: false, items: ['a', 'b'] },
    ]);
  });

  // Streaming: the text is re-parsed after every chunk, so every prefix must
  // give a sensible result with no empty items or stray markers.
  describe('half-streamed text', () => {
    it('renders a partially written last item', () => {
      expect(parseSimplifiedText('Steps:\n- one\n- tw')).toEqual([
        { kind: 'paragraph', text: 'Steps:' },
        { kind: 'list', ordered: false, items: ['one', 'tw'] },
      ]);
    });

    it('drops a dangling marker with no text yet', () => {
      expect(parseSimplifiedText('Steps:\n- one\n-')).toEqual([
        { kind: 'paragraph', text: 'Steps:' },
        { kind: 'list', ordered: false, items: ['one'] },
      ]);
      expect(parseSimplifiedText('1. one\n2.')).toEqual([
        { kind: 'list', ordered: true, items: ['one'] },
      ]);
    });

    it('drops a trailing inline • with no text yet', () => {
      expect(parseSimplifiedText('Intro: • a •')).toEqual([
        { kind: 'paragraph', text: 'Intro:' },
        { kind: 'list', ordered: false, items: ['a'] },
      ]);
    });

    it('strips an unclosed ** marker', () => {
      expect(parseSimplifiedText('- **Impor')).toEqual([
        { kind: 'list', ordered: false, items: ['Impor'] },
      ]);
    });

    it('never produces empty items for any prefix of a full answer', () => {
      const full = 'Intro:\n\n- **First** point.\n- Second point\n\n1. Step one\n2) Step two\n\nEnd • a • b';
      for (let i = 0; i <= full.length; i++) {
        for (const block of parseSimplifiedText(full.slice(0, i))) {
          if (block.kind === 'paragraph') expect(block.text).not.toBe('');
          else {
            expect(block.items.length).toBeGreaterThan(0);
            block.items.forEach(item => expect(item.trim()).not.toBe(''));
          }
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// toPlainText — marker-free text for readability metrics and rolling context
// ---------------------------------------------------------------------------
describe('toPlainText', () => {
  it('removes markers and ends each item with a period', () => {
    expect(toPlainText('Plants need:\n- **Water**\n- Light!\n• Soil')).toBe(
      'Plants need:\n\nWater.\nLight!\nSoil.',
    );
  });

  it('leaves plain paragraphs unchanged', () => {
    expect(toPlainText('One.\n\nTwo.')).toBe('One.\n\nTwo.');
  });

  it('flattens nested items', () => {
    expect(toPlainText('- a\no b\n- c')).toBe('a.\nb.\nc.');
  });
});

// ---------------------------------------------------------------------------
// Sub-bullets — Word "o" / "▪" markers and indentation
// ---------------------------------------------------------------------------
describe('parseSimplifiedText sub-bullets', () => {
  it('nests Word "o" and "▪" items', () => {
    expect(parseSimplifiedText('- Book a room\no Check the calendar\n▪ Mary is in PST\n- Send the agenda')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: ['Book a room', 'Check the calendar', 'Mary is in PST', 'Send the agenda'],
        depths: [0, 1, 2, 0],
      },
    ]);
  });

  it('nests indented bullets', () => {
    expect(parseSimplifiedText('- a\n  - b\n\t- c\n    - d')).toEqual([
      { kind: 'list', ordered: false, items: ['a', 'b', 'c', 'd'], depths: [0, 1, 1, 2] },
    ]);
  });

  it('keeps an ordered list open across unordered sub-items', () => {
    expect(parseSimplifiedText('1. one\no sub\n2. two')).toEqual([
      { kind: 'list', ordered: true, items: ['one', 'sub', 'two'], depths: [0, 1, 0] },
    ]);
  });

  it('clamps a first or jumping sub-item', () => {
    expect(parseSimplifiedText('▪ first\n- top\n▪ deep')).toEqual([
      { kind: 'list', ordered: false, items: ['first', 'top', 'deep'], depths: [0, 0, 1] },
    ]);
  });

  it('leaves depths off a flat list', () => {
    expect(parseSimplifiedText('- a\n- b')[0]).not.toHaveProperty('depths');
  });

  it('does not treat words starting with "o" as bullets', () => {
    expect(parseSimplifiedText('only this\nor that')).toEqual([
      { kind: 'paragraph', text: 'only this or that' },
    ]);
  });

  it('drops a dangling "o" marker mid-stream', () => {
    expect(parseSimplifiedText('- a\no')).toEqual([{ kind: 'list', ordered: false, items: ['a'] }]);
  });
});

// ---------------------------------------------------------------------------
// nestByDepth — flat items with depths → tree
// ---------------------------------------------------------------------------
describe('nestByDepth', () => {
  const shape = (tree: TreeItem<string>[]): unknown[] =>
    tree.map(t => (t.children.length ? [t.item, shape(t.children)] : t.item));

  it('hangs items under the closest item one level up', () => {
    const items = ['a', 'a1', 'a2', 'a2x', 'b'];
    const depths = [0, 1, 1, 2, 0];
    expect(shape(nestByDepth(items, (_, i) => depths[i]))).toEqual([
      ['a', ['a1', ['a2', ['a2x']]]],
      'b',
    ]);
  });

  it('keeps flat indexes', () => {
    const tree = nestByDepth(['a', 'b', 'c'], (_, i) => [0, 1, 0][i]);
    expect(tree.map(t => t.index)).toEqual([0, 2]);
    expect(tree[0].children[0].index).toBe(1);
  });

  it('clamps the first item and depth jumps', () => {
    expect(shape(nestByDepth(['x', 'y', 'z'], (_, i) => [2, 3, 0][i]))).toEqual([['x', ['y']], 'z']);
  });
});

// ---------------------------------------------------------------------------
// flattenLists — paragraph input stays a paragraph (UK run, Student preset)
// ---------------------------------------------------------------------------
describe('flattenLists', () => {
  it('turns a one-sentence-per-bullet answer into one paragraph, with markdown line breaks dropped', () => {
    const qwen = '- The UK has a king.  \n- It has three parts: England, Wales, Scotland, and Northern Ireland  \n- UK trades a lot';
    expect(flattenLists(qwen)).toBe(
      'The UK has a king. It has three parts: England, Wales, Scotland, and Northern Ireland. UK trades a lot.',
    );
  });

  it('joins a lead-in ending in ":" with its list, and keeps other paragraphs apart', () => {
    expect(flattenLists('It has three parts:\n1. England\n2. Wales\n\nIt is old.')).toBe(
      'It has three parts: England. Wales.\n\nIt is old.',
    );
    expect(flattenLists('First paragraph.\n\n- a\n- b')).toBe('First paragraph.\n\na. b.');
  });

  it('leaves text without a list unchanged', () => {
    const text = 'Plain sentences only. Nothing to flatten.\n\nA second paragraph.';
    expect(flattenLists(text)).toBe(text);
  });
});
