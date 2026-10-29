import { describe, it, expect } from 'vitest';
import {
  glossaryWordOf, isGlossarySentence, maxExemptions, selectExemptions, stripParentheticalDefinitions,
} from '../../src/lib/quality/glossary';
import { GLOSSARY_EXEMPTION_MAX_RATE } from '../../src/lib/quality/config';

const HINTED = ['photosynthesis', 'chlorophyll'];

// ---------------------------------------------------------------------------
// isGlossarySentence — rule 1
// ---------------------------------------------------------------------------
describe('isGlossarySentence', () => {
  it.each([
    'Photosynthesis means how plants make food from light.',
    'Photosynthesis is how plants make food from light.',
    'Photosynthesis is a type of chemical process.',
    'Photosynthesis refers to how plants make food.',
    'The photosynthesis is a slow process.',
    '"Chlorophyll" means the green colour in leaves.',
    'Chlorophyll, is the green colour in leaves.',
  ])('matches a definition of a hinted word: %s', (sentence) => {
    expect(isGlossarySentence(sentence, HINTED)).toBe(true);
  });

  it.each([
    'Inflation is a rise in prices over time.',
    'Inflation is an increase in prices.',
    'Inflation is the rise of prices.',
    'Inflation is a kind of price change.',
    'Inflation is when prices go up.',
    'Inflation is how money loses value.',
    'Inflation means prices go up.',
    'Inflation refers to rising prices.',
  ])('counts "is" as a definition only before a defining word: %s', (sentence) => {
    expect(isGlossarySentence(sentence, ['inflation'])).toBe(true);
  });

  it.each([
    'Inflation is rising.',
    'Inflation is high this year.',
    'Inflation is also a problem.',
    'Inflation was a problem.',
  ])('does not treat a plain statement as a definition: %s', (sentence) => {
    expect(isGlossarySentence(sentence, ['inflation'])).toBe(false);
  });

  it('does not exempt a definition of a word that was not hinted', () => {
    expect(isGlossarySentence('Respiration means how cells use food.', HINTED)).toBe(false);
  });

  it('needs the word at the start, followed by a definition verb', () => {
    expect(isGlossarySentence('Plants use photosynthesis every day.', HINTED)).toBe(false);
    expect(isGlossarySentence('Photosynthesis happens in leaves.', HINTED)).toBe(false);
    expect(isGlossarySentence('Photosynthesise is a verb.', HINTED)).toBe(false);
  });

  // Karnataka run (2026-10-27): the same rule for both sentence shapes
  describe('consistency: bare term vs. a naming noun before it', () => {
    it.each([
      ['Karu means "elevated land".', ['karu']],
      ['The word karu means "elevated land".', ['karu']],
      ['The number "billion" means one thousand million.', ['billion']],
      ['Billion means one thousand million.', ['billion']],
      ['The term "GSDP" refers to the value of everything the state makes.', ['GSDP']],
      ['A phrase "per capita" means for each person.', ['per capita']],
    ])('exempts %s when the word was hinted', (sentence, hinted) => {
      expect(isGlossarySentence(sentence, hinted)).toBe(true);
    });

    it('does not exempt a definition of a word that was never hinted ("billion" is a common word)', () => {
      expect(isGlossarySentence('The number "billion" means one thousand million.', ['karu', 'nādu'])).toBe(false);
      expect(isGlossarySentence('The number "billion" means one thousand million.', [])).toBe(false);
      expect(isGlossarySentence('Billion means one thousand million.', ['karu'])).toBe(false);
    });

    it('still needs a definition verb after the naming noun and word', () => {
      expect(isGlossarySentence('The word karu is old.', ['karu'])).toBe(false);
      expect(isGlossarySentence('The number billion grew.', ['billion'])).toBe(false);
      expect(isGlossarySentence('The big number billion means a lot.', ['billion'])).toBe(false);
    });

    it('keeps one exemption per word and the cap, whichever shape is used', () => {
      const sentences = [
        'Karnataka has old words.',
        'Karu means "elevated land".',
        'The word karu means "black".',
        'Nādu means "region".',
        'The soil is black.',
        'It is in the south.',
        'People grow cotton.',
      ];
      // 7 sentences → cap floor(0.3 × 7) = 2; the second karu definition is checked normally
      expect(selectExemptions(sentences, ['karu', 'nādu'])).toEqual([1, 3]);
    });
  });

  it('returns the matched word, first in hint order', () => {
    expect(glossaryWordOf('Chlorophyll means green colour.', HINTED)).toBe('chlorophyll');
    expect(glossaryWordOf('Leaves are green.', HINTED)).toBeNull();
    expect(glossaryWordOf('Anything means something.', [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripParentheticalDefinitions — rule 2
// ---------------------------------------------------------------------------
describe('stripParentheticalDefinitions', () => {
  it('removes a parenthetical definition of a hinted word and keeps the rest', () => {
    expect(stripParentheticalDefinitions(
      'Plants use photosynthesis (how plants make food) every day.', HINTED,
    )).toBe('Plants use photosynthesis every day.');
  });

  it('keeps parentheses after other words', () => {
    const s = 'The leaf (a flat green part) holds water.';
    expect(stripParentheticalDefinitions(s, HINTED)).toBe(s);
  });

  it('handles the end of a sentence and case differences', () => {
    expect(stripParentheticalDefinitions('This is Chlorophyll (green colour).', HINTED))
      .toBe('This is Chlorophyll.');
  });
});

// ---------------------------------------------------------------------------
// selectExemptions — rules 1 and 4 (one per word, capped)
// ---------------------------------------------------------------------------
describe('selectExemptions', () => {
  const plain = (n: number) => Array.from({ length: n }, (_, i) => `Plants grow fact ${i}.`);

  it('caps exemptions at the max rate, rounded down, at least 1 from 2 sentences, none for 1', () => {
    expect(GLOSSARY_EXEMPTION_MAX_RATE).toBe(0.3);
    expect(maxExemptions(0)).toBe(0);
    expect(maxExemptions(1)).toBe(0);
    expect(maxExemptions(2)).toBe(1);
    expect(maxExemptions(3)).toBe(1);
    expect(maxExemptions(4)).toBe(1);
    expect(maxExemptions(7)).toBe(2);
    expect(maxExemptions(10)).toBe(3);
  });

  it('exempts a definition in a 2-sentence node', () => {
    expect(selectExemptions(['Photosynthesis means how plants make food.', ...plain(1)], HINTED)).toEqual([0]);
  });

  it('exempts a definition sentence when the node is long enough', () => {
    const sentences = ['Photosynthesis means how plants make food.', ...plain(3)];
    expect(selectExemptions(sentences, HINTED)).toEqual([0]);
  });

  it('exempts nothing once the cap is reached: the extra definition is checked normally', () => {
    const sentences = [
      'Photosynthesis means how plants make food.',
      'Chlorophyll means the green colour in leaves.',
      ...plain(2),
    ];
    expect(selectExemptions(sentences, HINTED)).toEqual([0]);
  });

  it('exempts nothing in a 1-sentence node', () => {
    expect(selectExemptions(['Photosynthesis means food from light.'], HINTED)).toEqual([]);
  });

  it('allows at most one exempt sentence per hinted word', () => {
    const sentences = [
      'Photosynthesis means how plants make food.',
      'Photosynthesis is how plants grow.',
      ...plain(5),
    ];
    expect(selectExemptions(sentences, HINTED)).toEqual([0]);
  });

  it('exempts nothing without hinted words', () => {
    expect(selectExemptions(['Photosynthesis means food.', ...plain(5)], [])).toEqual([]);
  });
});
