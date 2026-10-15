import { describe, it, expect } from 'vitest';
import { buildPrompt, readerRules } from '../../src/lib/prompt-builder/builder';
import {
  EXAMPLES, EXTRA_VARIANTS, PROMPT_VARIANTS, pickExample, stripExampleLabel,
} from '../../src/lib/prompt-builder/variants';
import { resolveProfile } from '../../src/lib/profile/resolver';
import type { ContentNode, PromptVariantId, SimplificationSpec, UserProfile } from '../../src/types';
import { makeReport } from '../mocks/fixtures';

function spec(overrides: Partial<SimplificationSpec> = {}): SimplificationSpec {
  return {
    targetGrade: 6,
    depthTier: 'moderate',
    style: 'plain',
    preserveEntities: true,
    maxSentenceLength: 16,
    allowBullets: false,
    tone: 'clear, direct, and conversational',
    explainTerms: false,
    keepTerms: false,
    avoidIdioms: false,
    oneIdeaPerSentence: false,
    ...overrides,
  };
}

const node: ContentNode = {
  id: 'n0',
  type: 'paragraph',
  text: 'NASA announced the mission from Paris.',
  entities: [
    { text: 'NASA', type: 'org', start: 0, end: 4 },
    { text: 'Paris', type: 'place', start: 32, end: 37 },
  ],
};

const report = makeReport({ estimatedGradeLevel: 11.24 });

// ---------------------------------------------------------------------------
// System prompt — target grade, sentence length, bullet rule
// ---------------------------------------------------------------------------
describe('buildPrompt system prompt', () => {
  it('states the target grade and the current grade', () => {
    const { system } = buildPrompt(node, spec(), report);
    expect(system).toContain('exactly grade 6');
    expect(system).toContain('grade 11.2');
  });

  it.each([
    ['light', 'around grade 6'],
    ['aggressive', 'below grade 6'],
    ['none', 'do NOT simplify'],
  ] as const)('describes the %s tier', (depthTier, phrase) => {
    expect(buildPrompt(node, spec({ depthTier }), report).system).toContain(phrase);
  });

  it('includes the max sentence length', () => {
    expect(buildPrompt(node, spec(), report).system).toContain('Max sentence length: 16 words');
  });

  it("uses the '- ' bullet rule when bullets are allowed", () => {
    const { system } = buildPrompt(node, spec({ allowBullets: true }), report);
    expect(system).toContain("starting with '- '");
    expect(system).not.toContain('No bullets or lists');
  });

  it('forbids bullets when they are not allowed', () => {
    const { system } = buildPrompt(node, spec({ allowBullets: false }), report);
    expect(system).toContain('No bullets or lists');
    expect(system).not.toContain("starting with '- '");
  });
});

// ---------------------------------------------------------------------------
// User prompt — entities, type hint, rolling context, text
// ---------------------------------------------------------------------------
describe('buildPrompt user prompt', () => {
  it('lists the entities to preserve', () => {
    const { user } = buildPrompt(node, spec(), report);
    expect(user).toContain('Preserve the following entities EXACTLY as written: NASA, Paris');
  });

  it('omits the entity line when there are no entities', () => {
    const { user } = buildPrompt({ ...node, entities: [] }, spec(), report);
    expect(user).not.toContain('Preserve the following entities');
  });

  it('omits the entity line when preservation is off', () => {
    const { user } = buildPrompt(node, spec({ preserveEntities: false }), report);
    expect(user).not.toContain('Preserve the following entities');
  });

  it('ends with the node text', () => {
    expect(buildPrompt(node, spec(), report).user).toMatch(/TEXT TO REWRITE:\nNASA announced the mission from Paris\.$/);
  });

  it('adds rolling context only when provided', () => {
    expect(buildPrompt(node, spec(), report, 'The launch was delayed.').user)
      .toContain('[Context from previous section: "The launch was delayed."]');
    expect(buildPrompt(node, spec(), report).user).not.toContain('Context from previous section');
  });

  it('adds a type hint for headings and list items', () => {
    const heading: ContentNode = { id: 'n1', type: 'heading', level: 2, text: 'Mission goals' };
    expect(buildPrompt(heading, spec(), report).user).toContain('This is a heading (level 2)');
    const item: ContentNode = { id: 'n2', type: 'list-item', text: 'Collect samples' };
    expect(buildPrompt(item, spec(), report).user).toContain('This is one item in a list');
  });
});

// ---------------------------------------------------------------------------
// Reader rules — one per reading purpose / familiarity, from resolveProfile
// ---------------------------------------------------------------------------
describe('buildPrompt reader rules', () => {
  const profile = (overrides: Partial<UserProfile>): UserProfile => ({
    ageGroup: 'adult', targetGradeLevel: 6, readingPurpose: 'general',
    domainFamiliarity: 'intermediate', preferredStyle: 'plain', ...overrides,
  });
  const systemFor = (overrides: Partial<UserProfile>) =>
    buildPrompt(node, resolveProfile(profile(overrides), 11), report).system;

  const IDIOMS = 'Avoid idioms, phrasal verbs';
  const ONE_IDEA = 'Put only one idea in each sentence';
  const EXPLAIN = 'explain it briefly in brackets';
  const KEEP = 'Keep technical terms as they are';

  it('adds no extra rules for a general, intermediate reader', () => {
    const system = systemFor({});
    for (const phrase of [IDIOMS, ONE_IDEA, EXPLAIN, KEEP]) expect(system).not.toContain(phrase);
    expect(readerRules(spec())).toEqual([]);
  });

  it('esl: avoids idioms and phrasal verbs, prefers common words, short sentences', () => {
    const system = systemFor({ readingPurpose: 'esl' });
    expect(system).toContain(IDIOMS);
    expect(system).toContain('Prefer common, everyday words');
    expect(system).toContain('Max sentence length: 15 words');  // moderate 16, capped
    expect(system).not.toContain(ONE_IDEA);
  });

  it('dyslexia-friendly: one idea per sentence, short paragraphs', () => {
    const system = systemFor({ readingPurpose: 'dyslexia-friendly' });
    expect(system).toContain(ONE_IDEA);
    expect(system).toContain('Keep paragraphs short');
    expect(system).not.toContain(IDIOMS);
  });

  it('expert-to-lay: explains terms in brackets on first use', () => {
    const system = systemFor({ readingPurpose: 'expert-to-lay' });
    expect(system).toContain('The first time a technical term appears');
    expect(system).toContain(EXPLAIN);
  });

  it('novice: explains terms; expert: keeps terms and simplifies only structure', () => {
    expect(systemFor({ domainFamiliarity: 'novice' })).toContain(EXPLAIN);
    const expert = systemFor({ domainFamiliarity: 'expert', readingPurpose: 'expert-to-lay' });
    expect(expert).toContain(KEEP);
    expect(expert).toContain('simplify only the sentence structure');
    expect(expert).not.toContain(EXPLAIN);
  });

  it('numbers the extra rules after rule 6', () => {
    const system = buildPrompt(node, spec({ avoidIdioms: true, oneIdeaPerSentence: true, explainTerms: true }), report).system;
    expect(system).toMatch(/\n7\. Avoid idioms/);
    expect(system).toMatch(/\n8\. Put only one idea/);
    expect(system).toMatch(/\n9\. The first time a technical term/);
  });
});

// ---------------------------------------------------------------------------
// Lexical hint — difficult words from findDifficultWords
// ---------------------------------------------------------------------------
describe('buildPrompt difficult-word hint', () => {
  const HINT = 'These words may be hard for the reader. Replace them with simpler words or briefly explain them:';

  it('lists the difficult words before the text', () => {
    const { user } = buildPrompt(node, spec(), report, '', ['announced', 'mission']);
    expect(user).toContain(`${HINT} announced, mission`);
    expect(user.indexOf(HINT)).toBeLessThan(user.indexOf('TEXT TO REWRITE:'));
    expect(user).toMatch(/TEXT TO REWRITE:\nNASA announced the mission from Paris\.$/);
  });

  it('omits the hint when there are no difficult words', () => {
    expect(buildPrompt(node, spec(), report, '', []).user).not.toContain(HINT);
    expect(buildPrompt(node, spec(), report).user).not.toContain(HINT);
  });

  it('omits the hint when the reader keeps terms', () => {
    expect(buildPrompt(node, spec({ keepTerms: true }), report, '', ['mission']).user).not.toContain(HINT);
  });

  it("omits the hint in the 'none' tier", () => {
    expect(buildPrompt(node, spec({ depthTier: 'none' }), report, '', ['mission']).user).not.toContain(HINT);
  });
});

// ---------------------------------------------------------------------------
// Prompt variants (stage 7) — data in lib/prompt-builder/variants.ts
// ---------------------------------------------------------------------------
describe('buildPrompt variants', () => {
  const user = (variant: PromptVariantId, s = spec()) =>
    buildPrompt(node, s, report, 'Earlier.', ['mission'], variant).user;

  it('registers standard, stepwise and example-guided', () => {
    expect(Object.keys(PROMPT_VARIANTS).sort()).toEqual(['example-guided', 'standard', 'stepwise']);
    for (const [id, v] of Object.entries(PROMPT_VARIANTS)) expect(v.id).toBe(id);
    expect(EXTRA_VARIANTS).toEqual(['stepwise', 'example-guided']);
  });

  it("'standard' is the default and adds nothing", () => {
    expect(user('standard')).toBe(buildPrompt(node, spec(), report, 'Earlier.', ['mission']).user);
  });

  it('keeps the system prompt the same for every variant', () => {
    const system = buildPrompt(node, spec(), report).system;
    for (const id of EXTRA_VARIANTS) {
      expect(buildPrompt(node, spec(), report, '', [], id).system).toBe(system);
    }
  });

  it('puts the variant block just before the text, which stays last', () => {
    for (const id of EXTRA_VARIANTS) {
      const u = user(id);
      const block = PROMPT_VARIANTS[id].instruction(spec());
      expect(block).not.toBe('');
      expect(u.endsWith(`${block}TEXT TO REWRITE:\n${node.text}`)).toBe(true);
    }
  });

  it("'stepwise' asks for silent planning with the sentence limit and only the result", () => {
    const u = user('stepwise', spec({ maxSentenceLength: 12 }));
    expect(u).toContain('longer than 12 words');
    expect(u).toContain('Output ONLY the result of step 2');
  });

  it("'example-guided' picks the example that matches the profile", () => {
    expect(pickExample(spec({ keepTerms: true, explainTerms: true }))).toBe(EXAMPLES[0]);
    expect(pickExample(spec({ explainTerms: true }))).toBe(EXAMPLES[1]);
    expect(pickExample(spec({ avoidIdioms: true }))).toBe(EXAMPLES[2]);
    expect(pickExample(spec({ oneIdeaPerSentence: true }))).toBe(EXAMPLES[3]);
    expect(pickExample(spec())).toBe(EXAMPLES[EXAMPLES.length - 1]);

    const u = user('example-guided', spec({ explainTerms: true }));
    expect(u).toContain(`Before: ${EXAMPLES[1].before}\nAfter: ${EXAMPLES[1].after}`);
    expect(u).toContain('do not copy it');
  });

  it('strips a copied "After:" label from model output', () => {
    expect(stripExampleLabel('After: The plan failed.')).toBe('The plan failed.');
    expect(stripExampleLabel('The plan failed after: a while.')).toBe('The plan failed after: a while.');
  });
});
