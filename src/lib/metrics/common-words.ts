/**
 * Common-word lexicon for the jargon-density and Dale-Chall metrics.
 *
 * A word counts as "difficult" when neither it nor any of its simple base
 * forms is in this list (or in the user's custom words).
 *
 * Source:
 *   FrequencyWords by Hermit Dave, English 2018 list (OpenSubtitles 2018 corpus
 *   from OPUS, http://opus.nlpl.eu/OpenSubtitles2018.php).
 *   https://github.com/hermitdave/FrequencyWords/blob/525f9b560de45753a5ea01069454e72e9aa541c6/content/2018/en/en_50k.txt
 *
 * License:
 *   The word-list content is licensed CC BY-SA 4.0
 *   (https://creativecommons.org/licenses/by-sa/4.0/); the FrequencyWords code
 *   is MIT. data/common-words.txt is an adaptation of that content and is
 *   distributed under the same CC BY-SA 4.0 license, with attribution to
 *   Hermit Dave / FrequencyWords and the OpenSubtitles 2018 corpus.
 *
 * How data/common-words.txt was made from en_50k.txt:
 *   first 5,000 lines (frequency order) → keep the word column → lower-case →
 *   keep only /^[a-z]+$/ (drops tokens such as 's, 't, mr.) → de-duplicate.
 *   Result: 4,950 words, one per line.
 *
 * Design decisions:
 *  - Loaded as a Vite `?raw` import, so the list ships as a string inside the
 *    JS chunk that imports this module. Only app-page code (Dashboard, the
 *    simplification run) reaches this file; never import it from
 *    src/background/ or the content scripts, or the list is bundled into the
 *    service worker as well.
 *  - The corpus is film/TV dialogue, so everyday spoken words are well covered
 *    and some rarer concrete nouns are missing ("mat" ranks ~8,500). Users can
 *    add those in Settings → custom words.
 *  - Word-form matching is a small suffix stripper, not a stemmer: it only
 *    proposes base forms, and a word is common if any candidate is in the list.
 *    False positives require the stripped base to be a real common word, which
 *    keeps it conservative.
 */

import rawWords from './data/common-words.txt?raw';

// ─── Word list ────────────────────────────────────────────────────────────────

export const BASE_COMMON_WORDS: ReadonlySet<string> = new Set(
  rawWords
    .split(/\r?\n/)
    .map((w) => w.trim())
    .filter(Boolean),
);

// ─── Word-form matching ───────────────────────────────────────────────────────

/** Shortest base a suffix rule may produce ("bed" must not become "b"). */
const MIN_BASE_LENGTH = 2;

/** [suffix, replacement] pairs, e.g. "cities" → "city", "making" → "make". */
const SUFFIX_RULES: ReadonlyArray<readonly [string, string]> = [
  ['ies', 'y'],
  ['ied', 'y'],
  ['ily', 'y'],
  ['es', ''],
  ['s', ''],
  ['ed', ''],
  ['ed', 'e'],
  ['ing', ''],
  ['ing', 'e'],
  ['ly', ''],
];

/** Suffixes that double a final consonant: "running" → "runn" → "run". */
const DOUBLING_SUFFIXES = new Set(['ed', 'ing']);

const DOUBLED_CONSONANT = /([b-df-hj-np-tv-z])\1$/;

/**
 * Returns `word` (lower-cased) followed by every base form the suffix rules
 * can derive from it. Candidates are not validated; callers look them up.
 */
export function wordFormCandidates(word: string): string[] {
  const normalized = word.toLowerCase().trim();
  const candidates = [normalized];

  for (const [suffix, replacement] of SUFFIX_RULES) {
    if (!normalized.endsWith(suffix)) continue;
    const stem = normalized.slice(0, -suffix.length);
    const base = stem + replacement;
    if (base.length >= MIN_BASE_LENGTH && !candidates.includes(base)) candidates.push(base);

    if (replacement === '' && DOUBLING_SUFFIXES.has(suffix) && DOUBLED_CONSONANT.test(stem)) {
      const undoubled = stem.slice(0, -1);
      if (undoubled.length >= MIN_BASE_LENGTH && !candidates.includes(undoubled)) {
        candidates.push(undoubled);
      }
    }
  }

  return candidates;
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

/**
 * True if `word`, or a base form of it, is in the common list or in
 * `customWords` (which may itself already include the base list).
 */
export function isCommonWord(word: string, customWords: Set<string> = new Set()): boolean {
  return wordFormCandidates(word).some(
    (form) => BASE_COMMON_WORDS.has(form) || customWords.has(form),
  );
}
