import { describe, it, expect, vi } from 'vitest';
import { checkMeaning, coreTokens, findMissingEntities, shouldCheckNode } from '../../src/lib/quality/semantic';
import { detectEntities } from '../../src/lib/segmentation/ner';
import { MIN_WORDS_FOR_CHECK } from '../../src/lib/quality/config';
import type { ContentNode, Entity } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Unit vector whose cosine with [1, 0] is exactly `sim`. */
const vec = (sim: number) => [sim, Math.sqrt(1 - sim * sim)];

function entity(text: string, type: Entity['type'] = 'person'): Entity {
  return { text, type, start: 0, end: text.length };
}

// ---------------------------------------------------------------------------
// checkMeaning — one embed call, cosine of the two vectors
// ---------------------------------------------------------------------------
describe('checkMeaning', () => {
  it('embeds both texts in one call', async () => {
    const embed = vi.fn(async () => [[1, 0], [1, 0]]);
    await checkMeaning('original', 'simple', embed);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(['original', 'simple']);
  });

  it('returns the cosine similarity of the two embeddings', async () => {
    const { similarity } = await checkMeaning('a', 'b', async () => [[1, 0], vec(0.87)]);
    expect(similarity).toBeCloseTo(0.87);
  });
});

// ---------------------------------------------------------------------------
// findMissingEntities
// ---------------------------------------------------------------------------
describe('findMissingEntities', () => {
  it('finds names regardless of case and possessive', () => {
    const entities = [entity('Marie Curie'), entity('Paris', 'place')];
    expect(findMissingEntities(entities, "marie curie's lab was in PARIS.")).toEqual([]);
  });

  it('reports a dropped name once', () => {
    const entities = [entity('Marie Curie'), entity('Marie Curie')];
    expect(findMissingEntities(entities, 'She won a prize.')).toEqual(['Marie Curie']);
  });

  it('matches whole words only', () => {
    expect(findMissingEntities([entity('Ann')], 'The annual report.')).toEqual(['Ann']);
  });

  it('ignores thousands separators and matches number words by value', () => {
    expect(findMissingEntities([entity('1,500', 'number')], 'It cost 1500 dollars.')).toEqual([]);
    expect(findMissingEntities([entity('three', 'number')], 'There were 3 people.')).toEqual([]);
    expect(findMissingEntities([entity('three', 'number')], 'There were 4 people.')).toEqual(['three']);
  });

  it('passes "in PST time zone" kept as "during PST" (Chrome false failure)', () => {
    const original =
      'Please find a slot on Thursday for the review with Mary and Jose (she is in PST time zone) so the team can join.';
    const simplified =
      'Find a slot on Thursday for the review during PST when you, Mary, and Jose can meet.';
    const entities = detectEntities(original);
    expect(entities).toContainEqual(expect.objectContaining({ text: 'PST', type: 'timezone' }));
    expect(findMissingEntities(entities, simplified)).toEqual([]);
  });

  it('coreTokens drops leading in / on / at / the but never everything', () => {
    expect(coreTokens('In PST.')).toBe(' pst ');
    expect(coreTokens('at the office')).toBe(' office ');
    expect(coreTokens('the')).toBe(' the ');
  });

  it('matches a time zone written with its filler words', () => {
    expect(findMissingEntities([entity('in PST time zone', 'timezone')], 'Meet during PST.')).toEqual([]);
    expect(findMissingEntities([entity('PST', 'timezone')], 'Meet in the morning.')).toEqual(['PST']);
    expect(findMissingEntities([entity('PST', 'timezone')], 'The past week.')).toEqual(['PST']);
  });

  it('ignores a leading in / on / at / the', () => {
    expect(findMissingEntities([entity('on Monday at 3pm', 'date')], 'Come Monday at 3pm.')).toEqual([]);
    expect(findMissingEntities([entity('in 1903', 'date')], 'She won that prize back in 1903.')).toEqual([]);
    expect(findMissingEntities([entity('The Hague', 'place')], 'They met at Hague.')).toEqual([]);
    expect(findMissingEntities([entity('on Monday', 'date')], 'Come on Tuesday.')).toEqual(['on Monday']);
  });

  // Chrome false failures: same value, different wording
  it('keeps "for the next 21 years" as "for 21 years" (dates and durations by value)', () => {
    const original = 'He then lived in Paris for the next 21 years, writing every day.';
    const entities = detectEntities(original);
    expect(entities).toContainEqual(expect.objectContaining({ type: 'date' }));
    expect(findMissingEntities(entities, 'He lived in Paris for 21 years and wrote every day.')).toEqual([]);
    expect(findMissingEntities([entity('next 21 years', 'date')], 'He lived there for 21 years.')).toEqual([]);
  });

  it('keeps "aged 45" as "at age 45"', () => {
    const original = 'She died in Warsaw, aged 45, after a long illness.';
    const entities = detectEntities(original);
    expect(findMissingEntities(entities, 'She died in Warsaw at age 45 after being sick for a long time.')).toEqual([]);
    expect(findMissingEntities([entity('aged 45', 'number')], 'She died at age 45.')).toEqual([]);
  });

  it('still fails a real drop: "1893" missing', () => {
    const original = 'The bridge over the river opened in 1893 after six years of work.';
    const entities = detectEntities(original);
    const missing = findMissingEntities(entities, 'The bridge over the river opened after years of work.');
    expect(missing.some(m => m.includes('1893'))).toBe(true);
  });

  it('fails a changed unit or number in a duration', () => {
    expect(findMissingEntities([entity('next 21 years', 'date')], 'for 21 months')).toEqual(['next 21 years']);
    expect(findMissingEntities([entity('next 21 years', 'date')], 'for 12 years')).toEqual(['next 21 years']);
  });

  // Calibration (dev items): kept names and values worded differently
  it('keeps a name by its capitalised words, a person by surname, an organization by acronym', () => {
    expect(findMissingEntities([entity('coast of Queensland, Australia', 'place')], "It's near Queensland, Australia.")).toEqual([]);
    expect(findMissingEntities([entity('Apurímac rivers', 'place')], 'The Apurímac River starts in Peru.')).toEqual([]);
    expect(findMissingEntities([entity('Marie Curie')], 'Maria Skłodowska Curie was a physicist.')).toEqual([]);
    expect(findMissingEntities([entity('World Health Organization', 'org')], 'WHO says there are 25 vaccines.')).toEqual([]);
  });

  it('still fails a dropped or replaced name, and "who" is not WHO', () => {
    expect(findMissingEntities([entity('Cordillera Rumi Cruz', 'place')], 'a mountain range in Peru')).toEqual(['Cordillera Rumi Cruz']);
    expect(findMissingEntities([entity('Professor Henri Becquerel')], 'for radioactivity work')).toEqual(['Professor Henri Becquerel']);
    expect(findMissingEntities([entity('Albert Einstein')], "Isaac Newton's theory")).toEqual(['Albert Einstein']);
    expect(findMissingEntities([entity('World Health Organization', 'org')], 'People who get vaccines stay well.'))
      .toEqual(['World Health Organization']);
  });

  it('does not require the weekday of a full date', () => {
    const original = 'The Great Fire of London occurred from Sunday 2 September to Wednesday 5 September 1666.';
    expect(findMissingEntities(detectEntities(original), 'Great Fire of London happened from Sep 2 to Sep 5, 1666.')).toEqual([]);
    expect(findMissingEntities([entity('on Monday', 'date')], 'Come on Tuesday.')).toEqual(['on Monday']);
  });

  it('does not require a unit conversion in brackets', () => {
    const original = 'The reef stretches for over 2,300 kilometres (1,400 mi) along the coast of the state.';
    const entities = detectEntities(original);
    expect(entities.map(e => e.text)).not.toContain('1,400');
    expect(findMissingEntities(entities, 'The reef is about 2,300 km long along the coast of the state.')).toEqual([]);
  });

  it('never counts "an" as a number', () => {
    expect(findMissingEntities([entity('an', 'number')], 'Schedule a one-hour meeting.')).toEqual([]);
    expect(detectEntities('Schedule an hour-long meeting with Jose.').map(e => e.text)).not.toContain('an');
  });

  it('keeps dates as written', () => {
    expect(findMissingEntities([entity('1903', 'date')], 'In 1903, she won.')).toEqual([]);
    expect(findMissingEntities([entity('1903', 'date')], 'Long ago, she won.')).toEqual(['1903']);
  });
});

// ---------------------------------------------------------------------------
// shouldCheckNode
// ---------------------------------------------------------------------------
describe('shouldCheckNode', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const node = (type: ContentNode['type'], text: string): ContentNode => ({ id: 'n0', type, text });

  it('checks paragraphs with at least MIN_WORDS_FOR_CHECK words', () => {
    expect(MIN_WORDS_FOR_CHECK).toBe(8);
    expect(shouldCheckNode(node('paragraph', words(8)))).toBe(true);
    expect(shouldCheckNode(node('paragraph', words(7)))).toBe(false);
  });

  it('never checks headings', () => {
    expect(shouldCheckNode(node('heading', words(12)))).toBe(false);
  });
});
