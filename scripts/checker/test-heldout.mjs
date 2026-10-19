/**
 * npm run checker:test — the ONE held-out test of the frozen combined
 * meaning score on the blind-labelled bake-off outputs; writes
 * eval/checker/REPORT.md. Pre-registered in eval/checker/PREREG.md.
 *
 * Design decisions:
 *  - Refuses to run when REPORT.md already exists (tested once), when the
 *    pre-registration commit is not in git history, or when the values in
 *    config.ts differ from PREREG.md's JSON block (nothing re-tuned).
 *  - Features: npm run checker:extract -- --set bakeoff (the same script and
 *    app code as the calibration features), run from here, then joined with
 *    the labels through the bake-off's own unblind() (blind_key.json).
 *    Items: GPU outputs that are not near copies, labelled faithful or
 *    unfaithful ('unsure' rows are left out and counted).
 *  - Scoring: the app's combinedScore with COMBINED_SCORE_FULL (NLI ran for
 *    every item) and, side by side, COMBINED_SCORE_LITE (as in Lite mode).
 *    The baseline is the old rule (legacyPass) on the same items.
 *  - Metrics as pre-registered: confusion matrix; balanced accuracy, catch,
 *    false-fail and AUC with cluster-bootstrap 95% CIs (paragraphs, 2000,
 *    seed 42); per-model breakdown; exact McNemar on correct/incorrect,
 *    old rule vs score; targets catch ≥ 90% AND false-fail ≤ 30%.
 *  - Latency: the extra work per paragraph is what the frozen FULL model
 *    needs beyond the old checks: the main-claim NLI only if it uses
 *    mainClaim, plus the logistic regression (timed here).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppLoader, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const DIR = join(ROOT, 'eval', 'checker');
const REPORT = join(DIR, 'REPORT.md');
const PREREG = join(DIR, 'PREREG.md');
const FEATURES = join(DIR, 'features_bakeoff.csv');
const BAKEOFF = join(ROOT, 'eval', 'model-bakeoff');
const PREREG_SUBJECT = 'docs(checker): pre-register combined score';
const TARGET_CATCH = 0.9;
const TARGET_FALSE_FAIL = 0.3;
const MODEL_ORDER = ['qwen2.5:3b', 'qwen3:4b-instruct-2507-q4_K_M', 'gemma4:e2b-it-qat'];

const pct = x => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const ci = m => `${pct(m.value)} [${pct(m.ci[0])}–${pct(m.ci[1])}]`;
const num = m => (Number.isNaN(m.value) ? 'n/a' : `${m.value.toFixed(3)} [${m.ci[0].toFixed(3)}–${m.ci[1].toFixed(3)}]`);
const pv = p => (p < 0.001 ? '< 0.001' : p.toFixed(3));
const percentile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : NaN;
};

// ─── Guards ───────────────────────────────────────────────────────────────────

if (existsSync(REPORT)) {
  console.error(`[Clarity] ${REPORT} exists: the held-out test has been run. It is run once; nothing is re-run or re-tuned.`);
  process.exit(1);
}
const log = execFileSync('git', ['log', '--format=%H %s'], { cwd: ROOT, encoding: 'utf8' });
const preregCommit = log.split('\n').find(l => l.endsWith(PREREG_SUBJECT));
if (!preregCommit) {
  console.error(`[Clarity] no "${PREREG_SUBJECT}" commit: pre-register before testing`);
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
try {
  const load = path => vite.ssrLoadModule(path);
  const config = await load('/src/lib/quality/config.ts');
  const checker = await load('/src/lib/quality/checker.ts');
  const lib = await load('/scripts/checker/lib.ts');
  const bakeoff = await load('/scripts/bakeoff/lib.ts');

  // The frozen values must be exactly the pre-registered ones
  const block = /```json\n([\s\S]*?)\n```/.exec((await readFile(PREREG, 'utf8')).replace(/\r\n/g, '\n'));
  if (!block) throw new Error('PREREG.md has no JSON block');
  const frozen = JSON.parse(block[1]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(frozen.full, { ...config.COMBINED_SCORE_FULL }) || !same(frozen.lite, { ...config.COMBINED_SCORE_LITE })) {
    throw new Error('config.ts COMBINED_SCORE_* differ from PREREG.md: refusing to test re-tuned values');
  }

  // Features (same extraction as the calibration set)
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'checker', 'extract-features.mjs'), '--set', 'bakeoff'], { cwd: ROOT, stdio: 'inherit' });
  const rows = lib.parsePlainCsv(await readFile(FEATURES, 'utf8'));

  // Labels, unblinded with the bake-off's own key
  const key = JSON.parse(await readFile(join(BAKEOFF, 'blind_key.json'), 'utf8'));
  const labels = bakeoff.unblind(await readFile(join(BAKEOFF, 'labels_bakeoff.csv'), 'utf8'), key);
  const labelOf = new Map(labels.map(l => [`${l.model}|${l.paragraphId}`, l.label]));
  const unsure = rows.filter(r => labelOf.get(r.id) === 'unsure').length;
  const unlabelled = rows.filter(r => !labelOf.has(r.id) || labelOf.get(r.id) === null).length;
  const items = rows
    .filter(r => ['faithful', 'unfaithful'].includes(labelOf.get(r.id)))
    .map(r => {
      const x = Object.fromEntries(checker.FEATURES.map(f => [f, Number(r[f])]));
      const full = checker.combinedScore(config.COMBINED_SCORE_FULL, x).score;
      const lite = checker.combinedScore(config.COMBINED_SCORE_LITE, x).score;
      return {
        id: r.id, model: r.model, group: r.group, y: labelOf.get(r.id) === 'faithful' ? 1 : 0, x,
        full, lite,
        fullPass: full >= config.COMBINED_SCORE_FULL.threshold,
        litePass: lite >= config.COMBINED_SCORE_LITE.threshold,
        legacyPass: r.legacyPass === '1',
        nliMs: Number(r.nliMs), mainClaimMs: Number(r.mainClaimMs), mainClaimPairs: Number(r.mainClaimPairs),
      };
    });
  const nF = items.filter(i => i.y === 1).length;
  const nU = items.length - nF;
  console.log(`[Clarity] Held-out test: ${items.length} items (${nF} faithful / ${nU} unfaithful); ${unsure} unsure and ${unlabelled} unlabelled left out`);
  for (const m of MODEL_ORDER) {
    const its = items.filter(i => i.model === m);
    console.log(`[Clarity]   ${m}: ${its.length} items (${its.filter(i => i.y === 1).length} / ${its.filter(i => i.y === 0).length})`);
  }

  const evalOf = (its, pass, score) => lib.evaluate(its.map(pass), its.map(score), its.map(i => i.y), its.map(i => i.group));
  const full = evalOf(items, i => i.fullPass, i => i.full);
  const lite = evalOf(items, i => i.litePass, i => i.lite);
  const legacy = evalOf(items, i => i.legacyPass, i => (i.legacyPass ? 1 : 0));
  const met = e => e.rates.catchRate >= TARGET_CATCH && e.rates.falseFail <= TARGET_FALSE_FAIL;

  // McNemar on correct / incorrect: b = only the old rule right, c = only the score right
  const mcnemar = pass => {
    let b = 0; let c = 0; let both = 0; let neither = 0;
    for (const i of items) {
      const oldRight = i.legacyPass === (i.y === 1);
      const newRight = pass(i) === (i.y === 1);
      if (oldRight && newRight) both++;
      else if (oldRight) b++;
      else if (newRight) c++;
      else neither++;
    }
    return { both, b, c, neither, p: bakeoff.mcnemarExact(b, c) };
  };
  const mcFull = mcnemar(i => i.fullPass);
  const mcLite = mcnemar(i => i.litePass);

  // Extra latency: logistic regression timing; main-claim NLI only if FULL uses it
  const reps = 2000;
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) for (const i of items) checker.combinedScore(config.COMBINED_SCORE_FULL, i.x);
  const lrUs = ((performance.now() - t0) / (reps * items.length)) * 1000;
  const usesMain = config.COMBINED_SCORE_FULL.features.includes('mainClaim');
  const mainMs = items.map(i => i.mainClaimMs);
  const nliMs = items.map(i => i.nliMs);

  // ── REPORT.md
  const confusion = (e, name) => [
    `**${name}**`,
    '',
    '| Label \\ verdict | passes | fails |',
    '|---|---|---|',
    `| faithful (${e.rates.nFaithful}) | ${e.rates.nFaithful - e.rates.falseFails} | ${e.rates.falseFails} |`,
    `| unfaithful (${e.rates.nUnfaithful}) | ${e.rates.nUnfaithful - e.rates.caught} | ${e.rates.caught} |`,
    '',
  ];
  const row = (name, e, aucNote = '') =>
    `| ${name} | ${ci(e.bacc)} | ${ci(e.catchRate)} (${e.rates.caught}/${e.rates.nUnfaithful}) | ${ci(e.falseFail)} (${e.rates.falseFails}/${e.rates.nFaithful}) | ${num(e.auc)}${aucNote} | ${met(e) ? 'yes' : 'no'} |`;
  const perModel = MODEL_ORDER.map(m => {
    const its = items.filter(i => i.model === m);
    return {
      m, n: its.length,
      full: evalOf(its, i => i.fullPass, i => i.full),
      legacy: evalOf(its, i => i.legacyPass, i => (i.legacyPass ? 1 : 0)),
    };
  });
  const missed = !met(full);
  const lines = [
    '# Combined meaning score: held-out test',
    '',
    `Generated once by \`npm run checker:test\` on ${new Date().toISOString().slice(0, 10)}, after the pre-registration commit \`${preregCommit.slice(0, 7)}\` ("${PREREG_SUBJECT}"). The frozen values in \`config.ts\` were checked against \`PREREG.md\` before scoring. **No frozen value was changed after this run.**`,
    '',
    `**Test set:** the blind-labelled base-model bake-off outputs (\`eval/model-bakeoff/\`), GPU outputs of 3 models × 40 bakeoff-only paragraphs, near copies excluded: **${items.length} items, ${nF} faithful / ${nU} unfaithful** (${unsure} unsure, ${unlabelled} unlabelled left out). None of these paragraphs or labels was used for fitting, feature selection or the threshold.`,
    '',
    '## Headline',
    '',
    `FULL score (${config.COMBINED_SCORE_FULL.features.join(', ')}; threshold ${config.COMBINED_SCORE_FULL.threshold}): **balanced accuracy ${ci(full.bacc)}**, catch ${pct(full.rates.catchRate)}, false-fail ${pct(full.rates.falseFail)}. ` +
      `Targets (catch ≥ ${pct(TARGET_CATCH)} AND false-fail ≤ ${pct(TARGET_FALSE_FAIL)}): **${met(full) ? 'met' : 'NOT met'}**.`,
    '',
    '## All three verdicts on the same items',
    '',
    '| Verdict | Balanced accuracy | Catch | False-fail | AUC | Targets met |',
    '|---|---|---|---|---|---|',
    row('FULL combined score (frozen)', full),
    row('LITE combined score (frozen, no NLI)', lite),
    row('Old rule (SBERT ≥ 0.87 AND entities AND NLI rule A)', legacy, ' (0/1 verdict)'),
    '',
    '95% CIs: cluster bootstrap over paragraphs, 2000 resamples, seed 42. Catch = unfaithful outputs that fail; false-fail = faithful outputs that fail.',
    '',
    '## Confusion matrices',
    '',
    ...confusion(full, 'FULL'),
    ...confusion(lite, 'LITE'),
    ...confusion(legacy, 'Old rule'),
    '## Old rule vs combined score (exact McNemar, correct / incorrect per item)',
    '',
    '| Comparison | n | Both right | Only old rule right | Only score right | Both wrong | p |',
    '|---|---|---|---|---|---|---|',
    `| Old rule vs FULL | ${items.length} | ${mcFull.both} | ${mcFull.b} | ${mcFull.c} | ${mcFull.neither} | ${pv(mcFull.p)} |`,
    `| Old rule vs LITE | ${items.length} | ${mcLite.both} | ${mcLite.b} | ${mcLite.c} | ${mcLite.neither} | ${pv(mcLite.p)} |`,
    '',
    '## Per model (FULL score vs old rule)',
    '',
    '| Model | n (faithful / unfaithful) | FULL BAcc | FULL catch | FULL false-fail | Old BAcc | Old catch | Old false-fail |',
    '|---|---|---|---|---|---|---|---|',
    ...perModel.map(p => `| \`${p.m}\` | ${p.n} (${p.full.rates.nFaithful} / ${p.full.rates.nUnfaithful}) | ${ci(p.full.bacc)} | ${pct(p.full.rates.catchRate)} (${p.full.rates.caught}/${p.full.rates.nUnfaithful}) | ${pct(p.full.rates.falseFail)} (${p.full.rates.falseFails}/${p.full.rates.nFaithful}) | ${pct(p.legacy.rates.bacc)} | ${pct(p.legacy.rates.catchRate)} | ${pct(p.legacy.rates.falseFail)} |`),
    '',
    'Per-model samples are small (a handful of unfaithful outputs each), so these rows are descriptive only.',
    '',
    '## Extra latency per paragraph',
    '',
    `- The frozen FULL model ${usesMain ? 'uses' : 'does **not** use'} \`mainClaim\`, so the app ${usesMain ? 'runs' : 'runs **no**'} extra NLI pairs per paragraph${usesMain ? '' : ': the features come from checks the old rule already ran'}.`,
    `- The logistic regression itself: ${lrUs.toFixed(2)} µs per version (Node, ${reps} repetitions over the ${items.length} items).`,
    `- For reference (measured during extraction, Node CPU onnxruntime, one thread): the forward NLI check took median ${percentile(nliMs, 0.5).toFixed(0)} ms / p90 ${percentile(nliMs, 0.9).toFixed(0)} ms per paragraph; the unused main-claim check would add median ${percentile(mainMs, 0.5).toFixed(0)} ms / p90 ${percentile(mainMs, 0.9).toFixed(0)} ms.`,
    '',
    '## Reading',
    '',
    ...(missed ? [
      `**The pre-registered targets were missed.** On the held-out set the frozen FULL score catches ${pct(full.rates.catchRate)} of unfaithful outputs (target ≥ ${pct(TARGET_CATCH)}) and fails ${pct(full.rates.falseFail)} of faithful ones (target ≤ ${pct(TARGET_FALSE_FAIL)}), for a balanced accuracy of ${ci(full.bacc)}. ` +
        `The old rule scores ${ci(legacy.bacc)} on the same items (McNemar p = ${pv(mcFull.p)}).`,
      '',
      'Context: paragraph-level faithfulness detection is hard even for much larger checkers. On LLM-AggreFact (Tang, Laban & Durrett, 2024, "MiniCheck", EMNLP), the best fact-checkers reach a balanced accuracy of about 77%, using models far larger than the extra-small DeBERTa-v3 NLI cross-encoder and all-minilm used here, which must run on the user\'s device. The calibration set (81 items) was small, λ = 1 won the inner CV and shrank the weights strongly, and the nested CV on calibration had already shown no gain over the old rule (PREREG.md), so this outcome was the expected one.',
    ] : [
      `**The pre-registered targets were met.** Catch ${pct(full.rates.catchRate)} (≥ ${pct(TARGET_CATCH)}) and false-fail ${pct(full.rates.falseFail)} (≤ ${pct(TARGET_FALSE_FAIL)}); balanced accuracy ${ci(full.bacc)} vs ${ci(legacy.bacc)} for the old rule (McNemar p = ${pv(mcFull.p)}).`,
      '',
      'Context: on LLM-AggreFact (Tang, Laban & Durrett, 2024, "MiniCheck", EMNLP) the best fact-checkers reach a balanced accuracy of about 77%.',
    ]),
    '',
    'Tested once, no re-tuning on the test set.',
    '',
  ];
  await writeFile(REPORT, lines.join('\n'));
  console.log(`[Clarity] FULL: BAcc ${ci(full.bacc)}, catch ${pct(full.rates.catchRate)}, false-fail ${pct(full.rates.falseFail)}, AUC ${num(full.auc)}; targets ${met(full) ? 'met' : 'NOT met'}`);
  console.log(`[Clarity] LITE: BAcc ${ci(lite.bacc)}; old rule: BAcc ${ci(legacy.bacc)}; McNemar old vs FULL p = ${pv(mcFull.p)}`);
  console.log(`[Clarity] Report written to ${REPORT}`);
} catch (err) {
  console.error(`[Clarity] ${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
