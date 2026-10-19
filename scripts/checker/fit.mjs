/**
 * npm run checker:fit — fits the combined meaning score on the 81
 * calibration items only (eval/checker/features_calib.csv) and writes
 * eval/checker/fit.json plus the eval/checker/PREREG.md draft.
 *
 * Design decisions:
 *  - Reads input only through readTrainingFile (scripts/checker/lib.ts),
 *    which refuses every path but the calibration features; this file never
 *    names the held-out set (tests/unit/checker-fit.test.ts scans it).
 *  - Two models: FULL (all 8 candidate features, NLI allowed) and LITE (the
 *    4 features that need no NLI). Each: backward elimination by CV
 *    balanced accuracy, λ by inner CV, threshold for catch ≥ 90% with the
 *    lowest false-fail, then a refit on all 81 items (lib.ts fitPipeline).
 *  - The CV numbers that are reported come from NESTED CV: the whole
 *    pipeline (selection, λ, threshold) is re-run inside each outer fold and
 *    scored on the held-out fold, so no choice saw the items it is scored
 *    on. The out-of-fold numbers of the final pipeline (whose threshold was
 *    chosen on them) are printed too, marked optimistic.
 *  - The current rule (legacyPass) is evaluated on the same items and the
 *    same outer folds as the baseline.
 *  - Frozen values are rounded to 6 decimals; the rounded values are the
 *    model (PREREG.md JSON block = config.ts).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppLoader, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const TRAINING = 'eval/checker/features_calib.csv';
const OUT_DIR = join(ROOT, 'eval', 'checker');
const round6 = x => Math.round(x * 1e6) / 1e6;
const pct = x => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const ci = m => `${pct(m.value)} [${pct(m.ci[0])}–${pct(m.ci[1])}]`;
const num = m => `${m.value.toFixed(3)} [${m.ci[0].toFixed(3)}–${m.ci[1].toFixed(3)}]`;

// ─── Main ─────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
try {
  const lib = await vite.ssrLoadModule('/scripts/checker/lib.ts');
  const checker = await vite.ssrLoadModule('/src/lib/quality/checker.ts');
  const rows = lib.parsePlainCsv(await lib.readTrainingFile(ROOT, TRAINING, path => readFile(path, 'utf8')));
  const items = rows.map(r => ({
    id: r.id,
    group: r.group,
    y: r.label === 'faithful' ? 1 : 0,
    x: Object.fromEntries(checker.FEATURES.map(f => [f, Number(r[f])])),
  }));
  const legacy = rows.map(r => r.legacyPass === '1');
  const y = items.map(i => i.y);
  const groups = items.map(i => i.group);
  const nF = y.filter(v => v === 1).length;
  console.log(`[Clarity] Fit on ${items.length} calibration items (${nF} faithful / ${items.length - nF} unfaithful, ${new Set(groups).size} paragraphs)`);
  if (items.length !== 81) console.log(`[Clarity] NOTE: expected 81 items, found ${items.length}`);

  const folds = lib.stratifiedGroupKFold(items, lib.FOLDS, lib.SEED);
  const fit = (name, start) => {
    const final = lib.fitPipeline(items, start, lib.SEED);
    const nested = lib.nestedCv(items, start, lib.SEED);
    const thr = final.threshold.threshold;
    return {
      name,
      start,
      final,
      nested,
      cv: lib.evaluate(nested.passes, nested.probs, y, groups),
      apparent: lib.evaluate(final.oof.map(p => p >= thr), final.oof, y, groups),
      frozen: {
        id: name.toLowerCase(),
        features: final.model.features,
        means: final.model.means.map(round6),
        stds: final.model.stds.map(round6),
        weights: final.model.weights.map(round6),
        bias: round6(final.model.bias),
        threshold: round6(thr),
      },
    };
  };
  const models = [fit('FULL', checker.FEATURES), fit('LITE', checker.LITE_FEATURES)];
  const current = lib.evaluate(legacy, legacy.map(p => (p ? 1 : 0)), y, groups);

  // ── Console report
  for (const m of models) {
    console.log(`\n${m.name}: elimination path (OOF balanced accuracy at p = 0.5)`);
    for (const s of m.final.selection.path) console.log(`  ${s.features.length} ${pct(s.bacc).padStart(6)}  ${s.features.join(', ')}${s.removed ? `  (dropped ${s.removed})` : ''}`);
    const f = m.frozen;
    console.log(`  chosen: ${f.features.join(', ')}; λ ${m.final.model.lambda}; threshold ${f.threshold}${m.final.threshold.reached ? '' : ' (catch ≥ 90% NOT reachable: max balanced accuracy)'}`);
    console.log(`  weights ${f.weights.join(', ')}; bias ${f.bias}`);
    console.log(`  nested CV: BAcc ${ci(m.cv.bacc)}, catch ${ci(m.cv.catchRate)}, false-fail ${ci(m.cv.falseFail)}, AUC ${num(m.cv.auc)}`);
    console.log(`  outer folds chose: ${m.nested.folds.map(fo => `[${fo.features.join('+')} λ${fo.lambda} t${fo.threshold.toFixed(3)}]`).join(' ')}`);
  }
  console.log(`\nCURRENT rule: BAcc ${ci(current.bacc)}, catch ${ci(current.catchRate)}, false-fail ${ci(current.falseFail)}, AUC (0/1 verdict) ${num(current.auc)}`);

  // Per outer fold: current rule vs nested FULL and LITE
  const perFold = folds.map((fold, k) => {
    const sub = xs => fold.map(i => xs[i]);
    return {
      fold: k + 1,
      n: fold.length,
      current: lib.rates(sub(legacy), sub(y)),
      full: lib.rates(sub(models[0].nested.passes), sub(y)),
      lite: lib.rates(sub(models[1].nested.passes), sub(y)),
    };
  });

  await writeFile(join(OUT_DIR, 'fit.json'), JSON.stringify({
    at: new Date().toISOString(),
    items: items.length,
    faithful: nF,
    seed: lib.SEED,
    folds,
    current,
    perFold,
    models: models.map(m => ({
      name: m.name, frozen: m.frozen, lambda: m.final.model.lambda, thresholdReached: m.final.threshold.reached,
      path: m.final.selection.path, cv: m.cv, apparentOof: m.apparent, outerFolds: m.nested.folds,
    })),
  }, null, 2) + '\n');

  // ── PREREG.md draft
  const row = (label, e, aucNote = '') =>
    `| ${label} | ${ci(e.bacc)} | ${ci(e.catchRate)} (${e.rates.caught}/${e.rates.nUnfaithful}) | ${ci(e.falseFail)} (${e.rates.falseFails}/${e.rates.nFaithful}) | ${num(e.auc)}${aucNote} |`;
  const coefTable = m => [
    `| Feature | NLI | Mean | Std | Weight |`,
    '|---|---|---|---|---|',
    ...m.frozen.features.map((f, j) => `| \`${f}\` | ${checker.NLI_FEATURES.has(f) ? 'yes' : 'no'} | ${m.frozen.means[j]} | ${m.frozen.stds[j]} | ${m.frozen.weights[j]} |`),
    `| (bias) | | | | ${m.frozen.bias} |`,
  ].join('\n');
  const lines = [
    '# Combined meaning score: pre-registration',
    '',
    `Written by \`npm run checker:fit\` on ${new Date().toISOString().slice(0, 10)}, before the held-out set was scored. **Tested once, no re-tuning on the test set.**`,
    '',
    '## What is frozen',
    '',
    'One logistic regression replaces the hand-tuned AND of thresholds in `assessMeaning`:',
    '',
    '```text',
    'z_j   = (x_j − mean_j) / std_j            (training means and stds below)',
    'score = sigmoid(Σ weight_j · z_j + bias)   (probability the meaning was kept)',
    'pass  = score ≥ threshold',
    '```',
    '',
    'FULL is used when the NLI model scored the version; LITE (no NLI feature) in Lite quality mode or when NLI is unavailable. A missing non-NLI feature is scored at its training mean (z = 0).',
    '',
    ...models.flatMap(m => [
      `### ${m.name}`,
      '',
      coefTable(m),
      '',
      `Threshold **${m.frozen.threshold}**, λ = ${m.final.model.lambda}. ${m.final.threshold.reached
        ? 'Chosen on the out-of-fold probabilities as the cut with catch ≥ 90% and the lowest false-fail.'
        : '**No cut reached catch ≥ 90%** on the out-of-fold probabilities, so the cut with the best balanced accuracy was taken.'}`,
      '',
    ]),
    ...(models[0].frozen.features.includes('mainClaim') ? [] : [
      '`mainClaim` was not selected, so the app does not compute it: the score adds no NLI pairs to a paragraph, only the logistic regression (microseconds).',
      '',
    ]),
    '## Why these features (backward elimination on the 81 items)',
    '',
    'Out-of-fold balanced accuracy at p = 0.5 after each step (5-fold, λ by inner CV). The pick is the smallest subset of ≤ 6 features within 1 point of the best subset of ≤ 6.',
    '',
    ...models.flatMap(m => [
      `**${m.name}**`,
      '',
      '| Features | Dropped | OOF balanced accuracy |',
      '|---|---|---|',
      ...m.final.selection.path.map(s => `| ${s.features.join(', ')} | ${s.removed ?? '—'} | ${pct(s.bacc)}${s.features.join() === m.frozen.features.join() ? ' ← chosen' : ''} |`),
      '',
    ]),
    `The outer folds of the nested CV chose different subsets (FULL: ${models[0].nested.folds.map(f => f.features.join('+')).join('; ')}), so the selection is unstable at this sample size.`,
    '',
    '## Candidate features',
    '',
    '| Feature | Definition | Needs NLI |',
    '|---|---|---|',
    '| `sbert` | all-minilm cosine of original and plain simplified text | no |',
    '| `entity` | share of the original\'s entities kept (value-based numbers and dates) | no |',
    '| `nliMin` | lowest entailment over the non-exempt simplified sentences (SummaC premises, top-3, glossary exemptions) | yes |',
    '| `nliMean` | mean entailment over the same sentences | yes |',
    '| `contra` | highest contradiction over all simplified sentences | yes |',
    '| `mainClaim` | entailment of the original\'s main-claim sentence by the simplified text (reverse direction) | yes |',
    '| `numbers` | share of the main claim\'s numbers, dates and time zones kept (1 if none) | no |',
    '| `lenRatio` | simplified words / original words | no |',
    '',
    '## Method (calibration set only)',
    '',
    `- Data: the ${items.length} calibration items (${nF} faithful / ${items.length - nF} unfaithful; real outputs that are near copies excluded), ${new Set(groups).size} paragraphs.`,
    '- 5-fold CV, stratified and grouped by paragraph (a real output and its injected copy share a fold), seed 42.',
    '- Logistic regression minimising (1/Σc)·Σ c_i·logloss_i + (λ/2)·‖w‖² (Newton\'s method; the intercept is not penalised), λ from {0.01, 0.1, 1} by inner CV (ties → larger λ), balanced class weights c = n / (2·n_class), features standardised with the training fold\'s mean and std. With λ = 1 on the mean loss the weights are strongly shrunk, so scores stay near 0.5; only their order and the threshold matter.',
    '- Feature selection: backward elimination by out-of-fold balanced accuracy at p = 0.5, down to ≤ 6 features, preferring fewer when within 1 point.',
    '- Threshold: catch (recall on unfaithful) ≥ 90% with the lowest false-fail; if unreachable, maximum balanced accuracy.',
    '- CV estimates are **nested**: selection, λ and threshold are re-chosen inside every outer fold. 95% CIs: cluster bootstrap over paragraphs, 2000 resamples, seed 42.',
    '',
    '## Cross-validated results (nested, 81 calibration items)',
    '',
    '| Model | Balanced accuracy | Catch | False-fail | AUC |',
    '|---|---|---|---|---|',
    ...models.map(m => row(`${m.name} (${m.frozen.features.join(', ')})`, m.cv)),
    row('Current rule (SBERT ≥ 0.87 AND entities AND NLI rule A)', current, ' (0/1 verdict)'),
    '',
    'Per outer fold (false-fail / catch):',
    '',
    '| Fold | n | Current rule | FULL | LITE |',
    '|---|---|---|---|---|',
    ...perFold.map(p => `| ${p.fold} | ${p.n} | ${pct(p.current.falseFail)} / ${pct(p.current.catchRate)} | ${pct(p.full.falseFail)} / ${pct(p.full.catchRate)} | ${pct(p.lite.falseFail)} / ${pct(p.lite.catchRate)} |`),
    '',
    'For reference only (optimistic: the threshold was chosen on these same out-of-fold probabilities): ' +
      models.map(m => `${m.name} BAcc ${pct(m.apparent.bacc.value)}, catch ${pct(m.apparent.catchRate.value)}, false-fail ${pct(m.apparent.falseFail.value)}`).join('; ') + '.',
    '',
    `**Reading.** On the calibration set the combined score is ${models[0].cv.bacc.value > current.bacc.value ? 'above' : 'not better than'} the current rule in nested-CV balanced accuracy ` +
      `(FULL ${pct(models[0].cv.bacc.value)} vs ${pct(current.bacc.value)}; the intervals overlap). Its AUC (${models[0].cv.auc.value.toFixed(3)}) shows some ranking signal, ` +
      'but at catch ≥ 90% most faithful outputs still fail: no tested feature separates faithful from unfaithful paragraphs well at this sample size. ' +
      'The held-out test below is therefore expected to miss the false-fail target; it is run anyway, once, as pre-registered.',
    '',
    '## Held-out test plan (fixed now)',
    '',
    '- Test set: the blind-labelled outputs of the base-model bake-off (3 models × 40 paragraphs, GPU outputs, near copies excluded: expected 119 items, about 85 faithful / 34 unfaithful). Never used for fitting, selection or the threshold.',
    '- Features are extracted by the same script and app code as the calibration set; FULL is scored with the frozen values above.',
    '- **Targets:** catch ≥ 90% AND false-fail ≤ 30%. **Headline metric:** balanced accuracy with a 95% CI (cluster bootstrap over paragraphs, 2000 resamples, seed 42).',
    '- Also reported: confusion matrix, AUC, a per-model breakdown, LITE on the same items, the current rule vs the score on the same items (exact McNemar on correct/incorrect), and the extra NLI latency per paragraph.',
    '- **Tested once, no re-tuning on the test set.** If the targets are missed, that is the result.',
    '',
    '## Frozen values (machine-readable; config.ts must match)',
    '',
    '```json',
    JSON.stringify({ full: models[0].frozen, lite: models[1].frozen }, null, 2),
    '```',
    '',
  ];
  await writeFile(join(OUT_DIR, 'PREREG.md'), lines.join('\n'));
  console.log(`\n[Clarity] fit.json and PREREG.md written to ${OUT_DIR}`);
} catch (err) {
  console.error(`[Clarity] ${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
