import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/lib/prompt-builder/builder';
import type { ContentNode, SimplificationSpec } from '../../src/types';
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
