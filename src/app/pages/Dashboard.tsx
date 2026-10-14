import React, { useEffect, useCallback, useRef } from 'react';
import type { CaptureStatus, ClarityDocument, ReadabilityReport } from '../../types';
import { computeReadabilityReport } from '../../lib/metrics/engine';
import { getCommonWordSet } from '../../lib/metrics/word-set';
import { saveDocument } from '../../lib/storage/documents';

interface DashboardProps {
  activeDoc: ClarityDocument | null;
  captureStatus: CaptureStatus | null;
  onClearCaptureStatus: () => void;
  onStartReading: () => void;
  onNewDoc: () => void;
  onDocUpdated: (doc: ClarityDocument) => void;
}

export function Dashboard({
  activeDoc, captureStatus, onClearCaptureStatus, onStartReading, onNewDoc, onDocUpdated,
}: DashboardProps) {
  const computingRef = useRef(false);

  // ── Compute report if missing ──────────────────────────────────────────────
  useEffect(() => {
    if (!activeDoc || activeDoc.report || computingRef.current) return;
    computingRef.current = true;

    // Defer with setTimeout so the "Analyzing…" state renders first.
    // We also measure how long computation takes and log it so we can decide
    // whether a Web Worker is needed (threshold: 300 ms).
    setTimeout(async () => {
      const wordSet = await getCommonWordSet();
      const t0 = performance.now();
      const report = computeReadabilityReport(activeDoc.textContent, wordSet);
      const elapsed = performance.now() - t0;
      console.log(`[Clarity] readability computed in ${elapsed.toFixed(1)} ms for ${activeDoc.textContent.length} chars`);

      const updated: ClarityDocument = { ...activeDoc, report };
      await saveDocument(updated);
      onDocUpdated(updated);
      computingRef.current = false;
    }, 0);
  }, [activeDoc?.id]);  // re-run only when the active document id changes

  const report = activeDoc?.report ?? null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="page dashboard-page">
      {/* Capture status banner */}
      {captureStatus?.state === 'extracting' && (
        <div className="banner banner-loading">
          <span className="spinner" aria-hidden="true" />
          Extracting from <strong>{captureStatus.tabTitle || 'page'}</strong>…
        </div>
      )}
      {captureStatus?.state === 'error' && (
        <div className="banner banner-error">
          <span>{captureStatus.error}</span>
          <button className="banner-dismiss" onClick={onClearCaptureStatus} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Empty state */}
      {!activeDoc && !captureStatus && (
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">✦</div>
          <h2>Welcome to Clarity</h2>
          <p>Simplify any article to your reading level.</p>
          <div className="empty-actions">
            <button className="btn-primary" onClick={onNewDoc}>📋 Paste text</button>
            <button className="btn-primary" onClick={onNewDoc}>📄 Upload PDF</button>
          </div>
          <p className="empty-hint">or click the Clarity icon on any page</p>
        </div>
      )}

      {/* Document with report */}
      {activeDoc && (
        <>
          <div className="doc-header">
            <h1 className="doc-title">{activeDoc.title}</h1>
            <div className="doc-source-line">
              {activeDoc.source === 'page' && activeDoc.sourceUrl && (
                <span>{new URL(activeDoc.sourceUrl).hostname}</span>
              )}
              {activeDoc.source === 'paste' && <span>Pasted text</span>}
              {activeDoc.source === 'pdf' && <span>{activeDoc.fileName ?? 'PDF'}</span>}
              <span className="dot" aria-hidden="true">·</span>
              <span>{new Date(activeDoc.createdAt).toLocaleDateString()}</span>
            </div>
          </div>

          {!report ? (
            <div className="analyzing-state">
              <span className="spinner" aria-hidden="true" />
              <span>Analyzing…</span>
            </div>
          ) : (
            <>
              <section aria-labelledby="gauges-heading">
                <h2 id="gauges-heading" className="section-heading">Readability</h2>
                <div className="gauges">
                  {renderGauge('Flesch Ease',    report.fleschReadingEase)}
                  {renderGauge('Grade Level',    report.estimatedGradeLevel)}
                  {renderGauge('FKGL',           report.fleschKincaidGradeLevel)}
                  {renderGauge('Gunning Fog',    report.gunningFogIndex)}
                  {renderGauge('SMOG',           report.smogIndex)}
                  {renderGauge('Coleman-Liau',   report.colemanLiauIndex)}
                  {renderGauge('ARI',            report.automatedReadabilityIndex)}
                  {renderGauge('Dale-Chall',     report.daleChallScore)}
                </div>
              </section>

              <section aria-labelledby="stats-heading">
                <h2 id="stats-heading" className="section-heading">Text stats</h2>
                <div className="stats-grid">
                  {renderGauge('Avg sentence',      report.avgSentenceLength, ' words')}
                  {renderGauge('Complex words',      report.complexWordPercent, '%')}
                  {renderGauge('Jargon',            report.jargonDensity, '%')}
                  {renderGauge('Long sentences',    report.longSentencePercent, '%')}
                  {renderGauge('Type-token ratio',  report.typeTokenRatio)}
                </div>
              </section>

              <button className="btn-primary btn-start-reading" onClick={onStartReading}>
                {activeDoc.results.length > 0 ? 'Continue reading →' : 'Start reading →'}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

function renderGauge(label: string, value: number, unit = '') {
  return (
    <div className="gauge-item" key={label}>
      <div className="gauge-label">{label}</div>
      <div className="gauge-value">{value.toFixed(1)}{unit}</div>
    </div>
  );
}
