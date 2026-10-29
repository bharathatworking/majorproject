import { describe, it, expect } from 'vitest';
import { countSentenceText, splitSentenceText } from '../../src/lib/utils/sentences';
import { splitSentences as nliSentences } from '../../src/lib/quality/premises';
import { countSentences } from '../../src/lib/metrics/engine';
import { splitSentences as blockSentences } from '../../src/lib/input/text-blocks';

// Fixtures: English Wikipedia, "Karnataka" (lead, retrieved 2026-10-27, CC BY-SA 4.0),
// the paste behind the run report where "10.2%" came back as "10." (model output).
const GROWTH = 'The state experienced a GSDP growth of 10.2% for the same fiscal year.';
const ECONOMY =
  'The economy of Karnataka is among the most productive in the country with a gross state domestic product ' +
  '(GSDP) of ₹25.01 trillion (US$260 billion) and a per capita GSDP of ₹332,926 (US$3,500) for the financial year 2023–24.';
const AREA =
  'The state covers an area of 191,791 km2 (74,051 sq mi), or 5.83 per cent of the total geographical area of India.';

/** Every splitter in the app gives the same answer for plain prose. */
const SPLITTERS: [string, (t: string) => string[]][] = [
  ['splitSentenceText', t => splitSentenceText(t)],
  ['NLI (premises.ts)', nliSentences],
  ['paste blocks (text-blocks.ts)', blockSentences],
];

describe('splitSentenceText', () => {
  describe.each(SPLITTERS)('%s', (_name, split) => {
    it('keeps a decimal percentage in one sentence', () => {
      expect(split(GROWTH)).toEqual([GROWTH]);
    });

    it('keeps decimals inside currency amounts, thousands separators and US$', () => {
      expect(split(ECONOMY)).toEqual([ECONOMY]);
      expect(split(AREA)).toEqual([AREA]);
    });

    it('splits the Karnataka paragraph at its real boundaries only', () => {
      expect(split(`${ECONOMY} ${GROWTH} ${AREA}`)).toEqual([ECONOMY, GROWTH, AREA]);
    });

    it('does not end a sentence at an abbreviation before a number', () => {
      expect(split('The prize was Rs. 300 for team No. 5 in the final. It was paid later.'))
        .toEqual(['The prize was Rs. 300 for team No. 5 in the final.', 'It was paid later.']);
    });

    it('does not end a sentence at a title or initial before a name', () => {
      expect(split('Dr. Rao met J. Smith at St. Mary\'s in the U.S. Army camp. They talked.'))
        .toEqual(['Dr. Rao met J. Smith at St. Mary\'s in the U.S. Army camp.', 'They talked.']);
    });

    it('treats an ellipsis as a pause unless a capital follows', () => {
      expect(split('The growth went on... and on for years. It ended... Then it fell.'))
        .toEqual(['The growth went on... and on for years.', 'It ended...', 'Then it fell.']);
      expect(split('It went on… and on. Next year… The end.'))
        .toEqual(['It went on… and on.', 'Next year…', 'The end.']);
    });
  });

  it('never splits between two digits, even after a closing quote', () => {
    for (const text of ['Pi is 3.14159 exactly.', 'It rose 0.5 points.', 'Version 2.0.1 shipped.', 'He said "10.2" twice.']) {
      expect(splitSentenceText(text)).toEqual([text]);
    }
  });

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(splitSentenceText('He said "Go." Then he left. (It was late.) Done.'))
      .toEqual(['He said "Go."', 'Then he left.', '(It was late.)', 'Done.']);
  });

  it('splits the model\'s broken "10." like any sentence end (the NLI check then flags it)', () => {
    // The corruption was in the model output itself; splitting here is not the cause
    expect(splitSentenceText('The economy grew 10. in the year 2023–24.'))
      .toEqual(['The economy grew 10.', 'in the year 2023–24.']);
    // The block splitter needs a sentence start after the stop, so it keeps it whole
    expect(blockSentences('The economy grew 10. in the year 2023–24.'))
      .toEqual(['The economy grew 10. in the year 2023–24.']);
  });

  it('e.g. and i.e. never end a sentence', () => {
    expect(splitSentenceText('Some states, e.g. Goa, are small. Others, i.e. Karnataka, are large.'))
      .toEqual(['Some states, e.g. Goa, are small.', 'Others, i.e. Karnataka, are large.']);
  });

  it('drops empty pieces and keeps unpunctuated text whole', () => {
    expect(splitSentenceText('')).toEqual([]);
    expect(splitSentenceText('  Hello world  ')).toEqual(['Hello world']);
  });
});

describe('countSentenceText and the readability metrics', () => {
  it('counts the Karnataka growth sentence as exactly one sentence', () => {
    expect(countSentenceText(GROWTH)).toBe(1);
    expect(countSentences(GROWTH)).toBe(1);
  });

  it('counts abbreviations and amounts correctly', () => {
    expect(countSentences(`${ECONOMY} ${GROWTH} ${AREA}`)).toBe(3);
    expect(countSentences('Team No. 5 won Rs. 300. Dr. Rao paid.')).toBe(2);
  });

  it('keeps the old rule for a last sentence without punctuation, and at least 1', () => {
    expect(countSentences('First one. Second one')).toBe(1);
    expect(countSentences('no punctuation at all')).toBe(1);
    expect(countSentences('')).toBe(1);
  });
});
