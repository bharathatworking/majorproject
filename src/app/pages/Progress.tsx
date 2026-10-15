import React, { useState, useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
import { getWeeklyProgress } from '../../lib/storage/progress';
import { averageSimilarity } from '../../lib/quality/similarity';
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
          labels: weekly.map(w => {
            const d = new Date(w.weekStart);
            return `${d.getMonth() + 1}/${d.getDate()}`;
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

  const report          = activeDoc?.report ?? null;
  const simplifiedReport = activeDoc?.simplifiedReport ?? null;
  const meaningKept = activeDoc ? averageSimilarity(activeDoc.results) : null;

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
      {report && simplifiedReport ? (
        <div className="comparison-card">
          <h2 className="section-heading">Last Session — Before vs. After</h2>
          <div className="comparison-grid">
            <ComparisonRow label="Grade Level"        before={report.estimatedGradeLevel} after={simplifiedReport.estimatedGradeLevel} />
            <ComparisonRow label="Jargon Density"     before={report.jargonDensity}        after={simplifiedReport.jargonDensity}        unit="%" />
            <ComparisonRow label="Avg Sentence Length" before={report.avgSentenceLength}   after={simplifiedReport.avgSentenceLength}    unit=" words" />
            {meaningKept !== null && (
              <div className="comparison-row meaning-row">
                <span className="comparison-label">Meaning Kept</span>
                <span className="comparison-after" title="Average similarity of checked paragraphs to the original">
                  {Math.round(meaningKept * 100)}%
                </span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className="comparison-hint">Run a simplification to see your Before vs. After comparison here.</p>
      )}
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
