/**
 * npm run checker:rescale — the stage 7 QUALITY_THRESHOLD for the combined
 * meaning score, by quantile matching on the 81 calibration items only.
 *
 * Design decisions:
 *  - Since 2026-10-19 the meaning part of the stage 7 total (score.ts) is
 *    the combined score (about 0.35–0.7) instead of entity × sbert ×
 *    nliMin, so the old 0.75 sent almost every node to the extra variants.
 *    This script computes both totals per calibration item and prints the
 *    threshold under which the new total has the same share of items as the
 *    old total had under QUALITY_THRESHOLD_OLD_SCALE (lib.ts
 *    quantileMatchThreshold). It writes nothing; the value is copied into
 *    config.ts by hand, with its derivation in the comment.
 *  - Reads only RESCALE_FILES (calibration features, outputs, originals)
 *    through readTrainingFile, so the bake-off set can't be read.
 *  - Readability uses the app's estimateNodeGrade with the base common-word
 *    list (no custom words) and each paragraph's stored targetGrade; length
 *    uses the CSV's lenRatio (the same word ratio score.ts computes).
 *  - Also printed, for information: the full "Extra quality" trigger
 *    (version fails the meaning check OR total below the threshold), old
 *    rule vs combined score. The meaning verdict itself is frozen and is not
 *    changed here.
 */

import { readFile } from 'node:fs/promises';
import { createAppLoader, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const FEATURES = 'eval/checker/features_calib.csv';
const ITEMS = 'eval/nli-calibration/paragraph-items.jsonl';
const PARAGRAPHS = 'eval/nli-calibration/paragraphs.jsonl';
const pct = x => `${(x * 100).toFixed(1)}%`;
const jsonl = text => text.split(/\r?\n/).filter(l => l.trim() !== '').map(l => JSON.parse(l));

// ─── Main ─────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
try {
  const load = path => vite.ssrLoadModule(path);
  const lib = await load('/scripts/checker/lib.ts');
  const config = await load('/src/lib/quality/config.ts');
  const checker = await load('/src/lib/quality/checker.ts');
  const { estimateNodeGrade } = await load('/src/lib/metrics/node-grade.ts');
  const { BASE_COMMON_WORDS } = await load('/src/lib/metrics/common-words.ts');
  const read = path => lib.readTrainingFile(ROOT, path, p => readFile(p, 'utf8'), lib.RESCALE_FILES);

  const rows = lib.parsePlainCsv(await read(FEATURES));
  const items = jsonl(await read(ITEMS));
  const paragraphs = new Map(jsonl(await read(PARAGRAPHS)).map(p => [p.id, p]));
  const simplifiedById = new Map(items.map(i => [i.id, i.simplified]));
  const targetGradeById = new Map(items.map(i => [i.id, paragraphs.get(i.paragraphId)?.targetGrade]));
  const wordSet = new Set(BASE_COMMON_WORDS);
  const totals = lib.stage7Totals(rows, simplifiedById, targetGradeById, plain => estimateNodeGrade(plain, wordSet));

  const oldT = config.QUALITY_THRESHOLD_OLD_SCALE;
  const oldTotals = totals.map(t => t.oldTotal);
  const newTotals = totals.map(t => t.newTotal);
  const match = lib.quantileMatchThreshold(oldTotals, newTotals, oldT);
  const n = totals.length;

  console.log(`[Clarity] Stage 7 rescale on ${n} calibration items (${FEATURES}, ${ITEMS})`);
  if (n !== 81) console.log(`[Clarity] NOTE: expected 81 items, found ${n}`);
  console.log(`[Clarity] old total (meaning = entity × sbert × nliMin): ${match.k}/${n} = ${pct(match.oldShare)} below ${oldT}`);
  console.log(`[Clarity] new total (meaning = FULL combined score):   ${Math.round(match.newShare * n)}/${n} = ${pct(match.newShare)} below ${match.threshold}`);
  console.log(`[Clarity] new total below the OLD ${oldT} (the problem): ${pct(lib.belowShare(newTotals, oldT))}`);
  console.log(`[Clarity] QUALITY_THRESHOLD = ${match.threshold} (currently in config.ts: ${config.QUALITY_THRESHOLD})`);

  // For information: the whole trigger, meaning check failed OR total below the threshold
  const newPass = rows.map(r => {
    const x = Object.fromEntries(checker.FEATURES.map(f => [f, Number(r[f])]));
    return checker.combinedScore(config.COMBINED_SCORE_FULL, x).score >= config.COMBINED_SCORE_FULL.threshold;
  });
  const oldTrigger = rows.filter((r, i) => r.legacyPass !== '1' || oldTotals[i] < oldT).length / n;
  const newTrigger = rows.filter((_, i) => !newPass[i] || newTotals[i] < match.threshold).length / n;
  console.log(`[Clarity] info: full trigger (fails meaning OR total low): old rule + ${oldT} ${pct(oldTrigger)}; combined score + ${match.threshold} ${pct(newTrigger)}`);
} catch (err) {
  console.error(`[Clarity] ${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
