/**
 * Meaning-check arithmetic and reporting that need no NLP library.
 *
 * Split out of semantic.ts so the Reading page (badge) and the Progress page
 * (thesis pass rate) don't pull compromise into the main chunk. Thresholds
 * live in config.ts.
 *
 * Thesis metric (meaningStats / summarizeMeaning):
 *  - Each node falls in one MeaningStatus: 'passed' or 'failed' when it was
 *    fully checked (SBERT + NLI + entities), 'not-fully-checked' when a check
 *    fell back (NLI model or embedding model missing), 'excluded' for
 *    headings, short texts and already-simple nodes.
 *  - pass rate = passed / fully checked. coverage = fully checked / eligible
 *    (eligible = fully checked + not fully checked), so a low NLI coverage
 *    can't hide behind a high pass rate. A pass rate is thesis-grade only when
 *    coverage ≥ THESIS_COVERAGE_MIN.
 *  - Average similarity is a different number (mean SBERT cosine of every
 *    checked result, passed or not). meaningOverview returns both, so the
 *    Progress card and table show them from one computation and can't
 *    disagree.
 *
 * Reader-facing badge (meaningBadge): the frozen checker fails about 70% of
 * faithful paragraphs (eval/checker/REPORT.md), so a version that does not
 * pass is shown as a neutral "Not verified", not as a warning. Chips name
 * only concrete problems the checker already found (meaningChips): a
 * dropped number, date, time zone or name, and a contradiction above
 * CONTRADICTION_MAX. Low similarity, length or an unsupported sentence get
 * no chip; they stay in the tooltip. The thesis metric (passed / failed)
 * is unchanged.
 */

import {
  COMBINED_SCORE_FULL, COMBINED_SCORE_LITE, CONTRADICTION_MAX, ENTAILMENT_MIN, SIMILARITY_THRESHOLD, THESIS_COVERAGE_MIN,
} from './config';
import type { MeaningChip, MeaningStatus, MeaningSummary, StoredMeaning, StoredResult } from '../../types';

// ─── Arithmetic ───────────────────────────────────────────────────────────────

/** Cosine similarity in [-1, 1]; 0 when either vector is all zeros. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Status ───────────────────────────────────────────────────────────────────

/** SBERT and NLI both ran (entities always run when a node is checked). */
export function isFullyChecked(m: StoredMeaning): boolean {
  return m.similarity !== undefined && m.nliChecked === true;
}

/**
 * Thesis category of a checked version; null or no `passed` (not checked, or
 * stored before the thesis standard) is 'excluded'.
 */
export function meaningStatusOf(m: StoredMeaning | null | undefined): Exclude<MeaningStatus, 'error'> {
  if (!m || m.passed === undefined) return 'excluded';
  if (!isFullyChecked(m)) return 'not-fully-checked';
  return m.passed ? 'passed' : 'failed';
}

/** Counts, pass rate and coverage of a list of statuses ('error' is not counted). */
export function summarizeMeaning(statuses: readonly MeaningStatus[]): MeaningSummary {
  const count = (s: MeaningStatus) => statuses.filter(x => x === s).length;
  const passed = count('passed');
  const failed = count('failed');
  const notFullyChecked = count('not-fully-checked');
  const fully = passed + failed;
  const eligible = fully + notFullyChecked;
  const coverage = eligible > 0 ? fully / eligible : null;
  return {
    passed,
    failed,
    notFullyChecked,
    excluded: count('excluded'),
    passRate: fully > 0 ? passed / fully : null,
    coverage,
    thesisGrade: coverage !== null && coverage >= THESIS_COVERAGE_MIN,
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

/** Meaning summary of a document's done results (skipped nodes count as excluded). */
export function meaningStats(results: readonly StoredResult[]): MeaningSummary {
  return summarizeMeaning(
    results
      .filter(r => r.status === 'done')
      .map(r => (r.skipped ? 'excluded' : meaningStatusOf(r))),
  );
}

/** Text of the Reading page's meaning badge for one result. */
export interface MeaningBadge {
  label: string;
  /** Hover text with every measured value and reason. */
  title: string;
  /** Show the warning (amber) style (only results from before the thesis standard). */
  warn: boolean;
  /** The kept version did not pass the check: neutral "Not verified" style. */
  unverified: boolean;
  /** Concrete reasons to show beside an unverified badge (meaningChips). */
  chips: MeaningChip[];
}

/** "You dropped the number 1945." → number (meaning.ts droppedEntityReason). */
const DROPPED_ENTITY = /^You dropped the (number|date|time zone|name|place|organization) /;
const CONTRADICTION_PREFIX = 'This sentence contradicts';

/** Chip label per dropped-entity noun; people, places and organizations are all names. */
const ENTITY_CHIP_LABEL: Record<string, string> = {
  number: 'missing number',
  date: 'missing date',
  'time zone': 'missing time zone',
  name: 'missing name',
  place: 'missing name',
  organization: 'missing name',
};

/**
 * Concrete reasons of a version that did not pass, as chips: one per kind of
 * dropped entity (number, date, time zone, name; same label merged, every
 * reason in the title) and one for a contradiction, only when a reason names
 * a contradicted sentence AND the highest contradiction is above
 * CONTRADICTION_MAX. Empty for a passing or unchecked version.
 */
export function meaningChips(m: StoredMeaning): MeaningChip[] {
  if (m.passed !== false) return [];
  const reasons = m.reasons ?? [];
  const byLabel = new Map<string, string[]>();
  for (const r of reasons) {
    const match = DROPPED_ENTITY.exec(r);
    if (!match) continue;
    const label = ENTITY_CHIP_LABEL[match[1]];
    byLabel.set(label, [...(byLabel.get(label) ?? []), r]);
  }
  const chips: MeaningChip[] = [...byLabel].map(([label, rs]) => ({ kind: 'entity', label, title: rs.join('\n') }));
  const contradicted = reasons.filter(r => r.startsWith(CONTRADICTION_PREFIX));
  if (contradicted.length > 0 && m.maxContradiction !== undefined && m.maxContradiction > CONTRADICTION_MAX) {
    chips.push({ kind: 'contradiction', label: 'contradiction', title: contradicted.join('\n') });
  }
  return chips;
}

/** First line of an unverified badge's tooltip. */
export const NOT_VERIFIED_NOTE =
  'Not verified: the on-device check could not confirm that every fact was kept. '
  + 'This does not mean the text is wrong. Click the paragraph to compare it with the original.';

/**
 * "meaning ✓ 0.91", "meaning ✓ 0.91 · no NLI" (NLI fell back), "meaning ✓
 * 0.91 · Lite" (Lite quality mode) or a neutral "Not verified" (with
 * meaningChips) when the kept version did not pass; results checked before
 * the thesis standard show their similarity only. Null when the result was
 * not checked.
 */
export function meaningBadge(m: StoredMeaning): MeaningBadge | null {
  const details: string[] = [];
  // Since the combined score, the parts have no cutoff of their own; older results keep theirs
  const scored = m.score !== undefined;
  if (scored) {
    const threshold = (m.scoreModel === 'lite' ? COMBINED_SCORE_LITE : COMBINED_SCORE_FULL).threshold;
    details.push(`meaning score ${(m.score as number).toFixed(2)} (needs ${threshold.toFixed(2)})`);
  }
  if (m.similarity !== undefined) details.push(`similarity ${m.similarity.toFixed(2)}${scored ? '' : ` (needs ${SIMILARITY_THRESHOLD.toFixed(2)})`}`);
  if (m.entityRecall !== undefined) details.push(`entities kept ${Math.round(m.entityRecall * 100)}%`);
  if (m.minEntailment !== undefined) details.push(`lowest entailment ${m.minEntailment.toFixed(2)}${scored ? '' : ` (needs ${ENTAILMENT_MIN.toFixed(2)})`}`);
  if (m.maxContradiction !== undefined) details.push(`highest contradiction ${m.maxContradiction.toFixed(2)}${scored ? '' : ` (max ${CONTRADICTION_MAX.toFixed(2)})`}`);
  if (m.passed !== undefined && m.nliChecked === false) {
    details.push(m.lite ? 'Lite mode: sentence check (NLI) skipped' : 'sentence check (NLI) unavailable');
  }

  if (m.passed === undefined) {
    if (m.similarity === undefined) return null;
    return {
      label: `meaning ${m.similarity.toFixed(2)}`,
      title: `Checked before the current meaning standard: ${details.join(' · ')}`,
      warn: m.similarity < SIMILARITY_THRESHOLD,
      unverified: false,
      chips: [],
    };
  }

  if (m.passed) {
    const parts = ['meaning ✓'];
    if (m.similarity !== undefined) parts.push(m.similarity.toFixed(2));
    let label = parts.join(' ');
    if (m.nliChecked === false) label += m.lite ? ' · Lite' : ' · no NLI';
    return { label, title: `Meaning preserved: ${details.join(' · ')}`, warn: false, unverified: false, chips: [] };
  }

  return {
    label: `Not verified${m.lite ? ' · Lite' : ''}`,
    title: [NOT_VERIFIED_NOTE, ...(m.reasons ?? []), details.join(' · ')].filter(Boolean).join('\n'),
    warn: false,
    unverified: true,
    chips: meaningChips(m),
  };
}

/** Mean similarity of the done results that were checked; null when none were. */
export function averageSimilarity(results: readonly StoredResult[]): number | null {
  const scores = results
    .filter(r => r.status === 'done' && r.similarity !== undefined)
    .map(r => r.similarity as number);
  if (scores.length === 0) return null;
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

/** A document's meaning numbers, as the Progress card and table show them. */
export interface MeaningOverview {
  stats: MeaningSummary;
  avgSimilarity: number | null;
}

export function meaningOverview(results: readonly StoredResult[]): MeaningOverview {
  return { stats: meaningStats(results), avgSimilarity: averageSimilarity(results) };
}

/** "42% (5/12)": passed / fully checked paragraphs; "—" when none were fully checked. */
export function passRateLabel(stats: MeaningSummary): string {
  const checked = stats.passed + stats.failed;
  if (stats.passRate === null || checked === 0) return '—';
  return `${Math.round(stats.passRate * 100)}% (${stats.passed}/${checked})`;
}
