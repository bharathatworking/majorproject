/**
 * SHA-256 content hashing shared by every input path (web capture, paste, PDF).
 *
 * All three must hash identically so `upsertDocument` can dedup by
 * `contentHash`. Uses Web Crypto, which is available in pages, content
 * scripts, the service worker, and Node (for unit tests).
 */

// ─── Hash ─────────────────────────────────────────────────────────────────────

/** Returns the lowercase hex SHA-256 digest of the UTF-8 encoding of `text`. */
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
