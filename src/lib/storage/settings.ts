import type { UserProfile } from '../../types';

export const DEFAULT_PROFILE: UserProfile = {
  ageGroup: 'adult',
  targetGradeLevel: 'auto',
  readingPurpose: 'general',
  domainFamiliarity: 'novice',
  preferredStyle: 'plain'
};

export async function getUserProfile(): Promise<UserProfile> {
  const data = await chrome.storage.sync.get('userProfile');
  return data.userProfile || DEFAULT_PROFILE;
}

export async function saveUserProfile(profile: UserProfile): Promise<void> {
  await chrome.storage.sync.set({ userProfile: profile });
}
