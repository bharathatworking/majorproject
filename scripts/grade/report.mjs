/**
 * npm run grade:report — the Prompt 11 grade-targeting report: reads the
 * arm runs that exist, pairs them by item and writes the pre-registered
 * tables and verdict (eval/grade-targeting/PREREG.md).
 *
 *   node scripts/grade/report.mjs [--runs <dir>]   # default eval/grade-targeting/runs → eval/grade-targeting/REPORT.md
 *
 * Design decisions:
 *  - Nothing is recomputed from text: every measure was taken by run-arm.mjs
 *    with the app's code. This script only aggregates, so it can't drift
 *    from the definitions.
 *  - Differences are arm − A over the same items, with the paired bootstrap
 *    of lib.ts (10,000 resamples, seed 42, percentile 95%). Meaning pass uses
 *    the items fully checked in both arms, entities kept the items whose
 *    source has an entity.
 *  - The verdict needs complete A and C runs (every item); until then it
 *    says "pending". Pooled is primary; per kind and per target are
 *    secondary and never change it.
 *  - With --runs <dir> (e.g. runs/smoke) the report goes into <dir>/REPORT.md,
 *    so a smoke run never overwrites the real report.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createAppLoader, readJsonl, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const DIR = join(ROOT, 'eval', 'grade-targeting');
const ITEMS = join(DIR, 'items.jsonl');

const argv = process.argv.slice(2);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const runsDir = option('--runs') ? join(ROOT, option('--runs')) : join(DIR, 'runs');
const reportFile = option('--runs') ? join(runsDir, 'REPORT.md') : join(DIR, 'REPORT.md');

// ─── Formatting ───────────────────────────────────────────────────────────────

const pts = x => (Number.isNaN(x) ? '–' : (x * 100).toFixed(1));
const signedPts = x => (Number.isNaN(x) ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`);
const num = (x, d = 2) => (Number.isNaN(x) ? '–' : x.toFixed(d));
const signed = (x, d = 2) => (Number.isNaN(x) ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);

// ─── Main ─────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
try {
  const lib = await vite.ssrLoadModule('/scripts/grade/lib.ts');
  const [, ...items] = await readJsonl(ITEMS);
  const itemIds = new Set(items.map(i => i.id));

  const runs = {};
  for (const arm of lib.ARMS) {
    const file = join(runsDir, `arm-${arm}.jsonl`);
    if (!existsSync(file)) continue;
    const records = (await readJsonl(file)).filter(r => itemIds.has(r.itemId));
    runs[arm] = new Map(records.map(r => [r.itemId, r]));
  }
  if (!runs.A) throw new Error(`no arm A run in ${relative(ROOT, runsDir)}`);

  const rate = (rs, f) => lib.mean(rs.map(r => (f(r) ? 1 : 0)));
  /** Per-arm figures over its own records. */
  function summary(map) {
    const rs = [...map.values()];
    const checked = rs.filter(r => r.fullyChecked);
    const withEntities = rs.filter(r => r.entityRecall !== null);
    const withFkgl = rs.filter(r => r.fkglAfter !== null);
    return {
      n: rs.length,
      hit: rate(rs, r => r.gradeHit),
      hitSent: rate(rs.filter(r => r.kind === 'sent'), r => r.gradeHit),
      hitPara: rate(rs.filter(r => r.kind === 'para'), r => r.gradeHit),
      meaning: rate(checked, r => r.meaningPassed),
      coverage: checked.length / rs.length,
      entities: lib.mean(withEntities.map(r => r.entityRecall)),
      nearCopy: rate(rs, r => r.nearCopy),
      fkgl: lib.mean(withFkgl.map(r => r.fkglAfter)),
      gap: lib.mean(withFkgl.map(r => Math.abs(r.fkglAfter - r.target))),
      calls: lib.mean(rs.map(r => r.calls)),
      medianSeconds: lib.median(rs.map(r => r.wallSeconds)),
    };
  }

  /** Paired differences arm − A, bootstrapped. */
  function paired(arm, filter = () => true) {
    const a = runs.A;
    const x = runs[arm];
    const both = [...x.keys()].filter(id => a.has(id) && filter(a.get(id)));
    const diff = (keep, value) => lib.pairedBootstrap(
      both.filter(id => keep(a.get(id)) && keep(x.get(id))).map(id => value(x.get(id)) - value(a.get(id))),
    );
    return {
      n: both.length,
      hit: diff(() => true, r => (r.gradeHit ? 1 : 0)),
      meaning: diff(r => r.fullyChecked, r => (r.meaningPassed ? 1 : 0)),
      entities: diff(r => r.entityRecall !== null, r => r.entityRecall),
      nearCopy: diff(() => true, r => (r.nearCopy ? 1 : 0)),
      gap: diff(r => r.fkglAfter !== null, r => Math.abs(r.fkglAfter - r.target)),
    };
  }

  const arms = lib.ARMS.filter(a => runs[a]);
  const sums = Object.fromEntries(arms.map(a => [a, summary(runs[a])]));
  const lines = [
    '# Grade-targeting evaluation: report (Prompt 11)',
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run grade:report\` from \`${relative(ROOT, runsDir).replace(/\\/g, '/')}\`, following \`eval/grade-targeting/PREREG.md\`. Items: \`eval/grade-targeting/items.jsonl\` (${items.length}).`,
    '',
  ];

  // Verdict
  const complete = a => runs[a] && runs[a].size === items.length;
  lines.push('## Verdict', '');
  if (complete('A') && complete('C')) {
    const p = paired('C');
    const v = lib.evaluateCriteria({
      hitDiff: p.hit, meaningDiff: p.meaning, entityDiff: p.entities,
      nearCopyRateC: sums.C.nearCopy, medianSecondsA: sums.A.medianSeconds, medianSecondsC: sums.C.medianSeconds,
    });
    const verdict = v.adopt
      ? '**ADOPT**: the primary criterion and every guardrail hold; the retry loop may be enabled by default.'
      : v.primaryMet
        ? '**NOT ADOPTED**: the primary criterion holds but a guardrail failed; the retry loop stays off by default.'
        : '**NEGATIVE RESULT**: the primary criterion failed; the retry loop is not enabled by default.';
    lines.push(verdict, '', '| Pre-registered criterion (C vs A, pooled) | Result | Met |', '|---|---|---|');
    for (const c of v.criteria) {
      const value = c.id === 'primary'
        ? `${signedPts(c.value)} pts [${signedPts(p.hit.lo)}, ${signedPts(p.hit.hi)}]`
        : c.id === 'nearCopy' ? `${pts(c.value)}%`
          : c.id === 'time' ? `${signed(c.value * 100, 1)}% (median ${num(sums.A.medianSeconds)} → ${num(sums.C.medianSeconds)} s)`
            : `${signedPts(c.value)} pts`;
      lines.push(`| ${c.label} | ${value} | ${c.met ? 'yes' : '**no**'} |`);
    }
  } else {
    lines.push(`**Pending**: the verdict needs complete A and C runs (A ${runs.A.size}/${items.length}, C ${runs.C?.size ?? 0}/${items.length}).`);
  }
  lines.push('');

  // Per arm
  lines.push('## Per arm', '', '| Arm | n | Grade hit | Hit (sentences) | Hit (paragraphs) | Meaning pass | Fully checked | Entities kept | Near copy | Mean FKGL | Mean \\|FKGL − target\\| | Calls | Median s/node |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of arms) {
    const s = sums[a];
    lines.push(`| ${a} | ${s.n} | ${pts(s.hit)} | ${pts(s.hitSent)} | ${pts(s.hitPara)} | ${pts(s.meaning)} | ${pts(s.coverage)} | ${pts(s.entities)} | ${pts(s.nearCopy)} | ${num(s.fkgl)} | ${num(s.gap)} | ${num(s.calls)} | ${num(s.medianSeconds)} |`);
  }
  lines.push('', 'Rates are percentages. Meaning pass is over fully checked items; entities kept over items whose source has an entity.', '');

  // Paired differences
  const diffRow = (label, b, unit = 'pts') => `| ${label} | ${b.n} | ${unit === 'pts' ? signedPts(b.mean) : signed(b.mean)} | [${unit === 'pts' ? signedPts(b.lo) : signed(b.lo)}, ${unit === 'pts' ? signedPts(b.hi) : signed(b.hi)}] |`;
  for (const arm of arms.filter(a => a !== 'A')) {
    const p = paired(arm);
    lines.push(`## ${arm} − A (paired)`, '', '| Measure | n | Difference | 95% CI |', '|---|---|---|---|',
      diffRow('Grade hit (pooled, primary)', p.hit),
      diffRow('Grade hit, sentences', paired(arm, r => r.kind === 'sent').hit),
      diffRow('Grade hit, paragraphs', paired(arm, r => r.kind === 'para').hit),
      ...lib.GRADE_TARGETS.map(t => diffRow(`Grade hit, target ${t}`, paired(arm, r => r.target === t).hit)),
      diffRow('Meaning pass', p.meaning),
      diffRow('Entities kept', p.entities),
      diffRow('Near copy', p.nearCopy),
      diffRow('\\|FKGL − target\\| (grades)', p.gap, 'grades'),
      '');
  }

  // Per target, per arm
  lines.push('## Grade hit by target (secondary)', '', `| Target | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`);
  for (const t of lib.GRADE_TARGETS) {
    lines.push(`| ${t} | ${arms.map(a => pts(rate([...runs[a].values()].filter(r => r.target === t), r => r.gradeHit))).join(' | ')} |`);
  }
  lines.push('', `Differences are arm − A over the same items; paired bootstrap, ${lib.BOOTSTRAP_RESAMPLES} resamples, seed ${lib.GRADE_SEED}, percentile ${lib.CI_LEVEL * 100}% interval. Pooled grade hit is the primary measure; everything else is secondary or a guardrail.`, '');

  await writeFile(reportFile, lines.join('\n'));
  console.log(`[Clarity] ${relative(ROOT, reportFile)}: arms ${arms.join(', ')}; A grade hit ${pts(sums.A.hit)}% over ${sums.A.n}`);
} catch (err) {
  console.error(`[Clarity] ${err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
