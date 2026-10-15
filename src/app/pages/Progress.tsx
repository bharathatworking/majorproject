import React, { useState, useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
import { beforeAfterOf, getWeeklyProgress } from '../../lib/storage/progress';
import { getDocument, listDocuments } from '../../lib/storage/documents';
// similarity.ts and config.ts are import-free of compromise and Transformers.js
import { meaningOverview, passRateLabel, type MeaningOverview } from '../../lib/quality/similarity';
import {
  CONTRADICTION_MAX, ENTAILMENT_MIN, SIMILARITY_THRESHOLD, THESIS_COVERAGE_MIN,
} from '../../lib/quality/config';
import type { ClarityDocument } from '../../types';

Chart.register(...registerables);

interface ProgressProps {
  activeDoc: ClarityDocument | null;
}

export function Progress({ activeDoc }: ProgressProps) {
  const [weekly, setWeekly] = useState<{ weekStart: string; avgTargetGrade: number; sessionCount: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef  = useRef<Chart | null>(null);

  // ── Load weekly progress + live-sync via storage.onChanged ─────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const data = await getWeeklyProgress();
      if (!cancelled) { setWeekly(data); setLoading(false); }
    }
    load();

    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'progress:weekly' in changes) load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => { cancelled = true; chrome.storage.onChanged.removeListener(listener); };
  }, []);

  // ── Chart.js — rebuild whenever data changes ────────────────────────────────
  useEffect(() => {
    if (weekly.length < 2) return;

    const tid = setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      chartRef.current?.destroy();
      chartRef.current = null;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      chartRef.current = new Chart(ctx, {
        type: 'line',
        data: {
          // Week keys are local dates; read the parts, not new Date() (UTC)
          labels: weekly.map(w => {
            const [, month, day] = w.weekStart.split('-').map(Number);
            return `${month}/${day}`;
          }),
          datasets: [{
            label: 'Avg Target Grade',
            data: weekly.map(w => w.avgTargetGrade),
            borderColor: '#7c83ff',
            backgroundColor: 'rgba(124, 131, 255, 0.12)',
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: '#a78bfa',
            fill: true,
            tension: 0.3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: {
              ticks: { color: '#888', font: { size: 11 } },
              grid: { color: 'rgba(255,255,255,0.05)' },
            },
            y: {
              min: 1, max: 16,
              ticks: { color: '#888', font: { size: 11 }, stepSize: 1 },
              grid: { color: 'rgba(255,255,255,0.05)' },
              title: { display: true, text: 'Grade Level', color: '#888', font: { size: 11 } },
            },
          },
        },
      });
    }, 50);

    return () => {
      clearTimeout(tid);
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [weekly]);

  // ── Summary stats ───────────────────────────────────────────────────────────
  const totalSessions = weekly.reduce((s, w) => s + w.sessionCount, 0);
  const latest   = weekly.at(-1);
  const earliest = weekly[0];
  const gradeDelta =
    weekly.length >= 2 && latest && earliest
      ? latest.avgTargetGrade - earliest.avgTargetGrade
      : null;

  const comparison = beforeAfterOf(activeDoc);
  // Same row as the Meaning Preserved table, so the card can't disagree with it
  const meaningRows = useMeaningRows();
  const activeMeaning = activeDoc ? meaningRows.find(r => r.id === activeDoc.id) ?? null : null;

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="page progress-page">
        <div className="analyzing-state"><span className="spinner" aria-hidden="true" /> Loading…</div>
      </div>
    );
  }

  if (totalSessions === 0) {
    return (
      <div className="page progress-page">
        <h1 className="page-heading">Progress</h1>
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">↗</div>
          <h2>No progress data yet</h2>
          <p>Complete a simplification session to start tracking your reading level trend.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page progress-page">
      <h1 className="page-heading">Progress</h1>

      {/* ── Stats cards ── */}
      <div className="progress-cards">
        <div className="progress-card">
          <div className="progress-card-label">Total Sessions</div>
          <div className="progress-card-value">{totalSessions}</div>
        </div>
        <div className="progress-card">
          <div className="progress-card-label">This Week Avg Grade</div>
          <div className="progress-card-value">
            {latest ? latest.avgTargetGrade.toFixed(1) : '—'}
            {gradeDelta !== null && (
              <span className={`delta ${gradeDelta >= 0 ? 'positive' : 'negative'}`}>
                {' '}{gradeDelta >= 0 ? '▲' : '▼'}{Math.abs(gradeDelta).toFixed(1)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Trend chart ── */}
      {weekly.length >= 2 ? (
        <div className="chart-container">
          <h2 className="section-heading">Reading Level Trend</h2>
          <div className="chart-wrapper">
            <canvas ref={canvasRef} />
          </div>
        </div>
      ) : (
        <div className="trend-placeholder">
          <p>📈 Keep simplifying — at least 2 weeks of data needed for the trend chart.</p>
        </div>
      )}

      {/* ── Before → After comparison ── */}
      {comparison ? (
        <div className="comparison-card">
          <h2 className="section-heading">Last Session — Before vs. After</h2>
          <div className="comparison-grid">
            <ComparisonRow label="Grade Level"        before={comparison.before.estimatedGradeLevel} after={comparison.after.estimatedGradeLevel} />
            <ComparisonRow label="Jargon Density"     before={comparison.before.jargonDensity}        after={comparison.after.jargonDensity}        unit="%" />
            <ComparisonRow label="Avg Sentence Length" before={comparison.before.avgSentenceLength}   after={comparison.after.avgSentenceLength}    unit=" words" />
            {activeMeaning && activeMeaning.avgSimilarity !== null && (
              <div className="comparison-row meaning-row">
                <span className="comparison-label">Avg similarity</span>
                <span
                  className="comparison-after"
                  title="Mean similarity of every checked paragraph to its original, passed or not"
                >
                  {activeMeaning.avgSimilarity.toFixed(2)}
                </span>
              </div>
            )}
            {activeMeaning && (
              <div className="comparison-row meaning-row">
                <span className="comparison-label">Meaning pass rate</span>
                <span
                  className="comparison-after"
                  title="Fully checked paragraphs that kept their meaning (passed / checked)"
                >
                  {passRateLabel(activeMeaning.stats)}
                </span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className="comparison-hint">Run a simplification to see your Before vs. After comparison here.</p>
      )}

      <MeaningTable rows={meaningRows} />
    </div>
  );
}

// ─── MeaningTable ─────────────────────────────────────────────────────────────

interface DocMeaningRow extends MeaningOverview {
  id: string;
  title: string;
}

const percent = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

/**
 * Meaning numbers of every stored document that has checked paragraphs,
 * reloaded when documents change. The Last Session card and the table both
 * read these rows.
 */
function useMeaningRows(): DocMeaningRow[] {
  const [rows, setRows] = useState<DocMeaningRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const index = await listDocuments();
      const docs = await Promise.all(index.map(entry => getDocument(entry.id)));
      const next = docs
        .filter((d): d is ClarityDocument => d !== null)
        .map(d => ({ id: d.id, title: d.title, ...meaningOverview(d.results) }))
        .filter(r => r.stats.passed + r.stats.failed + r.stats.notFullyChecked > 0);
      if (!cancelled) setRows(next);
    }
    load().catch(err => console.warn('[Clarity] Meaning stats failed to load', err));

    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (Object.keys(changes).some(k => k === 'docs:index' || k.startsWith('doc:'))) {
        load().catch(err => console.warn('[Clarity] Meaning stats failed to load', err));
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => { cancelled = true; chrome.storage.onChanged.removeListener(listener); };
  }, []);

  return rows;
}

/**
 * Thesis metric per stored document: the share of fully checked paragraphs
 * whose meaning was preserved, with coverage next to it so missing checks
 * can't hide behind a high pass rate (see lib/quality/similarity.ts).
 */
function MeaningTable({ rows }: { rows: DocMeaningRow[] }) {
  if (rows.length === 0) return null;

  return (
    <div className="meaning-card">
      <h2 className="section-heading">Meaning Preserved</h2>
      <p className="meaning-card-hint">
        A paragraph passes when its similarity is at least {SIMILARITY_THRESHOLD.toFixed(2)}, every
        name, number and date is kept, and no sentence is unsupported (entailment below{' '}
        {ENTAILMENT_MIN.toFixed(2)}) or contradicted (above {CONTRADICTION_MAX.toFixed(2)}). The pass
        rate counts fully checked paragraphs only; coverage below {percent(THESIS_COVERAGE_MIN)} means
        it is not thesis-grade.
      </p>
      <table className="meaning-table">
        <thead>
          <tr>
            <th scope="col">Document</th>
            <th scope="col">Passed</th>
            <th scope="col">Coverage</th>
            <th scope="col">Avg similarity</th>
            <th scope="col" title="Passed / failed / not fully checked">P / F / N</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, title, stats, avgSimilarity }) => (
            <tr key={id}>
              <th scope="row" className="meaning-doc-title">{title}</th>
              <td className="meaning-pass-rate">{passRateLabel(stats)}</td>
              <td
                className={stats.thesisGrade ? '' : 'coverage-low'}
                title={stats.thesisGrade ? undefined : 'Not thesis-grade: too few paragraphs were fully checked'}
              >
                {percent(stats.coverage)}
              </td>
              <td>{avgSimilarity === null ? '—' : avgSimilarity.toFixed(2)}</td>
              <td>{stats.passed} / {stats.failed} / {stats.notFullyChecked}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── ComparisonRow ────────────────────────────────────────────────────────────

function ComparisonRow({
  label, before, after, unit = '',
}: { label: string; before: number; after: number; unit?: string }) {
  const delta = after - before;
  // For grade level, jargon density, and sentence length: lower = improved.
  const improved = delta < 0;
  return (
    <div className="comparison-row">
      <span className="comparison-label">{label}</span>
      <span className="comparison-before">{before.toFixed(1)}{unit}</span>
      <span className="comparison-arrow" aria-hidden="true">→</span>
      <span className="comparison-after">{after.toFixed(1)}{unit}</span>
      <span className={`comparison-delta ${improved ? 'positive' : delta > 0 ? 'negative' : ''}`}>
        {delta >= 0 ? '+' : ''}{delta.toFixed(1)}
      </span>
    </div>
  );
}
