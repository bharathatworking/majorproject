/**
 * Prompt variants (pipeline stage 7, prompt optimization).
 *
 * Design decisions:
 *  - Stored as data: each variant is an id, a label and a function that
 *    returns an extra instruction block for the user prompt. buildPrompt puts
 *    the block just before "TEXT TO REWRITE:", so the system prompt (shared by
 *    the whole run) and the rest of the user prompt stay the same. To add a
 *    variant, add its id to PromptVariantId (src/types) and an entry here.
 *  - 'standard' adds nothing, so its prompts are byte-identical to the
 *    prompts from before variants existed (and to cached results' prompts).
 *  - 'stepwise' asks the model to plan the splits and word swaps silently and
 *    output only the result, which helps small models that otherwise keep
 *    long sentences.
 *  - 'example-guided' shows one short before/after pair chosen to match the
 *    reader's profile (EXAMPLES, first match wins). It is labelled as an
 *    example so the model does not copy it; the run also strips a leaked
 *    leading "After:" label (stripExampleLabel).
 */

import type { PromptVariantId, SimplificationSpec } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptVariant {
  id: PromptVariantId;
  /** Short name for logs and the run report. */
  label: string;
  /** Extra user-prompt block (ending in a blank line), or '' for none. */
  instruction: (spec: SimplificationSpec) => string;
}

export interface PromptExample {
  /** Which profile this example suits. */
  matches: (spec: SimplificationSpec) => boolean;
  before: string;
  after: string;
}

// ─── Examples ─────────────────────────────────────────────────────────────────

/** Before/after pairs for 'example-guided'; the first matching entry is used. */
export const EXAMPLES: readonly PromptExample[] = [
  {
    // Expert reader: keep the terms, simplify the structure
    matches: spec => spec.keepTerms,
    before:
      'The algorithm’s asymptotic complexity, which had long been the subject of considerable ' +
      'debate among researchers, was ultimately shown to be O(n log n).',
    after:
      'Researchers argued for a long time about the algorithm’s asymptotic complexity. ' +
      'In the end, it was shown to be O(n log n).',
  },
  {
    // Novice or expert-to-lay: explain the term in brackets
    matches: spec => spec.explainTerms,
    before:
      'Photosynthesis enables autotrophic organisms to convert solar energy into chemical energy.',
    after:
      'Photosynthesis (how plants make food from sunlight) lets plants turn sunlight into ' +
      'energy they can store.',
  },
  {
    // ESL: no idioms or phrasal verbs
    matches: spec => spec.avoidIdioms,
    before: 'The council decided to put off the vote until the dust had settled.',
    after: 'The council decided to wait before the vote. They wanted things to be calm first.',
  },
  {
    // Dyslexia-friendly: one idea per sentence
    matches: spec => spec.oneIdeaPerSentence,
    before:
      'Because the bridge was old and the repairs were expensive, the city closed it and ' +
      'built a new one nearby.',
    after: 'The bridge was old. Repairs cost too much. So the city closed it. It built a new bridge nearby.',
  },
  {
    matches: () => true,
    before:
      'Notwithstanding substantial investment, the initiative failed to achieve its ' +
      'anticipated outcomes within the projected timeframe.',
    after: 'A lot of money was spent on the plan. But it did not reach its goals in time.',
  },
];

/** The example for this profile (the last entry always matches). */
export function pickExample(spec: SimplificationSpec): PromptExample {
  return EXAMPLES.find(e => e.matches(spec)) ?? EXAMPLES[EXAMPLES.length - 1];
}

// ─── Variants ─────────────────────────────────────────────────────────────────

export const PROMPT_VARIANTS: Record<PromptVariantId, PromptVariant> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    instruction: () => '',
  },
  stepwise: {
    id: 'stepwise',
    label: 'Stepwise',
    instruction: spec =>
      'Work in two steps, silently. Step 1: find every sentence longer than ' +
      `${spec.maxSentenceLength} words or with more than one idea, and decide where to split it; ` +
      'pick the hard words to replace. Step 2: write the rewrite. ' +
      'Output ONLY the result of step 2 — no steps, notes or lists of changes.\n\n',
  },
  'example-guided': {
    id: 'example-guided',
    label: 'Example-guided',
    instruction: spec => {
      const { before, after } = pickExample(spec);
      return (
        'Here is an example of the kind of rewrite wanted (do not copy it, and do not ' +
        'mention it in your answer):\n' +
        `Before: ${before}\n` +
        `After: ${after}\n\n`
      );
    },
  },
};

/** Variants "Extra quality" tries, in order, after 'standard'. */
export const EXTRA_VARIANTS: readonly PromptVariantId[] = ['stepwise', 'example-guided'];

// ─── Output cleanup ───────────────────────────────────────────────────────────

/** Drops a leading "After:" label the model copied from the example. */
export function stripExampleLabel(text: string): string {
  return text.replace(/^\s*after:\s*/i, '');
}
