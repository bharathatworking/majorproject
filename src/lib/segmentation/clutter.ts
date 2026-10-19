/**
 * Removes Wikipedia clutter from a node's text before it goes to the model:
 * citation markers and hatnotes. In the UK Wikipedia paste
 * (eval/fixtures/uk-wiki-paste.txt) the model saw "Britain,[l] is a
 * country" and a paragraph that began "See also: Britain (place name) and
 * Terminology of the British Isles The Acts of Union 1707 …".
 *
 * Design decisions:
 *  - Only the model input and the meaning-check source are cleaned (the run
 *    loop, lib/run/simplify.ts). The stored and displayed original stays
 *    exactly as captured, so Reading's click-to-reveal still shows it.
 *  - Citation markers: [12], [l], [ab], [note 3], [citation needed]
 *    (CITATION). Anything else in brackets stays: [sic], [1a], [edit].
 *  - Hatnotes start with "See also:", "Main article(s):", "Further
 *    information:" or "For other uses" at the start of a line. A pasted
 *    hatnote often runs straight into the paragraph with no line break, so
 *    it ends at the first sentence end (". " after a word that is not an
 *    initial) or at the first sentence-starting capital word (STARTERS: The,
 *    In, It, …) that doesn't follow a connector ("and", "or", ",", ";",
 *    ":"): "… Terminology of the British Isles | The Acts of Union …". The
 *    hatnote's own first word never ends it ("See also: The Troubles").
 *    A line that is only a hatnote becomes empty.
 *  - Text without clutter is returned unchanged (same string), so the run
 *    can tell whether anything was removed.
 *  - Pure and DOM-free.
 */

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** Wikipedia citation markers (the shapes the UK paste had, plus notes). */
const CITATION = /\[(?:\d{1,3}|[a-z]{1,2}|note \d+|citation needed)\]/g;

/** A hatnote at the start of a line; the match ends after its label. */
const HATNOTE = /^\s*(?:See also|Main articles?|Further information|For other uses)\b:?/i;
const HATNOTE_ANY_LINE = /(?:^|\n)\s*(?:See also|Main articles?|Further information|For other uses)\b/i;

/** Capital words that start a sentence but rarely sit inside a link title. */
const STARTERS = new Set([
  'The', 'A', 'An', 'In', 'On', 'At', 'It', 'Its', 'This', 'These', 'Those', 'There', 'They', 'He', 'She', 'We',
  'During', 'After', 'Before', 'Since', 'From', 'By', 'As', 'When', 'While', 'Although', 'Following', 'Most',
  'Many', 'Some', 'Over', 'Under', 'Today', 'However', 'Until', 'According',
]);

/** A word after which the hatnote's list goes on. */
const CONNECTOR = /^(?:and|or)$|[,;:]$/i;

/** Ends a sentence (closing quotes or brackets allowed). */
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

/** "U.S." or "J." — an initial, not a sentence end. */
const INITIALS = /^\(?(?:[A-Z]\.)+$/;

// ─── Cleaning ─────────────────────────────────────────────────────────────────

/** What follows the hatnote at the start of `line` ('' when the line is all hatnote). */
function afterHatnote(line: string): string {
  const label = HATNOTE.exec(line);
  if (!label) return line;
  const rest = line.slice(label[0].length);
  let previous: string | null = null;
  for (const m of rest.matchAll(/\S+/g)) {
    const word = m[0];
    const at = m.index ?? 0;
    if (previous !== null && STARTERS.has(word) && !CONNECTOR.test(previous)) return rest.slice(at).trim();
    if (previous !== null && SENTENCE_END.test(word) && !INITIALS.test(word)) {
      return rest.slice(at + word.length).trim();
    }
    previous = word;
  }
  return '';
}

/**
 * `text` without citation markers and hatnotes (rules in the file header);
 * the same string when there is nothing to remove.
 */
export function cleanForModel(text: string): string {
  CITATION.lastIndex = 0;
  if (!CITATION.test(text) && !HATNOTE_ANY_LINE.test(text)) return text;
  return text
    .split('\n')
    .map(afterHatnote)
    .map(line => line
      .replace(CITATION, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([,.;:!?])/g, '$1')
      .trim())
    .filter(line => line !== '')
    .join('\n');
}
