import { describe, it, expect } from 'vitest';
import {
  MAX_NODE_SENTENCES, MAX_NODE_WORDS, blocksToHtml, chunkSentences, isTitleLine, parseListMarker,
  proseToHtml, splitInlineList, splitSentences, textToBlocks, wrapWidth, type TextBlock,
} from '../../src/lib/input/text-blocks';
import { TEST_PLAN_FLAT, TEST_PLAN_PASTE, TEST_PLAN_PDF_PAGES } from '../mocks/test-plan';

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
  it('attaches a list marker to the sentence after it', () => {
    expect(splitSentences('Find issues with TeamCal. 3. Formative: ask for feedback.')).toEqual([
      'Find issues with TeamCal.', '3. Formative: ask for feedback.',
    ]);
    expect(splitSentences('Count the usability errors b. Qualitative: types of errors.')).toEqual([
      'Count the usability errors', 'b. Qualitative: types of errors.',
    ]);
    expect(splitSentences('It ended. 3.')).toEqual(['It ended. 3.']);
  });

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

// ---------------------------------------------------------------------------
// The "example user test plan" (Chrome runs): PDF lines, paste, flattened
// ---------------------------------------------------------------------------
describe('example user test plan', () => {
  /** Matches a node that ends in a list marker: "… TeamCal. 3." */
  const ENDS_IN_MARKER = /(?:^|\s)(?:\d{1,3}|[a-z]|[ivx]{1,4})[.)]$/;
  const label = (b: TextBlock) => (b.kind === 'paragraph' ? 'p' : `${b.depth}${b.ordered ? 'o' : 'u'}`);

  it.each([
    ['PDF lines', () => textToBlocks(TEST_PLAN_PDF_PAGES.join('\n'))],
    ['paste', () => textToBlocks(TEST_PLAN_PASTE)],
  ])('%s: merges the title, keeps the objectives a list and starts "Users:" anew', (_name, blocks) => {
    const b = blocks();
    expect(b[0]).toMatchObject({ kind: 'paragraph' });
    expect(b[0].text.startsWith('User Test Plan Example. Situating Context: You are consulting')).toBe(true);
    expect(b[1]).toEqual({ kind: 'paragraph', text: 'Objectives:' });
    expect(b.slice(2, 5).map(label)).toEqual(['0o', '0o', '0o']);
    expect(b[3].text).toBe(
      'Summative: compare TeamCal to Google Calendar based on user performance and preference on two common ' +
      'tasks—finding a common meeting time and scheduling work hours on specific projects.',
    );
    expect(b[4].text).toBe('Formative: gather feedback as to the potential usefulness of TeamCal.');
    expect(b[5]).toMatchObject({ kind: 'paragraph' });
    expect(b[5].text.startsWith('Users: 20 managers')).toBe(true);
  });

  it('never makes a title line its own block and never ends a block in a marker', () => {
    const b = textToBlocks(TEST_PLAN_PASTE);
    expect(b.some(x => x.text === 'User Test Plan Example' || x.text === 'Situating Context:')).toBe(false);
    for (const x of b) expect(x.text).not.toMatch(ENDS_IN_MARKER);
  });

  it('keeps a sentence that crosses the page break in one block', () => {
    const b = textToBlocks(TEST_PLAN_PDF_PAGES.join('\n'));
    expect(b.some(x => x.text.includes('Researcher A will ask the participants which system (Google Calendar or TeamCal)')))
      .toBe(true);
  });

  it('nests bullets and Word "o" sub-bullets', () => {
    const b = textToBlocks(TEST_PLAN_PASTE);
    const i = b.findIndex(x => x.text.startsWith('What is your overall perception'));
    expect(label(b[i - 1])).toBe('0u');
    expect(b.slice(i, i + 4).map(label)).toEqual(['1u', '1u', '1u', '1u']);
  });

  it('flattened text: the inline objectives become a list, and no block ends in a marker', () => {
    const b = textToBlocks(TEST_PLAN_FLAT);
    const i = b.findIndex(x => x.text === 'Formative: identify common usability issues with TeamCal.');
    expect(i).toBeGreaterThan(0);
    expect(b[i - 1].text.endsWith('Objectives:')).toBe(true);
    expect(b.slice(i, i + 3).map(label)).toEqual(['0o', '0o', '0o']);
    for (const x of b) expect(x.text).not.toMatch(ENDS_IN_MARKER);
  });
});

describe('splitInlineList', () => {
  it('splits a run 1., 2., 3. into the lead-in and items', () => {
    expect(splitInlineList('Objectives: 1. Formative: find issues. 2. Summative: compare. 3. Formative: ask.')).toEqual([
      { kind: 'paragraph', text: 'Objectives:' },
      { kind: 'list-item', depth: 0, ordered: true, text: 'Formative: find issues.' },
      { kind: 'list-item', depth: 0, ordered: true, text: 'Summative: compare.' },
      { kind: 'list-item', depth: 0, ordered: true, text: 'Formative: ask.' },
    ]);
  });

  it('leaves prose numbers alone', () => {
    expect(splitInlineList('She was born in 1867. Twenty people came.')).toBeNull();
    expect(splitInlineList('Do session 1 tasks first and session 2 tasks later.')).toBeNull();
    expect(splitInlineList('Step 1. Open it.')).toBeNull();
  });
});

describe('title lines and wrapped text', () => {
  it('reads Title Case and label lines as titles, sentences and long lines not', () => {
    expect(isTitleLine('User Test Plan Example')).toBe(true);
    expect(isTitleLine('Situating Context:')).toBe(true);
    expect(isTitleLine('History of the Amazon River')).toBe(true);
    expect(isTitleLine('Meeting plan')).toBe(false);
    expect(isTitleLine('The war ended.')).toBe(false);
    expect(isTitleLine('One Two Three Four Five Six Seven Eight Nine')).toBe(false);
  });

  it('merges a title across a blank line, but not before a list', () => {
    expect(textToBlocks('Field Trip Rules\n\nStay with your group at all times.')).toEqual([
      { kind: 'paragraph', text: 'Field Trip Rules. Stay with your group at all times.' },
    ]);
    expect(textToBlocks('Packing List:\n- Water\n- Snacks')[0]).toEqual({ kind: 'paragraph', text: 'Packing List:' });
  });

  it('detects hard-wrapped text by its line widths', () => {
    expect(wrapWidth(TEST_PLAN_PASTE.split('\n'))).toBeGreaterThan(80);
    expect(wrapWidth(['One long paragraph per line, as Word copies it, and a lot more words here.', 'Short.', 'x'])).toBeNull();
  });
});
