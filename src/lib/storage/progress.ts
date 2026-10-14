/**
 * Weekly reading-progress tracker.
 *
 * Records the user's resolved target grade level after each simplification
 * session, aggregated by ISO week (Monday-aligned). Retains 30 days of
 * history and prunes older records on every write.
 */

export interface WeeklyProgressRecord {
  /** ISO date (Monday) of that week, e.g. '2026-07-28' */
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

/** Returns the ISO date string (YYYY-MM-DD) of the Monday of the given date's week. */
function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  // Shift back to Monday: Sunday (0) → -6, Monday (1) → 0, etc.
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function withinRetention(weekStart: string): boolean {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  cutoff.setHours(0, 0, 0, 0);
  return new Date(weekStart) >= cutoff;
}

/**
 * Record a completed simplification session.
 * Call this once after the simplified-text readability report is successfully computed.
 */
export async function recordSession(resolvedTargetGrade: number): Promise<void> {
  const { [KEY]: existing } = await chrome.storage.local.get<ProgressLocalArea>(KEY);
  let records = (existing ?? []).filter(r => withinRetention(r.weekStart));

  const weekStart = getWeekStart(new Date());
  const idx = records.findIndex(r => r.weekStart === weekStart);
  if (idx >= 0) {
    records[idx].targetGradeSum += resolvedTargetGrade;
    records[idx].sessionCount += 1;
  } else {
    records.push({ weekStart, targetGradeSum: resolvedTargetGrade, sessionCount: 1 });
  }

  records.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  await chrome.storage.local.set({ [KEY]: records });
}

/** Returns weekly progress with computed averages, pruned to retention window. */
export async function getWeeklyProgress(): Promise<{
  weekStart: string;
  avgTargetGrade: number;
  sessionCount: number;
}[]> {
  const { [KEY]: existing } = await chrome.storage.local.get<ProgressLocalArea>(KEY);
  const records = (existing ?? []).filter(r => withinRetention(r.weekStart));

  return records.map(r => ({
    weekStart: r.weekStart,
    avgTargetGrade: r.targetGradeSum / r.sessionCount,
    sessionCount: r.sessionCount,
  }));
}
