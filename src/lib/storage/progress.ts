/**
 * Weekly reading-progress tracker.
 *
 * Records the user's resolved target grade level after each simplification
 * session, aggregated by week (Monday-aligned, in the user's local time).
 * Retains 30 days of history and prunes older records on every write.
 *
 * Design decisions:
 *  - Week keys are local dates (YYYY-MM-DD of the local Monday). Keys written
 *    before this used toISOString(), which in a timezone ahead of UTC (India,
 *    UTC+5:30) gave the Sunday before. normalizeWeekStart reads a Sunday key
 *    as the Monday after it and merges records of the same week, so old and
 *    new keys count as one week.
 *  - recordSession returns the week's session count, so the run can log it.
 *  - beforeAfterOf decides whether the Progress page can show the Before vs.
 *    After card (pure, tested).
 */

import type { ClarityDocument, ReadabilityReport } from '../../types';

export interface WeeklyProgressRecord {
  /** Local date (Monday) of that week, e.g. '2026-07-28' */
  weekStart: string;
  /** Sum of resolved target grade levels across sessions that week */
  targetGradeSum: number;
  /** Number of completed simplification sessions that week */
  sessionCount: number;
}

const KEY = 'progress:weekly';

/** Typed view of the progress key in chrome.storage.local, for `get<…>()`. */
interface ProgressLocalArea {
  [KEY]?: WeeklyProgressRecord[];
}
const RETENTION_DAYS = 30;

// ─── Weeks ────────────────────────────────────────────────────────────────────

/** YYYY-MM-DD of a date in local time. */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A YYYY-MM-DD key as a local midnight. */
function parseLocalDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** The local Monday (YYYY-MM-DD) of the given date's week. */
export function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  // Shift back to Monday: Sunday (0) → -6, Monday (1) → 0, etc.
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  d.setHours(0, 0, 0, 0);
  return localDate(d);
}

/** A stored week key as a Monday: an old UTC-shifted Sunday key is the Monday after it. */
export function normalizeWeekStart(key: string): string {
  const d = parseLocalDate(key);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return getWeekStart(d);
}

function withinRetention(weekStart: string, now: Date): boolean {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  cutoff.setHours(0, 0, 0, 0);
  return parseLocalDate(weekStart) >= cutoff;
}

/** Records with normalized keys, one per week, within retention, oldest first. */
function normalizeRecords(records: readonly WeeklyProgressRecord[], now: Date): WeeklyProgressRecord[] {
  const byWeek = new Map<string, WeeklyProgressRecord>();
  for (const r of records) {
    const weekStart = normalizeWeekStart(r.weekStart);
    if (!withinRetention(weekStart, now)) continue;
    const prev = byWeek.get(weekStart);
    byWeek.set(weekStart, prev
      ? { weekStart, targetGradeSum: prev.targetGradeSum + r.targetGradeSum, sessionCount: prev.sessionCount + r.sessionCount }
      : { ...r, weekStart });
  }
  return [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Record a completed simplification session and return this week's session
 * count. Call it once after the simplified-text readability report is
 * computed.
 */
export async function recordSession(resolvedTargetGrade: number, now: Date = new Date()): Promise<number> {
  const { [KEY]: existing } = await chrome.storage.local.get<ProgressLocalArea>(KEY);
  const records = normalizeRecords(existing ?? [], now);

  const weekStart = getWeekStart(now);
  let week = records.find(r => r.weekStart === weekStart);
  if (week) {
    week.targetGradeSum += resolvedTargetGrade;
    week.sessionCount += 1;
  } else {
    week = { weekStart, targetGradeSum: resolvedTargetGrade, sessionCount: 1 };
    records.push(week);
  }

  records.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  await chrome.storage.local.set({ [KEY]: records });
  return week.sessionCount;
}

/** Returns weekly progress with computed averages, pruned to retention window. */
export async function getWeeklyProgress(now: Date = new Date()): Promise<{
  weekStart: string;
  avgTargetGrade: number;
  sessionCount: number;
}[]> {
  const { [KEY]: existing } = await chrome.storage.local.get<ProgressLocalArea>(KEY);
  return normalizeRecords(existing ?? [], now).map(r => ({
    weekStart: r.weekStart,
    avgTargetGrade: r.targetGradeSum / r.sessionCount,
    sessionCount: r.sessionCount,
  }));
}

// ─── Before vs. After ─────────────────────────────────────────────────────────

/** The Before vs. After card's reports, or null when the document has no simplified report yet. */
export function beforeAfterOf(
  doc: Pick<ClarityDocument, 'report' | 'simplifiedReport'> | null,
): { before: ReadabilityReport; after: ReadabilityReport } | null {
  if (!doc?.report || !doc.simplifiedReport) return null;
  return { before: doc.report, after: doc.simplifiedReport };
}
