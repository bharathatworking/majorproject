/**
 * Reading presets: one-click starting points shown as cards in Settings.
 *
 * Design decisions:
 *  - A preset is just a full UserProfile plus recommended display prefs. It
 *    has no behaviour of its own; resolveProfile turns the profile fields into
 *    prompt rules exactly as it does for a hand-built profile.
 *  - The chosen preset is stored on the profile (`preset`) so the card stays
 *    selected after a reload. Editing any profile field through editProfile
 *    switches it to 'custom', since the fields no longer match the card.
 *  - Every preset sets both dyslexiaFont and textSize, so switching presets
 *    never leaves the previous preset's font behind. Focus mode is left to the
 *    user.
 *  - Pure and chrome-free so it can be unit-tested in the node environment.
 */

import type { PresetId, ReadingPreset, UserProfile } from '../../types';

// ─── Presets ──────────────────────────────────────────────────────────────────

export const PRESETS: readonly ReadingPreset[] = [
  {
    id: 'beginner',
    name: 'Beginner',
    description: 'Short, plain sentences at grade 6, with terms explained.',
    profile: {
      ageGroup: 'adult',
      targetGradeLevel: 6,
      readingPurpose: 'general',
      domainFamiliarity: 'novice',
      preferredStyle: 'plain',
      preset: 'beginner',
    },
    displayPrefs: { dyslexiaFont: false, textSize: 'normal' },
  },
  {
    id: 'student',
    name: 'Student',
    description: 'Grade 8 bullet summaries that are quick to review.',
    profile: {
      ageGroup: 'teen',
      targetGradeLevel: 'auto',
      readingPurpose: 'general',
      domainFamiliarity: 'intermediate',
      preferredStyle: 'bullet-summary',
      preset: 'student',
    },
    displayPrefs: { dyslexiaFont: false, textSize: 'normal' },
  },
  {
    id: 'dyslexic-friendly',
    name: 'Dyslexic-friendly',
    description: 'One idea per sentence, short paragraphs and the OpenDyslexic font.',
    profile: {
      ageGroup: 'adult',
      targetGradeLevel: 8,
      readingPurpose: 'dyslexia-friendly',
      domainFamiliarity: 'intermediate',
      preferredStyle: 'plain',
      preset: 'dyslexic-friendly',
    },
    displayPrefs: { dyslexiaFont: true, textSize: 'large' },
  },
  {
    id: 'non-native',
    name: 'Non-native English',
    description: 'Everyday words, no idioms or phrasal verbs, short sentences.',
    profile: {
      ageGroup: 'adult',
      targetGradeLevel: 6,
      readingPurpose: 'esl',
      domainFamiliarity: 'intermediate',
      preferredStyle: 'plain',
      preset: 'non-native',
    },
    displayPrefs: { dyslexiaFont: false, textSize: 'normal' },
  },
  {
    id: 'elderly',
    name: 'Elderly reader',
    description: 'Clear grade 8 text in large type, with terms explained.',
    profile: {
      ageGroup: 'adult',
      targetGradeLevel: 8,
      readingPurpose: 'general',
      domainFamiliarity: 'novice',
      preferredStyle: 'plain',
      preset: 'elderly',
    },
    displayPrefs: { dyslexiaFont: false, textSize: 'large' },
  },
  {
    id: 'technical-learner',
    name: 'Technical learner',
    description: 'Keeps the detail of technical text and explains each term once.',
    profile: {
      ageGroup: 'adult',
      targetGradeLevel: 10,
      readingPurpose: 'expert-to-lay',
      domainFamiliarity: 'novice',
      preferredStyle: 'plain',
      preset: 'technical-learner',
    },
    displayPrefs: { dyslexiaFont: false, textSize: 'normal' },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getPreset(id: PresetId): ReadingPreset {
  const preset = PRESETS.find(p => p.id === id);
  if (!preset) throw new Error(`[Clarity] Unknown preset: ${id}`);
  return preset;
}

/** Applies a field edit; the profile no longer matches a preset, so it becomes 'custom'. */
export function editProfile(profile: UserProfile, patch: Partial<UserProfile>): UserProfile {
  return { ...profile, ...patch, preset: 'custom' };
}
