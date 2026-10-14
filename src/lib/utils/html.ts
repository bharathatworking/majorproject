/**
 * HTML escaping for building simple markup from untrusted plain text
 * (pasted text, PDF page text).
 *
 * `&` is replaced first so the entities produced by later replacements are
 * not double-escaped.
 */

// ─── Escape ───────────────────────────────────────────────────────────────────

/** Escapes `& < > "` so `text` is safe inside element content or a quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
