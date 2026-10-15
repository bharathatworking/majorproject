import { describe, it, expect } from 'vitest';
import {
  aggregate, buildPremises, lexicalRank, PREMISE_STRATEGY, rankPremises,
} from '../../src/lib/quality/premises';

// ---------------------------------------------------------------------------
// buildPremises
// ---------------------------------------------------------------------------
describe('buildPremises', () => {
  it('lists every sentence, then every window of 2 adjacent sentences', () => {
    expect(buildPremises(['A.', 'B.', 'C.'])).toEqual(['A.', 'B.', 'C.', 'A. B.', 'B. C.']);
  });

  it('gives a 1-sentence original just that sentence', () => {
    expect(buildPremises(['Only one.'])).toEqual(['Only one.']);
  });

  it('drops empty sentences and returns nothing for none', () => {
    expect(buildPremises(['  ', 'A.', ''])).toEqual(['A.']);
    expect(buildPremises([])).toEqual([]);
  });

  it('names the strategy for the run log', () => {
    expect(PREMISE_STRATEGY).toBe('summac-sentences+pairs/top3');
  });
});

// ---------------------------------------------------------------------------
// rankPremises / lexicalRank
// ---------------------------------------------------------------------------
describe('rankPremises', () => {
  const premises = [[1, 0], [0, 1], [0.6, 0.8], [0.8, 0.6]];

  it('returns the k most similar premises per hypothesis, best first', () => {
    expect(rankPremises(premises, [[1, 0], [0, 1]], 2)).toEqual([[0, 3], [1, 2]]);
  });

  it('keeps the lower index on ties and never returns more than exist', () => {
    expect(rankPremises([[1, 0], [1, 0]], [[1, 0]], 3)).toEqual([[0, 1]]);
  });
});

describe('lexicalRank', () => {
  const premises = ['Marie Curie won the Nobel Prize.', 'She was born in Warsaw in 1867.', 'Radium glows.'];

  it('ranks by shared content words and numbers', () => {
    expect(lexicalRank(premises, ['Curie was born in 1867 in Warsaw.'], 1)).toEqual([[1]]);
    expect(lexicalRank(premises, ['The Nobel Prize went to Curie.'], 2)[0][0]).toBe(0);
  });

  it('ignores stop words and handles thousands separators', () => {
    expect(lexicalRank(['It cost 1,500 dollars.', 'The sky is blue.'], ['The price was 1500 dollars.'], 1)).toEqual([[0]]);
  });

  it('falls back to document order when nothing overlaps', () => {
    expect(lexicalRank(premises, ['Zebras run.'], 2)).toEqual([[0, 1]]);
  });
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------
describe('aggregate', () => {
  const probs = [
    { entailment: 0.2, contradiction: 0.5 },
    { entailment: 0.9, contradiction: 0.05 },
    { entailment: 0.4, contradiction: 0.1 },
  ];

  it("'max': best entailment, highest contradiction over all premises", () => {
    expect(aggregate(probs, 'max')).toEqual({ entailment: 0.9, contradiction: 0.5, best: 1 });
  });

  it("'best-entailing': the contradiction of the best-entailing premise", () => {
    expect(aggregate(probs, 'best-entailing')).toEqual({ entailment: 0.9, contradiction: 0.05, best: 1 });
  });

  it('throws without premises', () => {
    expect(() => aggregate([], 'max')).toThrow();
  });
});
