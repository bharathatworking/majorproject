import { describe, it, expect } from 'vitest';
import { computeDepthTier, resolveProfile, resolveTargetGrade } from '../../src/lib/profile/resolver';
import type { UserProfile } from '../../src/types';

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    ageGroup: 'adult',
    targetGradeLevel: 'auto',
    readingPurpose: 'general',
    domainFamiliarity: 'novice',
    preferredStyle: 'plain',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveTargetGrade — age-group defaults when 'auto'
// ---------------------------------------------------------------------------
describe('resolveTargetGrade', () => {
  it.each([
    ['child', 4],
    ['teen', 8],
    ['adult', 12],
  ] as const)('auto target for %s is grade %i', (ageGroup, grade) => {
    expect(resolveTargetGrade(profile({ ageGroup }))).toBe(grade);
  });

  it('uses an explicit target grade over the age-group default', () => {
    expect(resolveTargetGrade(profile({ ageGroup: 'child', targetGradeLevel: 10 }))).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// computeDepthTier — boundaries at diff 0, 2, 5 (current − target)
// ---------------------------------------------------------------------------
describe('computeDepthTier', () => {
  it.each([
    [7, 8, 'none'],        // diff −1
    [8, 8, 'none'],        // diff 0 (boundary)
    [8.5, 8, 'light'],     // diff 0.5
    [10, 8, 'light'],      // diff 2 (boundary)
    [10.5, 8, 'moderate'], // diff 2.5
    [13, 8, 'moderate'],   // diff 5 (boundary)
    [13.5, 8, 'aggressive'], // diff 5.5
    [18, 8, 'aggressive'], // diff 10
  ] as const)('current %d, target %d → %s', (current, target, tier) => {
    expect(computeDepthTier(current, target)).toBe(tier);
  });
});

// ---------------------------------------------------------------------------
// resolveProfile — max sentence length per tier, bullets, tone
// ---------------------------------------------------------------------------
describe('resolveProfile', () => {
  it.each([
    [12, 'none', 25],
    [14, 'light', 20],
    [17, 'moderate', 16],
    [20, 'aggressive', 12],
  ] as const)('current grade %d against target 12 → %s, max %i words', (current, tier, maxLen) => {
    const spec = resolveProfile(profile(), current);
    expect(spec.targetGrade).toBe(12);
    expect(spec.depthTier).toBe(tier);
    expect(spec.maxSentenceLength).toBe(maxLen);
  });

  it('allows bullets only for the bullet-summary style', () => {
    expect(resolveProfile(profile({ preferredStyle: 'bullet-summary' }), 14).allowBullets).toBe(true);
    for (const preferredStyle of ['plain', 'eli5', 'concise'] as const) {
      expect(resolveProfile(profile({ preferredStyle }), 14).allowBullets).toBe(false);
    }
  });

  it('carries style, tone and entity preservation into the spec', () => {
    const spec = resolveProfile(profile({ preferredStyle: 'eli5' }), 14);
    expect(spec.style).toBe('eli5');
    expect(spec.tone).toMatch(/young child/);
    expect(spec.preserveEntities).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveProfile — readingPurpose and domainFamiliarity → rule flags
// ---------------------------------------------------------------------------
describe('resolveProfile reader flags', () => {
  const intermediate = { domainFamiliarity: 'intermediate' } as const;

  it.each([
    ['general', { avoidIdioms: false, oneIdeaPerSentence: false, explainTerms: false }],
    ['esl', { avoidIdioms: true, oneIdeaPerSentence: false, explainTerms: false }],
    ['dyslexia-friendly', { avoidIdioms: false, oneIdeaPerSentence: true, explainTerms: false }],
    ['expert-to-lay', { avoidIdioms: false, oneIdeaPerSentence: false, explainTerms: true }],
  ] as const)('purpose %s (intermediate reader)', (readingPurpose, flags) => {
    expect(resolveProfile(profile({ readingPurpose, ...intermediate }), 14)).toMatchObject(flags);
  });

  it.each([
    ['novice', { explainTerms: true, keepTerms: false }],
    ['intermediate', { explainTerms: false, keepTerms: false }],
    ['expert', { explainTerms: false, keepTerms: true }],
  ] as const)('familiarity %s (general purpose)', (domainFamiliarity, flags) => {
    expect(resolveProfile(profile({ domainFamiliarity }), 14)).toMatchObject(flags);
  });

  it('keeps terms for an expert reader even with the expert-to-lay purpose', () => {
    const spec = resolveProfile(profile({ readingPurpose: 'expert-to-lay', domainFamiliarity: 'expert' }), 14);
    expect(spec.keepTerms).toBe(true);
    expect(spec.explainTerms).toBe(false);
  });

  it.each(['esl', 'dyslexia-friendly'] as const)('caps sentences at 15 words for %s', readingPurpose => {
    expect(resolveProfile(profile({ readingPurpose }), 14).maxSentenceLength).toBe(15);  // light: 20
    expect(resolveProfile(profile({ readingPurpose }), 20).maxSentenceLength).toBe(12);  // aggressive stays shorter
  });

  it("does not cap sentences in the 'none' tier or for general readers", () => {
    expect(resolveProfile(profile({ readingPurpose: 'esl' }), 12).maxSentenceLength).toBe(25);
    expect(resolveProfile(profile({ readingPurpose: 'general' }), 14).maxSentenceLength).toBe(20);
  });
});
