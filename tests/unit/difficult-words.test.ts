import { describe, it, expect } from 'vitest';
import { findDifficultWords, MAX_DIFFICULT_WORDS } from '../../src/lib/metrics/difficult-words';
import { BASE_COMMON_WORDS } from '../../src/lib/metrics/common-words';
import type { Entity } from '../../src/types';

const words = new Set(BASE_COMMON_WORDS);

function entity(text: string, type: Entity['type'] = 'org'): Entity {
  return { text, type, start: 0, end: text.length };
}

// ---------------------------------------------------------------------------
// findDifficultWords — filters, dedupe, cap
// ---------------------------------------------------------------------------
describe('findDifficultWords', () => {
  it('returns uncommon words and skips common ones', () => {
    expect(findDifficultWords('The people saw photosynthesis in the leaves.', [], words))
      .toEqual(['photosynthesis']);
  });

  it('treats inflected forms of common words as common', () => {
    expect(findDifficultWords('They were running and talked loudly.', [], words)).toEqual([]);
  });

  it('skips words of 3 letters or fewer', () => {
    expect(findDifficultWords('The ATP and DNA mix.', [], words)).toEqual([]);
  });

  it('skips words that belong to an entity', () => {
    const text = 'Zorblax Industries studied mitochondria.';
    expect(findDifficultWords(text, [entity('Zorblax Industries')], words)).toEqual(['mitochondria']);
  });

  it('respects custom words in the word set', () => {
    const custom = new Set([...words, 'mitochondria']);
    expect(findDifficultWords('Mitochondria hold chlorophyll.', [], custom)).toEqual(['chlorophyll']);
  });

  it('dedupes case-insensitively and keeps the first spelling', () => {
    expect(findDifficultWords('Chlorophyll is green. The chlorophyll is in the light.', [], words))
      .toEqual(['Chlorophyll']);
  });

  it(`returns at most ${MAX_DIFFICULT_WORDS} words, in order of appearance`, () => {
    const hard = [
      'axolotl', 'quinoa', 'zeitgeist', 'oxymoron', 'pharynx',
      'isotope', 'mitosis', 'enzyme', 'catalyst', 'ribosome',
    ];
    expect(findDifficultWords(hard.join(' '), [], words)).toEqual(hard.slice(0, MAX_DIFFICULT_WORDS));
  });

  it('returns an empty list for empty text', () => {
    expect(findDifficultWords('', [], words)).toEqual([]);
  });
});
