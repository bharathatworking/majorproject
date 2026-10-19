import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanForModel } from '../../src/lib/segmentation/clutter';

/** The 8 paragraphs of the UK Wikipedia paste (eval/fixtures/README.md: dev fixture only). */
const UK = readFileSync('eval/fixtures/uk-wiki-paste.txt', 'utf8').split(/\r?\n\r?\n/).map(p => p.trim());
const MARKER = /\[(?:\d{1,3}|[a-z]{1,2})\]/;

describe('cleanForModel: citation markers', () => {
  it('n0: removes [l], [m] and [e] and closes the gaps', () => {
    const clean = cleanForModel(UK[0]);
    expect(clean).not.toMatch(MARKER);
    expect(clean).toContain('commonly known as the United Kingdom (UK) or Britain, is a country in Northwestern Europe');
    expect(clean).toContain('England, Scotland, Wales and Northern Ireland, with a population');
    expect(clean).toContain('(244,376 km2). It shares a land border');
    expect(clean.length).toBe(UK[0].length - '[l][m][e]'.length);
  });

  it('removes notes and [citation needed], keeps [sic] and other brackets', () => {
    expect(cleanForModel('It grew.[note 3] It was big [citation needed].')).toBe('It grew. It was big.');
    expect(cleanForModel('He wrote "teh" [sic] in 1901.[1a] See [edit].')).toBe('He wrote "teh" [sic] in 1901.[1a] See [edit].');
  });

  it('returns the same text when there is nothing to remove', () => {
    expect(cleanForModel(UK[1])).toBe(UK[1]);
    expect(cleanForModel('Plain text.')).toBe('Plain text.');
  });
});

describe('cleanForModel: hatnotes', () => {
  it('n5: cuts the "See also:" hatnote that runs into the paragraph, and the markers', () => {
    const clean = cleanForModel(UK[5]);
    expect(clean.startsWith('The Acts of Union 1707 declared that the Kingdom of England and the Kingdom of Scotland')).toBe(true);
    expect(clean).not.toContain('See also');
    expect(clean).not.toContain('Terminology of the British Isles');
    expect(clean).not.toMatch(MARKER);
    expect(clean).toContain('"United into One Kingdom by the Name of Great Britain". The term "United Kingdom"');
    expect(clean.endsWith('the "United Kingdom of Great Britain and Northern Ireland".')).toBe(true);
  });

  it('drops a hatnote line, and a text that is only a hatnote', () => {
    expect(cleanForModel('Main article: History of the United Kingdom\nThe UK was formed in 1707.')).toBe('The UK was formed in 1707.');
    expect(cleanForModel('Main article: History of the United Kingdom')).toBe('');
    expect(cleanForModel('Further information: Geography of Scotland')).toBe('');
  });

  it('ends an inline hatnote at a sentence end, and never at its first word', () => {
    expect(cleanForModel('For other uses, see Britain (disambiguation). Britain is an island.')).toBe('Britain is an island.');
    expect(cleanForModel('See also: The Troubles and Irish history In 1998 the agreement was signed.'))
      .toBe('In 1998 the agreement was signed.');
    expect(cleanForModel('See also: J. R. R. Tolkien and Oxford The city has a famous university.'))
      .toBe('The city has a famous university.');
  });

  it('leaves "See also" alone when it is not at the start of a line', () => {
    const text = 'Many readers see also the later works. See the notes.';
    expect(cleanForModel(text)).toBe(text);
  });
});
