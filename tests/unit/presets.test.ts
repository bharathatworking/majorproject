import { describe, it, expect } from 'vitest';
import { PRESETS, editProfile, getPreset } from '../../src/lib/profile/presets';
import { resolveProfile } from '../../src/lib/profile/resolver';
import type { PresetId, SimplificationSpec } from '../../src/types';

type ExpectedSpec = Pick<
  SimplificationSpec,
  'targetGrade' | 'depthTier' | 'maxSentenceLength' | 'allowBullets'
  | 'explainTerms' | 'keepTerms' | 'avoidIdioms' | 'oneIdeaPerSentence'
>;

// ---------------------------------------------------------------------------
// Every preset → the spec it resolves to (source text at grade 13)
// ---------------------------------------------------------------------------
describe('preset specs', () => {
  const expected: Record<PresetId, ExpectedSpec> = {
    beginner: {
      targetGrade: 6, depthTier: 'aggressive', maxSentenceLength: 12, allowBullets: false,
      explainTerms: true, keepTerms: false, avoidIdioms: false, oneIdeaPerSentence: false,
    },
    student: {
      targetGrade: 8, depthTier: 'moderate', maxSentenceLength: 16, allowBullets: true,
      explainTerms: false, keepTerms: false, avoidIdioms: false, oneIdeaPerSentence: false,
    },
    'dyslexic-friendly': {
      targetGrade: 8, depthTier: 'moderate', maxSentenceLength: 15, allowBullets: false,
      explainTerms: false, keepTerms: false, avoidIdioms: false, oneIdeaPerSentence: true,
    },
    'non-native': {
      targetGrade: 6, depthTier: 'aggressive', maxSentenceLength: 12, allowBullets: false,
      explainTerms: false, keepTerms: false, avoidIdioms: true, oneIdeaPerSentence: false,
    },
    elderly: {
      targetGrade: 8, depthTier: 'moderate', maxSentenceLength: 16, allowBullets: false,
      explainTerms: true, keepTerms: false, avoidIdioms: false, oneIdeaPerSentence: false,
    },
    'technical-learner': {
      targetGrade: 10, depthTier: 'moderate', maxSentenceLength: 16, allowBullets: false,
      explainTerms: true, keepTerms: false, avoidIdioms: false, oneIdeaPerSentence: false,
    },
  };

  it('covers every preset', () => {
    expect(PRESETS.map(p => p.id).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(PRESETS.map(p => [p.id, p] as const))('%s resolves to the expected spec', (id, preset) => {
    expect(resolveProfile(preset.profile, 13)).toMatchObject(expected[id]);
  });
});

// ---------------------------------------------------------------------------
// Preset metadata and display prefs
// ---------------------------------------------------------------------------
describe('preset data', () => {
  it('has unique ids, and each profile records its own preset', () => {
    expect(new Set(PRESETS.map(p => p.id)).size).toBe(PRESETS.length);
    for (const preset of PRESETS) {
      expect(preset.profile.preset).toBe(preset.id);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it('turns on the dyslexia font only for Dyslexic-friendly', () => {
    for (const preset of PRESETS) {
      expect(preset.displayPrefs.dyslexiaFont).toBe(preset.id === 'dyslexic-friendly');
    }
  });

  it('uses large text for Elderly reader and Dyslexic-friendly', () => {
    expect(getPreset('elderly').displayPrefs.textSize).toBe('large');
    expect(getPreset('dyslexic-friendly').displayPrefs.textSize).toBe('large');
    expect(getPreset('beginner').displayPrefs.textSize).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// editProfile — any field edit switches to 'custom'
// ---------------------------------------------------------------------------
describe('editProfile', () => {
  it('applies the patch and marks the profile custom', () => {
    const edited = editProfile(getPreset('beginner').profile, { readingPurpose: 'esl' });
    expect(edited.readingPurpose).toBe('esl');
    expect(edited.targetGradeLevel).toBe(6);
    expect(edited.preset).toBe('custom');
  });

  it('does not mutate the preset', () => {
    editProfile(getPreset('student').profile, { ageGroup: 'adult' });
    expect(getPreset('student').profile).toMatchObject({ ageGroup: 'teen', preset: 'student' });
  });
});
