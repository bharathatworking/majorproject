/**
 * Renders the exact prompt the app sends for one text at one target grade,
 * for the Prompt 10 training data (build-sft.mjs) and the Part C evaluation
 * (scripts/train-eval/generate.mjs). Tested for parity with buildPrompt in
 * tests/unit/train-data.test.ts.
 *
 * Design decisions:
 *  - The same steps as runSimplification (src/lib/run/simplify.ts) for one
 *    pasted paragraph: the document report is computeReadabilityReport over
 *    the text with the base common-word list (no custom words), the profile
 *    is DEFAULT_PROFILE with targetGradeLevel set to the wanted grade,
 *    resolveProfile takes the report's estimatedGradeLevel, the node is a
 *    'paragraph' with cleanForModel text and detectEntities on that text,
 *    findDifficultWords runs on the cleaned text, buildPrompt gets no
 *    rolling context and the 'standard' variant.
 *  - The only training-time difference is which difficult words are passed:
 *    'app' passes findDifficultWords as the app does (evaluation); a list
 *    passes that list; a function picks from the app's list (training's
 *    truthful hints, lib.ts truthfulHints), so NER runs once.
 *    buildPrompt's own hintedWords still drops them for tier 'none'.
 *  - This file imports src/ but changes nothing there. `gradeAware`
 *    (Prompt 11 arms B and C) passes through to buildPrompt; its default
 *    false renders the prompt arm A ran with.
 */

import { BASE_COMMON_WORDS, wordFormCandidates } from '../../src/lib/metrics/common-words';
import { computeReadabilityReport } from '../../src/lib/metrics/engine';
import { findDifficultWords } from '../../src/lib/metrics/difficult-words';
import { resolveProfile } from '../../src/lib/profile/resolver';
import { buildPrompt, hintedWords } from '../../src/lib/prompt-builder/builder';
import { cleanForModel } from '../../src/lib/segmentation/clutter';
import { detectEntities } from '../../src/lib/segmentation/ner';
import { DEFAULT_PROFILE } from '../../src/lib/storage/settings';
import type { ContentNode, Entity, ReadabilityReport, SimplificationSpec } from '../../src/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RenderedPrompt {
  system: string;
  user: string;
  spec: SimplificationSpec;
  report: ReadabilityReport;
  /** The node text the model sees (cleanForModel). */
  modelText: string;
  entities: Entity[];
  /** findDifficultWords on the model text, as the app computes it. */
  difficultWords: string[];
  /** The words the prompt actually names. */
  hinted: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The app's word set without custom words (getCommonWordSet with none saved). */
export function baseWordSet(): Set<string> {
  return new Set(BASE_COMMON_WORDS);
}

export { wordFormCandidates };

// ─── Render ───────────────────────────────────────────────────────────────────

/** Which difficult words to pass: the app's own, an exact list, or a choice made from the app's list. */
export type HintChoice = 'app' | readonly string[] | ((difficultWords: string[]) => string[]);

/** The app's {system, user} prompt for `text` at `targetGrade`. */
export function renderPrompt(
  text: string,
  targetGrade: number,
  hints: HintChoice,
  wordSet: Set<string> = baseWordSet(),
  { gradeAware = false }: { gradeAware?: boolean } = {},
): RenderedPrompt {
  const report = computeReadabilityReport(text, wordSet);
  const spec = resolveProfile({ ...DEFAULT_PROFILE, targetGradeLevel: targetGrade }, report.estimatedGradeLevel);
  const modelText = cleanForModel(text);
  const entities = detectEntities(modelText);
  const node: ContentNode = { id: 'n0', type: 'paragraph', text: modelText, entities };
  const difficultWords = findDifficultWords(modelText, entities, wordSet);
  const passed = hints === 'app' ? difficultWords
    : typeof hints === 'function' ? hints(difficultWords)
    : [...hints];
  const { system, user } = buildPrompt(node, spec, report, '', passed, 'standard', gradeAware);
  return { system, user, spec, report, modelText, entities, difficultWords, hinted: hintedWords(spec, passed) };
}
