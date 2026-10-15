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

  it('does not exempt a definition of a word that was not hinted', () => {
    expect(isGlossarySentence('Respiration means how cells use food.', HINTED)).toBe(false);
  });

  it('needs the word at the start, followed by a definition verb', () => {
    expect(isGlossarySentence('Plants use photosynthesis every day.', HINTED)).toBe(false);
    expect(isGlossarySentence('Photosynthesis happens in leaves.', HINTED)).toBe(false);
    expect(isGlossarySentence('Photosynthesise is a verb.', HINTED)).toBe(false);
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

  it('caps exemptions at the max rate, rounded down', () => {
    expect(GLOSSARY_EXEMPTION_MAX_RATE).toBe(0.3);
    expect(maxExemptions(3)).toBe(0);
    expect(maxExemptions(4)).toBe(1);
    expect(maxExemptions(10)).toBe(3);
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

  it('exempts nothing in a short node', () => {
    expect(selectExemptions(['Photosynthesis means food from light.', ...plain(2)], HINTED)).toEqual([]);
  });

  it('allows at most one exempt sentence per hinted word', () => {
    const sentences = [
      'Photosynthesis means how plants make food.',
      'Photosynthesis is also how plants grow.',
      ...plain(5),
    ];
    expect(selectExemptions(sentences, HINTED)).toEqual([0]);
  });

  it('exempts nothing without hinted words', () => {
    expect(selectExemptions(['Photosynthesis means food.', ...plain(5)], [])).toEqual([]);
  });
});
