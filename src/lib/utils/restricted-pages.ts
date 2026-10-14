/**
 * Detection of pages Chrome never lets extensions script.
 *
 * Clicking the toolbar button on chrome://, the Web Store, another extension's
 * page, etc. is a normal user action, not a failure. Chrome rejects
 * executeScript on those pages, and logging that with console.error put an
 * entry under chrome://extensions → Errors every time. The background uses
 * these helpers to skip injection up front when the URL is known, and to tell
 * an expected rejection apart from a real failure when it is not.
 *
 * Design decisions:
 *  - Pure (no chrome.* calls) so it is unit-testable under vitest's node env.
 *  - The URL check is a best-effort fast path; the error check is the backstop
 *    for cases the URL can't reveal (PDF viewer, policy-blocked hosts,
 *    file:// without "Allow access to file URLs").
 */

// ─── URL check ────────────────────────────────────────────────────────────────

const RESTRICTED_PROTOCOLS = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'chrome-search:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
]);

/** True if Chrome is known to block extensions from scripting `url`. */
export function isRestrictedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (RESTRICTED_PROTOCOLS.has(parsed.protocol)) return true;
  if (parsed.hostname === 'chromewebstore.google.com') return true;
  return parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore');
}

// ─── Error check ──────────────────────────────────────────────────────────────

/** Messages Chrome uses when executeScript is refused for a protected page. */
const RESTRICTED_ERROR = /cannot access|cannot be scripted|extensions gallery/i;

/** True if an executeScript rejection means "this page is off-limits". */
export function isRestrictedPageError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RESTRICTED_ERROR.test(message);
}
