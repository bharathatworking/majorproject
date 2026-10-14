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
