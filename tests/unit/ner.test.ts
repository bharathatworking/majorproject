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

  it('classifies a time zone as a timezone without its preposition', () => {
    const text = 'Call Anna (she is in PST time zone) on Monday.';
    const zone = detectEntities(text).find(e => e.type === 'timezone');
    expect(zone).toMatchObject({ text: 'PST' });
    expect(text.slice(zone!.start, zone!.end)).toBe('PST');
    expect(detectEntities('Logs use UTC.')).toContainEqual(expect.objectContaining({ text: 'UTC', type: 'timezone' }));
  });

  it('trims trailing punctuation and keeps a clock time with a zone as a date', () => {
    const text = 'The meeting is at 9am EST.';
    const entities = detectEntities(text);
    expect(entities).toContainEqual(expect.objectContaining({ text: '9am EST', type: 'date' }));
    for (const e of entities) expect(text.slice(e.start, e.end)).toBe(e.text);
  });

  // Junk entities from the "example user test plan" run report, each of which
  // the prompt asked the model to keep and the check reported as dropped
  describe('clean-up of junk entities (user test plan run)', () => {
    const TEST_PLAN =
      'Half of the participants will do session 1 tasks using Google Calendar and session 2 tasks with Team Cal. ' +
      'The other half of the participants will do session 1 tasks with Team Cal and session 2 tasks with Google Calendar. ' +
      'Find three potential 30-minute meeting slots during PST working hours (she is in PST time zone). Find a time. ' +
      'Objectives: 1. Formative: identify issues. 2. Summative: compare TeamCal (Google Calendar or TeamCal). ' +
      'Common Meeting Times: "You want to schedule an hour-long meeting with two of your employees—Jose and Annika—' +
      'and a potential investor (Ricky)." You have been shorthanded and some employees are scheduled to work ' +
      'overtime (over 40 hours) this week. She takes over any hours that are filled.';
    const entities = detectEntities(TEST_PLAN);
    const texts = entities.map(e => e.text);

    it('slices every entity back to the text', () => {
      for (const e of entities) expect(TEST_PLAN.slice(e.start, e.end)).toBe(e.text);
    });

    it('cuts names at a sentence end or an opening bracket, and trims brackets, quotes and dashes', () => {
      expect(texts).toContain('Team Cal');
      expect(texts).not.toContain('Team Cal. The other');
      expect(texts).toContain('TeamCal');
      expect(texts.some(t => t.includes('('))).toBe(false);
      expect(texts).toContain('Annika');
      expect(texts).toContain('Ricky');
    });

    it('drops numbers and dates without a comparable value', () => {
      for (const junk of ['an', 'week', 'this week', 'any hours', '(over', 'over']) expect(texts).not.toContain(junk);
      expect(entities).toContainEqual(expect.objectContaining({ text: '40', type: 'number' }));
    });

    it('drops inline list markers but keeps real numbers', () => {
      const markerStart = TEST_PLAN.indexOf('1. Formative');
      expect(entities.some(e => e.start === markerStart)).toBe(false);
      expect(entities.some(e => e.start === TEST_PLAN.indexOf('2. Summative'))).toBe(false);
      expect(entities.some(e => e.start === TEST_PLAN.indexOf('1 tasks'))).toBe(true);
    });

    it('drops a label followed by ":" and lowercase "names"', () => {
      expect(texts.some(t => /Meeting Times/.test(t))).toBe(false);
      expect(texts.some(t => /zone/.test(t))).toBe(false);
    });

    it('reads "during PST" as the time zone PST', () => {
      expect(entities).toContainEqual(expect.objectContaining({ text: 'PST', type: 'timezone' }));
      expect(texts).not.toContain('during PST');
    });
  });

  it('keeps a number at the end of a sentence (not a list marker)', () => {
    const text = 'The war ended in 1945. The treaty followed.';
    expect(detectEntities(text).map(e => e.text)).toContain('1945');
  });

  it('returns an empty list for empty text', () => {
    expect(detectEntities('')).toEqual([]);
  });
});
