/**
 * npm run meaning-breakdown -- <run-report.json> — why paragraphs failed the
 * meaning check, per run of a downloaded run report.
 *
 * Design decisions:
 *  - Counts the kept version of every node whose meaningStatus is 'failed'.
 *    One paragraph can fail several checks, so the kinds don't add up to the
 *    failed count.
 *  - Format 3 and 4 reports (checked with run-log.ts parseRunReport) carry
 *    `failures` per node; format 2 reports are
 *    classified from their reason strings (failuresFromReasons), so older
 *    reports give a "before" breakdown too. Both come from the extension's own
 *    lib/quality/verdict.ts, loaded through Vite's ssrLoadModule (no copy of
 *    the logic that could drift).
 *  - Also prints each failed node's kinds and first reason, and how many
 *    entity failures named only entities the report flags as dropped.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) {
  console.error('[Clarity] usage: npm run meaning-breakdown -- <clarity-run-report.json>');
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const report = JSON.parse(await readFile(file, 'utf8'));
const { createServer } = await import(pathToFileURL(join(ROOT, 'node_modules/vite/dist/node/index.js')).href);
const vite = await createServer({
  root: ROOT, configFile: false, logLevel: 'error', appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
});

try {
  const { failureBreakdown, failuresFromReasons, formatFailureBreakdown } =
    await vite.ssrLoadModule('/src/lib/quality/verdict.ts');
  const { parseRunReport } = await vite.ssrLoadModule('/src/lib/run/run-log.ts');
  // Formats 2 and older predate failures; parseRunReport accepts 3 and 4
  if (report.format !== 'clarity-run-report/2') parseRunReport(report);

  console.log(`[Clarity] ${report.title} (${report.format}, ${report.runs.length} run(s))`);
  report.runs.forEach((run, i) => {
    const failed = run.nodes.filter(n => n.meaningStatus === 'failed');
    const kinds = failed.map(n => n.meaning?.failures ?? failuresFromReasons(n.meaning?.reasons ?? []));
    const b = run.summary.meaning.failureBreakdown ?? failureBreakdown(kinds);
    const m = run.summary.meaning;
    console.log(
      `\nRun ${i + 1} (${new Date(run.startedAt).toISOString()}, ${run.model}, quality ${run.qualityMode ?? 'n/a'}): ` +
      `passed ${m.passed}/${m.passed + m.failed}, coverage ${m.coverage === null ? 'n/a' : `${Math.round(m.coverage * 100)}%`}` +
      `, thresholds similarity ${run.meaningThresholds.similarity}, entailment ${run.meaningThresholds.entailmentMin}` +
      `${run.meaningThresholds.paragraphRule ? `, rule ${run.meaningThresholds.paragraphRule}` : ''}`,
    );
    console.log(`  Failures: ${formatFailureBreakdown(b)}`);
    failed.forEach((n, j) => {
      console.log(`  ${n.nodeId.padEnd(4)} ${kinds[j].join(' + ').padEnd(36)} ${n.meaning?.reasons?.[0] ?? ''}`);
    });
  });
} finally {
  await vite.close();
}
