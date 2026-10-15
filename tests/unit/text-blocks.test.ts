import { describe, it, expect } from 'vitest';
import {
  MAX_NODE_SENTENCES, MAX_NODE_WORDS, blocksToHtml, chunkSentences, parseListMarker, proseToHtml,
  splitSentences, textToBlocks, type TextBlock,
} from '../../src/lib/input/text-blocks';

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** n numbered sentences of about `perSentence` words each. */
function sentences(n: number, perSentence = 6): string {
  return Array.from({ length: n }, (_, i) =>
    `Sentence ${i + 1} ${'word '.repeat(Math.max(perSentence - 3, 0))}ends.`,
  ).join(' ');
}

// ---------------------------------------------------------------------------
// parseListMarker
// ---------------------------------------------------------------------------
describe('parseListMarker', () => {
  it.each([
    ['1. First', 0, true],
    ['2) Second', 0, true],
    ['a. Letter', 1, true],
    ['b) Letter', 1, true],
    ['i. Roman', 2, true],
    ['ii. Roman', 2, true],
    ['o\tWord sub-bullet', 1, false],
    ['• Bullet', 0, false],
    ['•Bullet', 0, false],
    ['- Dash', 0, false],
    ['▪ Square', 2, false],
  ])('reads %j', (line, depth, ordered) => {
    expect(parseListMarker(line)).toMatchObject({ depth, ordered });
  });

  it('returns the text after the marker', () => {
    expect(parseListMarker('o\tPick a date')?.text).toBe('Pick a date');
  });

  it('reads "i." after "h." as a letter', () => {
    expect(parseListMarker('i. Ninth', 'h')).toMatchObject({ depth: 1, letter: 'i' });
    expect(parseListMarker('i. First roman', 'a')).toMatchObject({ depth: 2 });
  });

  it('ignores prose that only looks like a marker', () => {
    expect(parseListMarker('-5 degrees is cold.')).toBeNull();
    expect(parseListMarker('1.5 million people')).toBeNull();
    expect(parseListMarker('only the start')).toBeNull();
    expect(parseListMarker('etc. and more')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sentences and chunks
// ---------------------------------------------------------------------------
describe('splitSentences', () => {
  it('splits at sentence ends', () => {
    expect(splitSentences('One here. Two here! Three? 4 is a digit.')).toEqual([
      'One here.', 'Two here!', 'Three?', '4 is a digit.',
    ]);
  });

  it('does not split after abbreviations or initials', () => {
    expect(splitSentences('Dr. Smith met J. Doe today. They talked.')).toEqual([
      'Dr. Smith met J. Doe today.', 'They talked.',
    ]);
  });

  it('does not split before a lowercase word', () => {
    expect(splitSentences('It costs 3.5 dollars. e.g. it is cheap.')).toEqual([
      'It costs 3.5 dollars. e.g. it is cheap.',
    ]);
  });
});

describe('chunkSentences', () => {
  it('splits 22 sentences at sentence boundaries into chunks within the limits', () => {
    const text = sentences(22);
    const chunks = chunkSentences(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(splitSentences(chunk).length).toBeLessThanOrEqual(MAX_NODE_SENTENCES);
      expect(words(chunk)).toBeLessThanOrEqual(MAX_NODE_WORDS);
      expect(chunk).toMatch(/\.$/);
    }
    expect(chunks.join(' ')).toBe(text);
  });

  it('respects the word limit with long sentences', () => {
    const chunks = chunkSentences(sentences(6, 40));
    for (const chunk of chunks) expect(words(chunk)).toBeLessThanOrEqual(MAX_NODE_WORDS);
    expect(chunks.length).toBe(2);
  });

  it('keeps one sentence over the word limit whole', () => {
    const long = `${'word '.repeat(MAX_NODE_WORDS + 20)}end.`;
    expect(chunkSentences(long)).toEqual([long]);
  });
});

// ---------------------------------------------------------------------------
// textToBlocks
// ---------------------------------------------------------------------------
describe('textToBlocks', () => {
  it('splits on blank lines and joins single newlines', () => {
    expect(textToBlocks('First line\nsame block.\n\nSecond block.')).toEqual([
      { kind: 'paragraph', text: 'First line same block.' },
      { kind: 'paragraph', text: 'Second block.' },
    ]);
  });

  it('splits on every list-marker line, with Word list depths', () => {
    const text = [
      'Plan for the meeting:',
      '1.\tBook a room',
      'o\tCheck the calendar',
      'o\tAsk Mary',
      '▪\tShe is in PST',
      '2.\tSend the agenda',
      'a.\tTopics',
      'b.\tTimes',
      'i.\tMorning',
      'ii.\tAfternoon',
      '• Bring notes',
      '- Bring coffee',
    ].join('\n');
    const blocks = textToBlocks(text);
    expect(blocks.map(b => (b.kind === 'paragraph' ? 'p' : `${b.depth}${b.ordered ? 'o' : 'u'}`))).toEqual([
      'p', '0o', '1u', '1u', '2u', '0o', '1o', '1o', '2o', '2o', '0u', '0u',
    ]);
    expect(blocks[2]).toEqual({ kind: 'list-item', depth: 1, ordered: false, text: 'Check the calendar' });
  });

  it('never nests deeper than one level below the previous item', () => {
    const depths = textToBlocks('▪ deep first\n• top\n▪ jumps two\no one').map(b => (b.kind === 'list-item' ? b.depth : -1));
    expect(depths).toEqual([0, 0, 1, 1]);
  });

  it('reads letters through "h." → "i." in one sub-list', () => {
    const letters = 'abcdefghi'.split('').map(l => `${l}. item ${l}`);
    const blocks = textToBlocks(['1. top', ...letters].join('\n'));
    expect(blocks.every((b, i) => i === 0 || (b.kind === 'list-item' && b.depth === 1))).toBe(true);
  });

  it('joins a following unmarked line to the list item', () => {
    expect(textToBlocks('- an item\nthat wraps')).toEqual([
      { kind: 'list-item', depth: 0, ordered: false, text: 'an item that wraps' },
    ]);
  });

  it('splits an oversized paragraph into chunks', () => {
    const blocks = textToBlocks(sentences(22));
    expect(blocks.length).toBeGreaterThan(2);
    expect(blocks.every(b => b.kind === 'paragraph')).toBe(true);
  });

  it('keeps the first chunk of an oversized list item as the item', () => {
    const blocks = textToBlocks(`- ${sentences(12)}`);
    expect(blocks[0].kind).toBe('list-item');
    expect(blocks.slice(1).every(b => b.kind === 'paragraph')).toBe(true);
  });

  it('handles CRLF line endings', () => {
    expect(textToBlocks('A.\r\n\r\n- b')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
describe('blocksToHtml', () => {
  it('writes escaped paragraphs and lists with depths', () => {
    const blocks: TextBlock[] = [
      { kind: 'paragraph', text: 'Tom & <Jerry>' },
      { kind: 'list-item', depth: 0, ordered: true, text: 'one' },
      { kind: 'list-item', depth: 1, ordered: false, text: 'sub' },
      { kind: 'list-item', depth: 1, ordered: false, text: 'sub 2' },
    ];
    expect(blocksToHtml(blocks)).toBe([
      '<p>Tom &amp; &lt;Jerry&gt;</p>',
      '<ol>',
      '<li data-depth="0">one</li>',
      '</ol>',
      '<ul>',
      '<li data-depth="1">sub</li>',
      '<li data-depth="1">sub 2</li>',
      '</ul>',
    ].join('\n'));
  });

  it('turns long prose into several paragraphs', () => {
    expect(proseToHtml(sentences(20)).match(/<p>/g)?.length).toBeGreaterThan(2);
  });
});
