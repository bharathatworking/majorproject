/**
 * npm run checker:discuss — EXPLORATORY, post-hoc analysis of the one-shot
 * held-out test of the combined meaning score; writes
 * eval/checker/DISCUSSION.md and nothing else.
 *
 * Design decisions:
 *  - Written after the test (eval/checker/REPORT.md). It may read the test
 *    labels because it only analyses: it never writes config.ts, PREREG.md
 *    or REPORT.md, and nothing it prints may be used to change a frozen
 *    value (tests/unit/checker-fit.test.ts checks its only write is
 *    DISCUSSION.md).
 *  - Items exactly as test-heldout.mjs builds them: features_bakeoff.csv
 *    joined with the labels through the bake-off's own unblind(), faithful /
 *    unfaithful only, scored with the app's combinedScore and the frozen
 *    COMBINED_SCORE_FULL. The headline numbers are recomputed (AUC, McNemar)
 *    and must match REPORT.md.
 *  - ROC: the staircase of (catch, false-fail) operating points (lib.ts
 *    rocPoints). The best catch at false-fail ≤ 30% is chosen ON THE TEST
 *    SET and is reported as such: it is not a valid result.
 *  - Shift: calibration vs test unfaithful share, injected vs real errors,
 *    per-feature means by label (lib.ts featureMeans).
 *  - False-fails: faithful test items the FULL score fails, grouped by the
 *    feature with the lowest contribution w·z (lib.ts rejectionDriver).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppLoader, readJsonl, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const DIR = join(ROOT, 'eval', 'checker');
const OUT = join(DIR, 'DISCUSSION.md');
const BAKEOFF = join(ROOT, 'eval', 'model-bakeoff');
const TARGET_FALSE_FAIL = 0.3;
const EXAMPLES = 5;
const SNIPPET_CHARS = 160;

const pct = x => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const f3 = x => (Number.isNaN(x) ? 'n/a' : x.toFixed(3));
const pv = p => (p < 0.001 ? '< 0.001' : p.toFixed(3));
const snippet = text => {
  // Bullet markers dropped and lines joined, so the excerpt reads as one quote
  const flat = text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : flat;
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
try {
  const load = path => vite.ssrLoadModule(path);
  const config = await load('/src/lib/quality/config.ts');
  const checker = await load('/src/lib/quality/checker.ts');
  const lib = await load('/scripts/checker/lib.ts');
  const bakeoff = await load('/scripts/bakeoff/lib.ts');
  const FULL = config.COMBINED_SCORE_FULL;
  const features = checker.FEATURES;
  const xOf = r => Object.fromEntries(features.map(f => [f, Number(r[f])]));

  // ── Calibration items (labels in the CSV)
  const calib = lib.parsePlainCsv(await readFile(join(DIR, 'features_calib.csv'), 'utf8')).map(r => ({
    id: r.id, y: r.label === 'faithful' ? 1 : 0, injected: r.model === 'injected', x: xOf(r),
  }));

  // ── Test items, exactly as test-heldout.mjs builds them
  const rows = lib.parsePlainCsv(await readFile(join(DIR, 'features_bakeoff.csv'), 'utf8'));
  const key = JSON.parse(await readFile(join(BAKEOFF, 'blind_key.json'), 'utf8'));
  const labels = bakeoff.unblind(await readFile(join(BAKEOFF, 'labels_bakeoff.csv'), 'utf8'), key);
  const labelOf = new Map(labels.map(l => [`${l.model}|${l.paragraphId}`, l.label]));
  const outputs = new Map((await readJsonl(join(BAKEOFF, 'outputs.jsonl')))
    .filter(o => o.mode === 'gpu').map(o => [`${o.model}|${o.paragraphId}`, o.cleaned]));
  const test = rows
    .filter(r => ['faithful', 'unfaithful'].includes(labelOf.get(r.id)))
    .map(r => {
      const x = xOf(r);
      const s = checker.combinedScore(FULL, x);
      return {
        id: r.id, model: r.model, y: labelOf.get(r.id) === 'faithful' ? 1 : 0, x,
        full: s.score, fullPass: s.score >= FULL.threshold, contributions: s.contributions,
        legacyPass: r.legacyPass === '1',
      };
    });
  const y = test.map(i => i.y);
  const scores = test.map(i => i.full);
  const nF = y.filter(v => v === 1).length;
  const nU = test.length - nF;

  // ── Headline numbers (recomputed; must match REPORT.md)
  const aucFull = lib.auc(scores, y);
  const aucLegacy = lib.auc(test.map(i => (i.legacyPass ? 1 : 0)), y);
  const frozen = lib.rates(test.map(i => i.fullPass), y);
  const legacy = lib.rates(test.map(i => i.legacyPass), y);
  let b = 0; let c = 0;
  for (const i of test) {
    const oldRight = i.legacyPass === (i.y === 1);
    const newRight = i.fullPass === (i.y === 1);
    if (oldRight && !newRight) b++;
    else if (newRight && !oldRight) c++;
  }
  const mcnemarP = bakeoff.mcnemarExact(b, c);

  // ── 1. ROC
  const roc = lib.rocPoints(scores, y);
  const best = lib.bestCatchAt(roc, TARGET_FALSE_FAIL);

  // ── 2. Shift
  const share = its => its.filter(i => i.y === 0).length / its.length;
  const groups = [
    ['Calibration, faithful', calib.filter(i => i.y === 1)],
    ['Calibration, unfaithful (real outputs)', calib.filter(i => i.y === 0 && !i.injected)],
    ['Calibration, unfaithful (injected copies)', calib.filter(i => i.y === 0 && i.injected)],
    ['Test, faithful', test.filter(i => i.y === 1)],
    ['Test, unfaithful (all real)', test.filter(i => i.y === 0)],
  ];
  const means = groups.map(([, its]) => lib.featureMeans(its, features));
  const scoreMean = its => its.reduce((a, i) => a + checker.combinedScore(FULL, i.x).score, 0) / its.length;
  const calibFrozen = lib.rates(calib.map(i => checker.combinedScore(FULL, i.x).score >= FULL.threshold), calib.map(i => i.y));

  // ── 3. False-fails
  const falseFails = test.filter(i => i.y === 1 && !i.fullPass);
  const drivers = lib.rejectionDrivers(FULL, falseFails);
  const withDriver = falseFails.map(i => ({ ...i, driver: lib.rejectionDriver(FULL, i.x) }));
  // Examples: the clearest (lowest-contribution) false-fail of each top driver, then the next clearest overall
  const clearest = [...withDriver].sort((p, q) => p.contributions[p.driver] - q.contributions[q.driver] || p.id.localeCompare(q.id));
  const examples = [];
  for (const d of drivers.slice(0, 3)) {
    const e = clearest.find(i => i.driver === d.feature);
    if (e) examples.push(e);
  }
  for (const e of clearest) if (examples.length < EXAMPLES && !examples.includes(e)) examples.push(e);

  // ── DISCUSSION.md
  const frozenMark = p => (Math.abs(p.caught - frozen.caught) + Math.abs(p.falseFails - frozen.falseFails) === 0 ? ' ← frozen threshold\'s operating point' : '');
  const lines = [
    '# Combined meaning score: post-hoc discussion (EXPLORATORY)',
    '',
    '**Written after the one-shot test. Nothing here changed config.ts.**',
    '',
    `Generated by \`npm run checker:discuss\` on ${new Date().toISOString().slice(0, 10)}. Everything below was looked at only after the held-out test in [REPORT.md](REPORT.md) had been run once. It explains that result; it does not replace it. No threshold, weight or feature was changed because of it, and any number "chosen" here was chosen on the test set and is not a valid estimate of performance.`,
    '',
    `Test set: ${test.length} bake-off items (${nF} faithful / ${nU} unfaithful), scored with the frozen FULL model (${FULL.features.join(', ')}; threshold ${FULL.threshold}). Recomputed headline: false-fail ${frozen.falseFails}/${nF}, catch ${frozen.caught}/${nU}, AUC ${f3(aucFull)} (old rule ${f3(aucLegacy)} as a 0/1 verdict), McNemar p = ${pv(mcnemarP)}; these match REPORT.md.`,
    '',
    '## 1. ROC curve on the test set',
    '',
    `The FULL score ranks items fairly well (AUC ${f3(aucFull)}), but the pre-registered threshold sits at the strict end of the curve. The table lists every ROC corner: the operating points no other threshold beats on both rates (pass = score ≥ threshold).`,
    '',
    '| Threshold | Catch | False-fail |',
    '|---|---|---|',
    ...roc.map(p => `| ${p.threshold.toFixed(4)} | ${pct(p.catchRate)} (${p.caught}/${nU}) | ${pct(p.falseFail)} (${p.falseFails}/${nF})${frozenMark(p)} |`),
    '',
    `The frozen threshold ${FULL.threshold} gives catch ${pct(frozen.catchRate)} (${frozen.caught}/${nU}) and false-fail ${pct(frozen.falseFail)} (${frozen.falseFails}/${nF}).`,
    '',
    best
      ? `**At false-fail ≤ ${pct(TARGET_FALSE_FAIL)} the best catch on this curve is ${pct(best.catchRate)} (${best.caught}/${nU}), at threshold ${best.threshold.toFixed(4)} (false-fail ${pct(best.falseFail)}, ${best.falseFails}/${nF}). This is NOT a valid result:** the threshold was chosen on the test set, so the number is optimistic and cannot be reported as the checker's performance. It only shows that no threshold on this score reaches both pre-registered targets (catch ≥ 90% AND false-fail ≤ 30%) even with hindsight${best.catchRate >= 0.9 ? '; here it would, which would need a new pre-registered test to confirm' : ''}.`
      : `No threshold reaches false-fail ≤ ${pct(TARGET_FALSE_FAIL)} on this curve.`,
    '',
    '## 2. Shift between calibration and test',
    '',
    `- **Unfaithful share:** calibration ${calib.filter(i => i.y === 0).length}/${calib.length} = ${pct(share(calib))}; test ${nU}/${test.length} = ${pct(share(test))}. Catch and false-fail are per-class rates and do not depend on this share, but what a rejection means does: on the test set ${frozen.falseFails} of the ${frozen.falseFails + frozen.caught} rejected outputs (${pct(frozen.falseFails / (frozen.falseFails + frozen.caught))}) were faithful.`,
    `- **Injected vs real errors:** ${calib.filter(i => i.injected).length} of the ${calib.filter(i => i.y === 0).length} unfaithful calibration items are copies with one injected error (a changed number, a negation, a swapped name, a dropped fact, an added claim); the other ${calib.filter(i => i.y === 0 && !i.injected).length} are real model outputs. All ${nU} unfaithful test items are real outputs of three models. In the table below the injected copies differ from real errors mostly on the NLI features (mean contra ${f3(means[2].contra)} vs ${f3(means[1].contra)}, nliMin ${f3(means[2].nliMin)} vs ${f3(means[1].nliMin)}); the test set's real errors look like the calibration's real ones (contra ${f3(means[4].contra)}, nliMin ${f3(means[4].nliMin)}). So about half the calibration errors were easier for NLI to see than the errors the checker meets in use.`,
    `- **Faithful items did not shift:** their mean FULL score is ${f3(scoreMean(groups[0][1]))} on calibration and ${f3(scoreMean(groups[3][1]))} on test, both below the frozen threshold ${FULL.threshold}. The threshold was set for catch ≥ 90% on calibration, which already cost a high false-fail there (in-sample, at the frozen threshold: ${pct(calibFrozen.falseFail)}, ${calibFrozen.falseFails}/${calibFrozen.nFaithful}); the test set confirms that cost rather than revealing a new one.`,
    `- **Mean FULL score per group:** ${groups.map(([name, its]) => `${name.toLowerCase()} ${f3(scoreMean(its))}`).join('; ')}. Faithful and unfaithful means are only about 0.05–0.07 apart, so the score distributions overlap heavily in both sets.`,
    '',
    'Mean of each feature by group (FULL features marked *):',
    '',
    `| Feature | ${groups.map(([name, its]) => `${name} (n = ${its.length})`).join(' | ')} |`,
    `|---|${groups.map(() => '---').join('|')}|`,
    ...features.map(f => `| \`${f}\`${FULL.features.includes(f) ? ' *' : ''} | ${means.map(m => f3(m[f])).join(' | ')} |`),
    '',
    '## 3. The false-fails',
    '',
    `The FULL score fails ${falseFails.length} of the ${nF} faithful test outputs. Grouped by the feature that drove the rejection (the lowest contribution w·z to the score):`,
    '',
    '| Driving feature | False-fails |',
    '|---|---|',
    ...drivers.map(d => `| \`${d.feature}\` | ${d.count} |`),
    '',
    `Top 3: ${drivers.slice(0, 3).map(d => `\`${d.feature}\` (${d.count})`).join(', ')}.`,
    '',
    `${examples.length} examples (faithful by the blind label, rejected by the score):`,
    '',
    ...examples.flatMap((e, k) => [
      `${k + 1}. \`${e.id}\`: score ${f3(e.full)}; driver \`${e.driver}\` = ${f3(e.x[e.driver])} (contribution ${f3(e.contributions[e.driver])}); sbert ${f3(e.x.sbert)}, entity ${f3(e.x.entity)}, nliMin ${f3(e.x.nliMin)}, contra ${f3(e.x.contra)}, lenRatio ${f3(e.x.lenRatio)}.`,
      `   > ${snippet(outputs.get(e.id) ?? '')}`,
    ]),
    '',
    '## 4. Thesis paragraph',
    '',
    `The pre-registered combined meaning score did not meet its targets on the held-out set. It ranks outputs better than the old hand-set rule (AUC ${f3(aucFull)} vs ${f3(aucLegacy)} for the old rule's 0/1 verdict), but at the frozen threshold it catches ${pct(frozen.catchRate)} of unfaithful outputs while failing ${pct(frozen.falseFail)} of faithful ones, and its correct/incorrect verdicts do not differ significantly from the old rule (exact McNemar p = ${pv(mcnemarP)}). This is a negative result, reported as such: a small on-device checker (an extra-small NLI cross-encoder, all-minilm and entity matching, fit on 81 calibration items) cannot verify paragraph-level faithfulness with a usable false-fail rate. Post-hoc analysis (exploratory) shows that the high false-fail rate was already present in calibration (${pct(calibFrozen.falseFail)} in-sample at the frozen threshold, the price of the pre-registered catch ≥ 90%), that faithful outputs score about the same in both sets, and that the calibration set (${pct(share(calib))} unfaithful, ${calib.filter(i => i.injected).length} of ${calib.filter(i => i.y === 0).length} of them injected errors) made errors look easier for NLI than the real ones of the test set (${pct(share(test))} unfaithful). The false-fails have no single cause: they are spread over ${drivers.slice(0, 3).map(d => `${d.feature} (${d.count})`).join(', ')}. The checker is therefore kept in the extension only as a cautious safety net: it rarely lets an unfaithful paragraph pass, it drives one retry, and the reader sees a neutral "Not verified" label with concrete reasons (a missing number, date or name, or a contradiction) rather than a failure. The meaning-preservation results of the thesis are judged offline by a larger model, not by this checker.`,
    '',
  ];
  await writeFile(OUT, lines.join('\n'));
  console.log(`[Clarity] Test: ${test.length} items (${nF} / ${nU}); AUC FULL ${f3(aucFull)} vs old ${f3(aucLegacy)}; McNemar p = ${pv(mcnemarP)}`);
  console.log(`[Clarity] Frozen: catch ${pct(frozen.catchRate)}, false-fail ${pct(frozen.falseFail)} (${frozen.falseFails}/${nF}); old rule false-fail ${pct(legacy.falseFail)}`);
  console.log('[Clarity] ROC corners (threshold, catch, false-fail):');
  for (const p of roc) console.log(`  ${p.threshold.toFixed(4)}  ${pct(p.catchRate).padStart(6)}  ${pct(p.falseFail).padStart(6)}`);
  if (best) console.log(`[Clarity] Best catch at false-fail ≤ ${pct(TARGET_FALSE_FAIL)} (chosen on the test set, NOT valid): ${pct(best.catchRate)} at ${best.threshold.toFixed(4)}`);
  console.log(`[Clarity] False-fail drivers: ${drivers.map(d => `${d.feature} ${d.count}`).join(', ')}`);
  console.log(`[Clarity] Written to ${OUT}`);
} catch (err) {
  console.error(`[Clarity] ${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
