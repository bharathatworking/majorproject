/**
 * Resolves a UserProfile into a concrete SimplificationSpec.
 *
 * Derives targetGradeLevel from ageGroup when set to 'auto', computes the
 * simplification depth tier, and maps profile preferences to prompt-builder
 * constraints.
 *
 * Design decisions:
 *  - readingPurpose and domainFamiliarity become boolean rule flags, so
 *    buildPrompt only has to turn each flag into one sentence of instructions.
 *  - domainFamiliarity describes the reader, so an expert reader wins over the
 *    expert-to-lay purpose: terms are kept, never explained.
 *  - ESL and dyslexia-friendly readers get a stricter sentence-length cap,
 *    except in the 'none' tier, where the prompt tells the model not to
 *    simplify at all.
 */

import type { UserProfile, SimplificationSpec } from '../../types';

// ─── Tables ───────────────────────────────────────────────────────────────────

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

/** Max words per sentence for readers who need short sentences. */
const SHORT_SENTENCE_CAP = 15;

// ─── Resolvers ────────────────────────────────────────────────────────────────

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
  const { readingPurpose, domainFamiliarity } = profile;

  // Determine max sentence length based on depth
  let maxSentenceLength = depthTier === 'aggressive' ? 12
    : depthTier === 'moderate' ? 16
    : depthTier === 'light' ? 20
    : 25;

  const needsShortSentences = readingPurpose === 'esl' || readingPurpose === 'dyslexia-friendly';
  if (needsShortSentences && depthTier !== 'none') {
    maxSentenceLength = Math.min(maxSentenceLength, SHORT_SENTENCE_CAP);
  }

  const keepTerms = domainFamiliarity === 'expert';

  return {
    targetGrade,
    depthTier,
    style: profile.preferredStyle,
    preserveEntities: true,
    maxSentenceLength,
    allowBullets: profile.preferredStyle === 'bullet-summary',
    tone: STYLE_TONES[profile.preferredStyle],
    explainTerms: !keepTerms && (readingPurpose === 'expert-to-lay' || domainFamiliarity === 'novice'),
    keepTerms,
    avoidIdioms: readingPurpose === 'esl',
    oneIdeaPerSentence: readingPurpose === 'dyslexia-friendly',
  };
}
