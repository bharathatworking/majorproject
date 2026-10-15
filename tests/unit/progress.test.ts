import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  beforeAfterOf, getWeekStart, getWeeklyProgress, normalizeWeekStart, recordSession,
} from '../../src/lib/storage/progress';
import { installChromeMock, type ChromeMock } from '../mocks/chrome';
import { makeReport } from '../mocks/fixtures';

// India (UTC+5:30), where toISOString() week keys used to land on Sunday
const previousTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'Asia/Kolkata'; });
afterAll(() => { process.env.TZ = previousTz; });

let mock: ChromeMock;
beforeEach(() => { mock = installChromeMock(); });

/** A local time in Asia/Kolkata. */
const ist = (iso: string) => new Date(`${iso}+05:30`);

// ---------------------------------------------------------------------------
// Week keys
// ---------------------------------------------------------------------------
describe('getWeekStart', () => {
  it('is the local Monday for every moment of the week', () => {
    for (const t of ['2026-10-12T00:10:00', '2026-10-15T12:36:00', '2026-10-18T23:59:00']) {
      expect(getWeekStart(ist(t))).toBe('2026-10-12');
    }
    expect(getWeekStart(ist('2026-10-19T00:01:00'))).toBe('2026-10-19');
  });

  it('reads an old UTC-shifted Sunday key as the Monday after it', () => {
    expect(normalizeWeekStart('2026-10-11')).toBe('2026-10-12');
    expect(normalizeWeekStart('2026-10-12')).toBe('2026-10-12');
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
describe('recordSession', () => {
  it('counts every session of a week in one record', async () => {
    expect(await recordSession(6, ist('2026-10-13T09:00:00'))).toBe(1);
    expect(await recordSession(8, ist('2026-10-15T21:00:00'))).toBe(2);
    expect(await getWeeklyProgress(ist('2026-10-15T21:00:00'))).toEqual([
      { weekStart: '2026-10-12', avgTargetGrade: 7, sessionCount: 2 },
    ]);
  });

  it('merges a record stored under the old Sunday key into the same week', async () => {
    await chrome.storage.local.set({
      'progress:weekly': [{ weekStart: '2026-10-11', targetGradeSum: 6, sessionCount: 1 }],
    });
    expect(await recordSession(6, ist('2026-10-15T21:00:00'))).toBe(2);
    expect(mock.areas.local.data.get('progress:weekly')).toEqual([
      { weekStart: '2026-10-12', targetGradeSum: 12, sessionCount: 2 },
    ]);
  });

  it('keeps separate weeks and prunes weeks older than 30 days', async () => {
    await recordSession(5, ist('2026-09-01T10:00:00'));
    await recordSession(6, ist('2026-10-06T10:00:00'));
    await recordSession(7, ist('2026-10-15T10:00:00'));
    const weeks = await getWeeklyProgress(ist('2026-10-15T10:00:00'));
    expect(weeks.map(w => w.weekStart)).toEqual(['2026-10-05', '2026-10-12']);
  });
});

// ---------------------------------------------------------------------------
// Before vs. After card
// ---------------------------------------------------------------------------
describe('beforeAfterOf', () => {
  it('needs both reports', () => {
    expect(beforeAfterOf(null)).toBeNull();
    expect(beforeAfterOf({ report: makeReport(), simplifiedReport: null })).toBeNull();
    expect(beforeAfterOf({ report: null, simplifiedReport: makeReport() })).toBeNull();
    const after = makeReport({ estimatedGradeLevel: 6 });
    expect(beforeAfterOf({ report: makeReport(), simplifiedReport: after })).toEqual({ before: makeReport(), after });
  });
});
