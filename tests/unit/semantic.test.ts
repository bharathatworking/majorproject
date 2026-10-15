import { describe, it, expect, vi } from 'vitest';
import { checkMeaning, findMissingEntities, shouldCheckNode } from '../../src/lib/quality/semantic';
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
