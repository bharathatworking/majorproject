import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getGradeTargeting, getGradeTargetingSetting, saveGradeTargetingSetting,
} from '../../src/lib/storage/settings';
import { GRADE_RETRY_ENABLED, GRADE_WORDING_ENABLED } from '../../src/lib/quality/config';
import { installChromeMock } from '../mocks/chrome';

beforeEach(() => { installChromeMock(); });
afterEach(() => { vi.unstubAllEnvs(); });

// ---------------------------------------------------------------------------
// "Match the target reading grade more closely" (sync gradeTargeting)
// ---------------------------------------------------------------------------
describe('grade targeting setting', () => {
  it('is off by default, as the PREREG decision rule requires (speed guardrail failed)', async () => {
    expect(await getGradeTargetingSetting()).toBe(false);
    expect(GRADE_WORDING_ENABLED).toBe(false);
    expect(GRADE_RETRY_ENABLED).toBe(false);
    expect(await getGradeTargeting()).toEqual({
      targeting: { wording: false, retry: false }, setting: false, devOverride: false,
    });
  });

  it('turns on both arm C parts when saved as true, and only then', async () => {
    await saveGradeTargetingSetting(true);
    expect(await getGradeTargetingSetting()).toBe(true);
    expect(await getGradeTargeting()).toEqual({
      targeting: { wording: true, retry: true }, setting: true, devOverride: false,
    });
    await chrome.storage.sync.set({ gradeTargeting: 'yes' });
    expect(await getGradeTargetingSetting()).toBe(false);
  });

  it.each([
    ['off', { wording: false, retry: false }],
    ['wording', { wording: true, retry: false }],
    ['retry', { wording: true, retry: true }],
  ] as const)('debug:gradeTargeting = %s overrides the setting in a dev build', async (value, targeting) => {
    await saveGradeTargetingSetting(true);
    await chrome.storage.local.set({ 'debug:gradeTargeting': value });
    expect(await getGradeTargeting()).toEqual({ targeting, setting: true, devOverride: true });
  });

  it('ignores debug:gradeTargeting outside a dev build', async () => {
    vi.stubEnv('DEV', false);
    await chrome.storage.local.set({ 'debug:gradeTargeting': 'retry' });
    expect(await getGradeTargeting()).toEqual({
      targeting: { wording: false, retry: false }, setting: false, devOverride: false,
    });
  });
});
