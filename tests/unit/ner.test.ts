import { describe, it, expect } from 'vitest';
import { detectEntities } from '../../src/lib/segmentation/ner';

// ---------------------------------------------------------------------------
// detectEntities — compromise-based NER with character offsets
// ---------------------------------------------------------------------------
describe('detectEntities', () => {
  const text = 'Barack Obama visited Paris on March 5th.';

  it('finds people and places', () => {
    const types = detectEntities(text).map(e => e.type);
    expect(types).toContain('person');
    expect(types).toContain('place');
  });

  it('returns offsets that slice back to the entity text', () => {
    const entities = detectEntities(text);
    expect(entities.length).toBeGreaterThan(0);
    for (const e of entities) {
      expect(text.slice(e.start, e.end)).toBe(e.text);
    }
  });

  it('returns entities sorted and non-overlapping', () => {
    const entities = detectEntities(text);
    for (let i = 1; i < entities.length; i++) {
      expect(entities[i].start).toBeGreaterThanOrEqual(entities[i - 1].end);
    }
  });

  it('finds organizations in a paragraph (moved from the segmenter test)', () => {
    expect(detectEntities('NASA launched the probe in 2024.').map(e => e.text)).toContain('NASA');
  });

  it('returns an empty list for empty text', () => {
    expect(detectEntities('')).toEqual([]);
  });
});
