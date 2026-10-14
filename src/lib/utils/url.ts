/**
 * URL helpers for display.
 *
 * `new URL()` throws on malformed input, and stored `sourceUrl` values come
 * from captured pages, so render paths use this non-throwing wrapper instead.
 */

// ─── Hostname ─────────────────────────────────────────────────────────────────

/** Returns the hostname of `url`, or null if it can't be parsed or has none. */
export function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
