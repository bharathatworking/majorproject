import { describe, it, expect } from 'vitest';
import { sha256 } from '../../src/lib/utils/hash';
import { escapeHtml } from '../../src/lib/utils/html';

// ---------------------------------------------------------------------------
// sha256 — shared content hash used for document dedup
// ---------------------------------------------------------------------------
describe('sha256', () => {
  it('matches the FIPS 180-2 "abc" test vector', async () => {
    expect(await sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the empty string', async () => {
    expect(await sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('encodes non-ASCII text as UTF-8', async () => {
    // Digest of the UTF-8 bytes of "é" (c3 a9), computed with Node's crypto module
    expect(await sha256('é')).toBe(
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    );
  });
});

// ---------------------------------------------------------------------------
// escapeHtml — plain text → safe element content
// ---------------------------------------------------------------------------
describe('escapeHtml', () => {
  it('escapes & < > and "', () => {
    expect(escapeHtml('<a href="x">Tom & Jerry</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;',
    );
  });

  it('escapes & first so existing entities are escaped exactly once', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeHtml("It's plain text.")).toBe("It's plain text.");
  });
});
