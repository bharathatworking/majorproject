/**
 * Glossary exemptions for the NLI meaning check (thesis standard, stage 6C).
 *
 * The prompt asks the model to briefly explain the node's hinted difficult
 * words (lib/metrics/difficult-words.ts). A definition such as
 * "Photosynthesis means how plants make food from light." is usually not
 * entailed by the original paragraph, so a strict NLI check would mark it
 * unsupported and the retry would push the model to drop the explanation.
 *
 * Design decisions (agreed rules):
 *  1. Only a sentence that defines one of THIS node's hinted words is exempt:
 *     it starts with the word (optionally after "a", "an" or "the", then
 *     optionally a naming noun: "word", "term", "number", "name", "phrase" or
 *     "expression"; optionally quoted, optionally plural) followed by "means"
 *     or "refers to", or by
 *     "is" plus a defining word: "a", "an", "the", "a kind of", "when" or
 *     "how" ("Inflation is a rise in prices."). A plain statement such as
 *     "Inflation is rising." is not a definition. At most one exempt sentence
 *     per hinted word. The naming noun was added 2026-10-29: `The word "karu"
 *     means …` and `Karu means …` must be judged alike. A word the prompt
 *     never hinted (a common word such as "billion", not in
 *     findDifficultWords) is never exempt, however it is defined.
 *  2. A parenthetical definition of a hinted word inside a normal sentence,
 *     "photosynthesis (how plants make food)", is removed before NLI; the rest
 *     of that sentence is still checked.
 *  3. Exempt sentences skip only the entailment requirement; nli.ts still
 *     fails them on contradiction (> CONTRADICTION_MAX).
 *  4. Exemptions are capped at GLOSSARY_EXEMPTION_MAX_RATE of the node's
 *     sentences, rounded down but at least 1 for a node of 2+ sentences; a
 *     1-sentence node gets none (a lone definition can't stand in for the
 *     paragraph). Sentences past the cap are checked normally.
 *  - Pure (config is import-free), so the offline benchmark can score other
 *    systems' output (e.g. Gemini) with exactly the same rule.
 */

import { GLOSSARY_EXEMPTION_MAX_RATE } from './config';

// ─── Matching ─────────────────────────────────────────────────────────────────

/** Escapes a word for use inside a RegExp. */
function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Nouns that may name the defined word: "The word karu means …", "The number "billion" means …". */
const NAMING_NOUN = '(?:word|term|number|name|phrase|expression)';

/**
 * "<article?> <naming noun?> <quote?>word(s|es)?<quote?>,? (means | refers
 * to | is (a|an|the|when|how))\b" at the start; "is a kind of" and "is a type
 * of" are covered by "is a".
 */
function definitionPattern(word: string): RegExp {
  return new RegExp(
    `^\\s*(?:(?:a|an|the)\\s+)?(?:${NAMING_NOUN}\\s+)?["'“‘]?${escapeRegExp(word)}(?:s|es)?["'”’]?,?\\s+` +
      `(?:means|refers\\s+to|is\\s+(?:an?|the|when|how))\\b`,
    'i',
  );
}

/**
 * The hinted word that `sentence` defines, or null. When several match, the
 * first hinted word in `hintedWords` order wins.
 */
export function glossaryWordOf(sentence: string, hintedWords: readonly string[]): string | null {
  for (const word of hintedWords) {
    if (word.trim() !== '' && definitionPattern(word.trim()).test(sentence)) return word;
  }
  return null;
}

/** True when `sentence` defines one of `hintedWords` (rule 1). */
export function isGlossarySentence(sentence: string, hintedWords: readonly string[]): boolean {
  return glossaryWordOf(sentence, hintedWords) !== null;
}

/**
 * `sentence` with parenthetical definitions of hinted words removed (rule 2):
 * "Plants use photosynthesis (how plants make food) daily." becomes
 * "Plants use photosynthesis daily." Other parentheses are kept.
 */
export function stripParentheticalDefinitions(sentence: string, hintedWords: readonly string[]): string {
  let out = sentence;
  for (const word of hintedWords) {
    if (word.trim() === '') continue;
    const re = new RegExp(`\\b(${escapeRegExp(word.trim())}(?:s|es)?)\\s*\\([^()]*\\)`, 'gi');
    out = out.replace(re, '$1');
  }
  return out.replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

// ─── Selection ────────────────────────────────────────────────────────────────

/** Largest number of exempt sentences for a node of `sentenceCount` sentences (rule 4). */
export function maxExemptions(sentenceCount: number): number {
  if (sentenceCount < 2) return 0;
  return Math.max(1, Math.floor(sentenceCount * GLOSSARY_EXEMPTION_MAX_RATE));
}

/**
 * Indexes of the sentences exempt from the entailment requirement, in order:
 * glossary sentences of distinct hinted words, until the cap is reached.
 */
export function selectExemptions(sentences: readonly string[], hintedWords: readonly string[]): number[] {
  const cap = maxExemptions(sentences.length);
  const usedWords = new Set<string>();
  const exempt: number[] = [];
  for (let i = 0; i < sentences.length && exempt.length < cap; i++) {
    const word = glossaryWordOf(sentences[i], hintedWords);
    if (word === null || usedWords.has(word.toLowerCase())) continue;
    usedWords.add(word.toLowerCase());
    exempt.push(i);
  }
  return exempt;
}
