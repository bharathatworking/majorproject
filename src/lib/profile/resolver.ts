import type { UserProfile, SimplificationSpec } from '../../types';

/**
 * Resolves a UserProfile into a concrete SimplificationSpec.
 * Derives targetGradeLevel from ageGroup when set to 'auto',
 * computes the simplification depth tier, and maps profile
 * preferences to prompt-builder constraints.
 */

const AGE_GROUP_DEFAULTS: Record<UserProfile['ageGroup'], number> = {
  child: 4,
  teen: 8,
  adult: 12,
};

const STYLE_TONES: Record<UserProfile['preferredStyle'], string> = {
  plain: 'clear, direct, and conversational',
  'bullet-summary': 'brief and structured',
  eli5: 'friendly and very simple, as if explaining to a young child',
  concise: 'terse and efficient',
};

export function resolveTargetGrade(profile: UserProfile): number {
  if (profile.targetGradeLevel === 'auto') {
    return AGE_GROUP_DEFAULTS[profile.ageGroup];
  }
  return profile.targetGradeLevel;
}

export function computeDepthTier(currentGrade: number, targetGrade: number): 'none' | 'light' | 'moderate' | 'aggressive' {
  const diff = currentGrade - targetGrade;
  if (diff <= 0) return 'none';
  if (diff <= 2) return 'light';
  if (diff <= 5) return 'moderate';
  return 'aggressive';
}

export function resolveProfile(profile: UserProfile, currentGradeLevel: number): SimplificationSpec {
  const targetGrade = resolveTargetGrade(profile);
  const depthTier = computeDepthTier(currentGradeLevel, targetGrade);

  // Determine max sentence length based on depth
  const maxSentenceLength = depthTier === 'aggressive' ? 12
    : depthTier === 'moderate' ? 16
    : depthTier === 'light' ? 20
    : 25;

  return {
    targetGrade,
    depthTier,
    style: profile.preferredStyle,
    preserveEntities: true,
    maxSentenceLength,
    allowBullets: profile.preferredStyle === 'bullet-summary',
    tone: STYLE_TONES[profile.preferredStyle],
  };
}
