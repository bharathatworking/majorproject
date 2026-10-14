import { describe, it, expect } from 'vitest';
import { sha256 } from '../../src/lib/utils/hash';
import { escapeHtml } from '../../src/lib/utils/html';
import { getHostname } from '../../src/lib/utils/url';
import { isRestrictedPageError, isRestrictedUrl } from '../../src/lib/utils/restricted-pages';

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

// ---------------------------------------------------------------------------
// getHostname — non-throwing hostname for display
// ---------------------------------------------------------------------------
describe('getHostname', () => {
  it('returns the hostname of a valid URL', () => {
    expect(getHostname('https://www.example.com/a/b?c=1')).toBe('www.example.com');
  });

  it('returns null for a malformed URL', () => {
    expect(getHostname('not a url')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(getHostname('')).toBeNull();
  });

  it('returns null for a URL without a host', () => {
    expect(getHostname('about:blank')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Restricted pages — pages Chrome never lets extensions script
// ---------------------------------------------------------------------------
describe('isRestrictedUrl', () => {
  it('flags browser-internal schemes', () => {
    for (const url of [
      'chrome://extensions/',
      'chrome://newtab/',
      'chrome-extension://abcdefghijklmnop/page.html',
      'edge://settings',
      'about:blank',
      'view-source:https://example.com/',
      'devtools://devtools/bundled/inspector.html',
    ]) {
      expect(isRestrictedUrl(url), url).toBe(true);
    }
  });

  it('flags the Chrome Web Store', () => {
    expect(isRestrictedUrl('https://chromewebstore.google.com/detail/abc')).toBe(true);
    expect(isRestrictedUrl('https://chrome.google.com/webstore/category/extensions')).toBe(true);
  });

  it('allows ordinary web pages', () => {
    expect(isRestrictedUrl('https://en.wikipedia.org/wiki/Reading')).toBe(false);
    expect(isRestrictedUrl('http://localhost:3000/')).toBe(false);
    expect(isRestrictedUrl('https://chrome.google.com/other')).toBe(false);
  });

  it('returns false for unparseable input', () => {
    expect(isRestrictedUrl('')).toBe(false);
    expect(isRestrictedUrl('not a url')).toBe(false);
  });
});

describe('isRestrictedPageError', () => {
  it('recognises Chrome protected-page rejections', () => {
    expect(isRestrictedPageError(new Error('Cannot access a chrome:// URL'))).toBe(true);
    expect(isRestrictedPageError(new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'))).toBe(true);
    expect(isRestrictedPageError(new Error('The extensions gallery cannot be scripted.'))).toBe(true);
    expect(isRestrictedPageError('Cannot access a chrome-extension:// URL of different extension')).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isRestrictedPageError(new Error('No tab with id: 42.'))).toBe(false);
    expect(isRestrictedPageError(new Error('Could not load file: extractor.js'))).toBe(false);
  });
});
