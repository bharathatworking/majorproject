import { describe, it, expect } from 'vitest';
import { signatureKept, valueSignature } from '../../src/lib/quality/values';

const tokens = (text: string) => [...valueSignature(text).tokens].sort();
const kept = (entity: string, output: string) => signatureKept(valueSignature(entity), valueSignature(output));

// ---------------------------------------------------------------------------
// valueSignature
// ---------------------------------------------------------------------------
describe('valueSignature', () => {
  it('reads numbers in digits and words, with thousands separators ignored', () => {
    expect(tokens('three apples and 1,500 pears')).toEqual(['1500', '3']);
    expect(tokens('twenty-one')).toEqual(['21']);
    expect(tokens('1.5 million')).toEqual(['1500000']);
  });

  it('pairs a number with the unit right after it (singular)', () => {
    expect(tokens('for the next 21 years')).toEqual(['21', '21 year']);
    expect(tokens('a 30-minute slot')).toEqual(['30', '30 minute']);
    expect(tokens('45%')).toEqual(['45', '45 percent']);
    expect(tokens('over 40 hours')).toEqual(['40', '40 hour']);
  });

  it('ignores modifiers', () => {
    for (const t of ['aged 45', 'at age 45', 'about 45', 'around 45', 'nearly 45', 'over 45', 'at least 45']) {
      expect(tokens(t)).toEqual(['45']);
    }
  });

  it('reads months, weekdays and time zones', () => {
    expect(tokens('5 June 1893')).toEqual(['1893', '5', 'month:june']);
    expect(tokens('on Mondays')).toEqual(['day:monday']);
    expect(tokens('during PST')).toEqual(['tz:pst']);
  });

  it('reads may / march as months only next to a number', () => {
    expect(tokens('May 5, 1893')).toContain('month:may');
    expect(tokens('she may go')).toEqual([]);
    expect(tokens('they march on')).toEqual([]);
  });

  it('has no value for words without a number, month, weekday or time zone', () => {
    for (const t of ['an', 'this week', 'any hours', '(over', 'week']) {
      expect(valueSignature(t).hasValue).toBe(false);
    }
    expect(tokens('Wednesday hours')).toEqual(['day:wednesday']);
  });
});

// ---------------------------------------------------------------------------
// signatureKept
// ---------------------------------------------------------------------------
describe('signatureKept', () => {
  it('keeps the same value worded differently', () => {
    expect(kept('next 21 years', 'He stayed for 21 years.')).toBe(true);
    expect(kept('aged 45', 'She died at age 45.')).toBe(true);
    expect(kept('twenty-one years', 'for 21 years')).toBe(true);
  });

  it('fails a changed number, unit, month or weekday', () => {
    expect(kept('next 21 years', 'for 21 months')).toBe(false);
    expect(kept('1893', 'in 1983')).toBe(false);
    expect(kept('5 June 1893', 'on 5 July 1893')).toBe(false);
    expect(kept('Monday', 'on Tuesday')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Centuries (UK Wikipedia run: "Over the 17th century" → "In the 1600s")
// ---------------------------------------------------------------------------
describe('centuries', () => {
  it('names a century the same way in words, digits and hundreds', () => {
    for (const t of ['17th century', 'seventeenth century', '17th-century', 'the 1600s', 'two 17th centuries']) {
      expect(valueSignature(t).tokens.has('century:17')).toBe(true);
    }
    expect(valueSignature('twenty-first century').tokens.has('century:21')).toBe(true);
    expect(valueSignature('1900s').tokens.has('century:20')).toBe(true);
  });

  it('treats "17th century" and "1600s" as equal when matching, both ways', () => {
    expect(kept('17th century', 'In the 1600s the king had less power.')).toBe(true);
    expect(kept('1600s', 'During the 17th century, the king had less power.')).toBe(true);
    expect(kept('seventeenth century', 'the 1600s')).toBe(true);
  });

  it('still tells centuries apart, and leaves decades and plain years alone', () => {
    expect(kept('17th century', 'In the 1700s the king had less power.')).toBe(false);
    expect(kept('1920s', 'In the 1920s the empire was large.')).toBe(true);
    expect(kept('1920s', 'In the 1900s the empire was large.')).toBe(false);
    expect(valueSignature('1920s').tokens.has('century:20')).toBe(false);
    expect(kept('1600', 'the 1600s')).toBe(true);
  });

  it('a plain ordinal is still kept by a century phrase that contains it', () => {
    expect(kept('19th', 'London was the main money centre in the 19th century.')).toBe(true);
  });
});
