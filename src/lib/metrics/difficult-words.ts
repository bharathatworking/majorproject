/**
 * Lexical hint for the hybrid engine: finds the words in a node that the
 * reader is likely to find hard, so the prompt can name them for the model.
 *
 * Design decisions:
 *  - Uses the same common-word list and suffix matching as the jargon and
 *    Dale-Chall metrics (isCommonWord), so "hard" means the same thing in the
 *    report and in the prompt. `wordSet` comes from getCommonWordSet and
 *    carries the user's custom words.
 *  - Entity words are skipped: names, places and organisations must be kept
 *    as written, never replaced.
 *  - Words of 3 letters or fewer are skipped; they are mostly abbreviations
 *    or names the list misses, not vocabulary problems.
 *  - Order of appearance, deduplicated case-insensitively, capped at 8, so the
 *    hint stays short and the result is deterministic.
 *  - Lives in metrics/ because it pulls in the bundled word list; import it
 *    only from app-page code, never the background or content scripts.
 */

import { isCommonWord } from './common-words';
import type { Entity } from '../../types';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_DIFFICULT_WORDS = 8;

const MIN_LETTERS = 4;

const WORD = /[A-Za-z]+/g;

// ─── Main export ──────────────────────────────────────────────────────────────

/** Up to 8 uncommon, non-entity words longer than 3 letters, in order of appearance. */
export function findDifficultWords(text: string, entities: Entity[], wordSet: Set<string>): string[] {
  const entityWords = new Set(
    entities.flatMap(e => (e.text.match(WORD) ?? []).map(w => w.toLowerCase())),
  );

  const seen = new Set<string>();
  const result: string[] = [];

  for (const word of text.match(WORD) ?? []) {
    const lower = word.toLowerCase();
    if (word.length < MIN_LETTERS || seen.has(lower)) continue;
    seen.add(lower);
    if (entityWords.has(lower) || isCommonWord(lower, wordSet)) continue;
    result.push(word);
    if (result.length === MAX_DIFFICULT_WORDS) break;
  }

  return result;
}
