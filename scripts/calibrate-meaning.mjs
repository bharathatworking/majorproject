/**
 * npm run calibrate-meaning — chooses every meaning threshold (SIM_MIN,
 * ENTAILMENT_MIN and the NLI paragraph rule) on the paragraph-level
 * calibration items in eval/nli-calibration/paragraph-items.jsonl, then
 * reports the chosen setting on the held-out test half.
 *
 * Design decisions:
 *  - An item is one simplified paragraph (a real qwen2.5:3b output, or a
 *    copy of it with one injected error) judged against its original. It
 *    PASSES at a setting when, exactly as in the extension:
 *      SBERT cosine (all-minilm via Ollama, original vs plain output) ≥ SIM_MIN
 *      AND the entity rule passes (detectEntities + findMissingEntities,
 *          value-based for numbers and dates; entityVerdict: share kept ≥
 *          ENTITY_RECALL_MIN and every number, date and time zone of the main
 *          claim kept, the main claim chosen by all-minilm as in a run)
 *      AND the NLI paragraph rule passes (nliVerdict over the sentence scores
 *          of the app's own checkEntailment: SummaC premises, top-3 by
 *          all-minilm, 'best-entailing', the frozen glossary hinted words).
 *    The model is scored once per item; the grid only re-applies thresholds.
 *  - Labels: `label` (yours) overrides `proposedLabel`; `faithful` or
 *    `unfaithful`. False-fail = failed faithful / faithful; catch = failed
 *    unfaithful / unfaithful.
 *  - Choice on DEV only: every SIM_MIN 0.60–0.95 (step 0.01) × ENTAILMENT_MIN
 *    0.05–0.95 (step 0.05) × rule {A, B} × ENTITY_RECALL_MIN {1, 0.9, 0.8,
 *    0.75, 0.67, 0.5}; keep the settings with false-fail ≤ 10% and catch
 *    ≥ 90%; tie-breaks: lowest false-fail, highest catch, rule A, the
 *    strictest entity minimum, then the setting nearest the centre of the
 *    remaining plateau
 *    (robust to small-sample noise). The TEST half is only reported, with
 *    Wilson 95% intervals. When no setting qualifies, nothing is
 *    recommended and the nearest settings are shown.
 *  - "Paired catch" is also reported: of the injected copies whose real base
 *    passes, how many fail. The plain catch rate counts a copy as caught
 *    when its base already fails for another reason.
 *  - CONTRADICTION_MAX, NLI_CONTRADICTION_AGG, the premise strategy and the
 *    glossary rules are fixed (calibrated or decided elsewhere).
 *  - Flags: --reviewed-only (items with reviewed: true), --verbose (every
 *    item's checks), --json <path> (all item scores and the grid result).
 *    Items without any label (new real outputs before labelling) are
 *    skipped and counted.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppLoader, embed, embedOrThrow, loadModel, readJsonl, ROOT, wilson } from './lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR = join(ROOT, 'eval', 'nli-calibration');
const MAX_FALSE_FAIL = 0.1;
const MIN_CATCH = 0.9;
const range = (from, to, step) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => Math.round((from + i * step) * 100) / 100);
const SIM_GRID = range(0.6, 0.95, 0.01);
const ENT_GRID = range(0.05, 0.95, 0.05);
const RULES = ['A', 'B'];
/** Minimum share of entities kept (1 = every entity, the rule before calibration). */
const RECALL_GRID = [1, 0.9, 0.8, 0.75, 0.67, 0.5];

const argv = process.argv.slice(2);
const reviewedOnly = argv.includes('--reviewed-only');
const verbose = argv.includes('--verbose');
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pct = x => (x === null || Number.isNaN(x) ? '  n/a' : `${(x * 100).toFixed(1).padStart(5)}%`);
const ci = (k, n) => {
  const w = wilson(k, n);
  return w ? `[${(w[0] * 100).toFixed(0)}–${(w[1] * 100).toFixed(0)}%]` : '';
};
const label = item => item.label ?? item.proposedLabel;

// ─── Main ─────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();

try {
  const load = path => vite.ssrLoadModule(path);
  const config = await load('/src/lib/quality/config.ts');
  const { checkEntailment, NliClient } = await load('/src/lib/quality/nli.ts');
  const { entityVerdict, nliVerdict } = await load('/src/lib/quality/verdict.ts');
  const { keyEntityTexts } = await load('/src/lib/quality/meaning.ts');
  const { mainClaimIndexes, splitSentences } = await load('/src/lib/quality/premises.ts');
  const { findMissingEntities } = await load('/src/lib/quality/semantic.ts');
  const { cosineSimilarity } = await load('/src/lib/quality/similarity.ts');
  const { detectEntities } = await load('/src/lib/segmentation/ner.ts');
  const { toPlainText } = await load('/src/lib/render/format-output.ts');

  const paragraphs = new Map((await readJsonl(join(DATA_DIR, 'paragraphs.jsonl'))).map(p => [p.id, p]));
  let items = await readJsonl(join(DATA_DIR, 'paragraph-items.jsonl'));
  if (reviewedOnly) items = items.filter(i => i.reviewed === true);
  const unlabelled = items.filter(i => !label(i)).length;
  items = items.filter(i => label(i));
  if (unlabelled > 0) console.log(`[Clarity] ${unlabelled} items without a label skipped (run npm run import-labels)`);
  for (const item of items) {
    if (!paragraphs.has(item.paragraphId)) throw new Error(`${item.id}: unknown paragraph ${item.paragraphId}`);
    if (!['faithful', 'unfaithful'].includes(label(item))) throw new Error(`${item.id}: label must be faithful or unfaithful`);
    if (!['dev', 'test'].includes(item.split)) throw new Error(`${item.id}: split must be dev or test`);
  }
  if ((await embed(['probe'])) === null) {
    throw new Error('Ollama with all-minilm is needed: similarity is part of the rule (ollama pull all-minilm)');
  }

  const count = (split, l) => items.filter(i => i.split === split && label(i) === l).length;
  console.log(
    `[Clarity] Meaning calibration: ${items.length} items` +
    ` (dev ${count('dev', 'faithful')} faithful / ${count('dev', 'unfaithful')} unfaithful,` +
    ` test ${count('test', 'faithful')} / ${count('test', 'unfaithful')})` +
    `${reviewedOnly ? ', reviewed only' : ', proposed labels where not reviewed'}; model ${config.NLI_MODEL_ID} q8 (CPU)`,
  );

  // ── Score every item once
  const { score } = await loadModel(config.NLI_MODEL_ID);
  const client = new NliClient({ score: pairs => score(pairs) });
  const results = [];
  for (const item of items) {
    const original = paragraphs.get(item.paragraphId).text;
    const hinted = paragraphs.get(item.paragraphId).hintedWords ?? [];
    const plain = toPlainText(item.simplified);
    const [a, b] = await embedOrThrow([original, plain]);
    const entities = detectEntities(original);
    const missing = findMissingEntities(entities, plain);
    // Main claim as in a run: the sentence closest to the paragraph (all-minilm)
    const sentences = splitSentences(original);
    let claim = mainClaimIndexes(sentences.length);
    if (sentences.length > 2) {
      const [paragraph, ...vecs] = await embedOrThrow([original, ...sentences]);
      claim = mainClaimIndexes(sentences.length, { sentences: vecs, paragraph });
    }
    const keyTexts = keyEntityTexts(original, entities, claim, sentences);
    const nli = await checkEntailment(original, item.simplified, hinted, client, { embed: embedOrThrow });
    results.push({
      item,
      label: label(item),
      similarity: cosineSimilarity(a, b),
      missingEntities: missing,
      entityTexts: entities.map(e => e.text),
      keyTexts,
      sentenceScores: nli.sentenceScores,
      truncatedPairs: nli.truncatedPairs,
    });
  }

  /** Which checks fail an item at a setting (empty = passes). */
  const failuresAt = (r, s) => {
    const f = [];
    if (r.similarity < s.sim) f.push('similarity');
    if (!entityVerdict({ entityTexts: r.entityTexts, missing: r.missingEntities, keyTexts: r.keyTexts, recallMin: s.recall ?? 1 }).passed) {
      f.push('entities');
    }
    const v = nliVerdict(r.sentenceScores, { entailmentMin: s.ent, rule: s.rule });
    if (v.contradicted.length > 0) f.push('contradiction');
    if (!v.passed && v.contradicted.length === 0) f.push('unsupported');
    else if (v.unsupported.some(x => !v.contradicted.includes(x))) f.push('unsupported');
    return f;
  };
  const rates = (split, s) => {
    const rs = results.filter(r => r.item.split === split);
    const faithful = rs.filter(r => r.label === 'faithful');
    const unfaithful = rs.filter(r => r.label === 'unfaithful');
    const ff = faithful.filter(r => failuresAt(r, s).length > 0).length;
    const caught = unfaithful.filter(r => failuresAt(r, s).length > 0).length;
    return {
      ff, nFaithful: faithful.length, caught, nUnfaithful: unfaithful.length,
      falseFail: faithful.length ? ff / faithful.length : NaN,
      catchRate: unfaithful.length ? caught / unfaithful.length : NaN,
    };
  };

  // ── Grid on dev
  const grid = [];
  for (const recall of RECALL_GRID) {
    for (const rule of RULES) for (const sim of SIM_GRID) for (const ent of ENT_GRID) {
      grid.push({ sim, ent, rule, recall, ...rates('dev', { sim, ent, rule, recall }) });
    }
  }
  const qualifying = grid.filter(g => g.falseFail <= MAX_FALSE_FAIL && g.catchRate >= MIN_CATCH);

  let chosen = null;
  if (qualifying.length > 0) {
    const bestFf = Math.min(...qualifying.map(g => g.falseFail));
    let pool = qualifying.filter(g => g.falseFail === bestFf);
    const bestCatch = Math.max(...pool.map(g => g.catchRate));
    pool = pool.filter(g => g.catchRate === bestCatch);
    if (pool.some(g => g.rule === 'A')) pool = pool.filter(g => g.rule === 'A');
    // The strictest entity recall that qualifies (1 = today's rule)
    const bestRecall = Math.max(...pool.map(g => g.recall));
    pool = pool.filter(g => g.recall === bestRecall);
    const centre = { sim: pool.reduce((a, g) => a + g.sim, 0) / pool.length, ent: pool.reduce((a, g) => a + g.ent, 0) / pool.length };
    const dist = g => ((g.sim - centre.sim) / 0.35) ** 2 + ((g.ent - centre.ent) / 0.9) ** 2;
    chosen = pool.reduce((best, g) => (dist(g) < dist(best) ? g : best));
    console.log(
      `\nDev: ${qualifying.length} of ${grid.length} settings meet false-fail ≤ ${MAX_FALSE_FAIL * 100}% and catch ≥ ${MIN_CATCH * 100}%; ` +
      `${pool.length} tie at false-fail ${pct(bestFf)}, catch ${pct(bestCatch)}` +
      ` (SIM_MIN ${Math.min(...pool.map(g => g.sim))}–${Math.max(...pool.map(g => g.sim))},` +
      ` ENTAILMENT_MIN ${Math.min(...pool.map(g => g.ent))}–${Math.max(...pool.map(g => g.ent))}, rule ${[...new Set(pool.map(g => g.rule))].join('/')})`,
    );
  } else {
    console.log(`\nDev: no setting meets false-fail ≤ ${MAX_FALSE_FAIL * 100}% and catch ≥ ${MIN_CATCH * 100}%. Nearest:`);
    const byFf = grid.filter(g => g.catchRate >= MIN_CATCH).sort((a, b) => a.falseFail - b.falseFail || b.catchRate - a.catchRate)[0];
    const byCatch = grid.filter(g => g.falseFail <= MAX_FALSE_FAIL).sort((a, b) => b.catchRate - a.catchRate || a.falseFail - b.falseFail)[0];
    for (const [name, g] of [['lowest false-fail with catch ≥ 90%', byFf], ['highest catch with false-fail ≤ 10%', byCatch]]) {
      if (g) console.log(`  ${name}: SIM_MIN ${g.sim}, ENTAILMENT_MIN ${g.ent}, rule ${g.rule}, entity recall ≥ ${g.recall} → false-fail ${pct(g.falseFail)} (${g.ff}/${g.nFaithful}), catch ${pct(g.catchRate)} (${g.caught}/${g.nUnfaithful})`);
      else console.log(`  ${name}: none`);
    }
  }

  // ── Report: the current config and the chosen setting, on dev and test
  const current = {
    sim: config.SIMILARITY_THRESHOLD ?? config.SIM_MIN, ent: config.ENTAILMENT_MIN,
    rule: config.NLI_PARAGRAPH_RULE, recall: config.ENTITY_RECALL_MIN,
  };
  const show = (name, s) => {
    console.log(`\n${name}: SIM_MIN ${s.sim}, ENTAILMENT_MIN ${s.ent}, rule ${s.rule}${s.recall < 1 ? `, entity recall ≥ ${s.recall}` : ''}`);
    for (const split of ['dev', 'test']) {
      const r = rates(split, s);
      console.log(
        `  ${split.padEnd(4)} false-fail ${pct(r.falseFail)} (${r.ff}/${r.nFaithful}) ${ci(r.ff, r.nFaithful)}` +
        `   catch ${pct(r.catchRate)} (${r.caught}/${r.nUnfaithful}) ${ci(r.caught, r.nUnfaithful)}`,
      );
    }
    // Injected copies whose real base passes: is the injected error itself caught?
    const byId = new Map(results.map(r => [r.item.id, r]));
    const paired = results.filter(r => r.item.injectedFrom && failuresAt(byId.get(r.item.injectedFrom), s).length === 0);
    console.log(`  paired catch (injected copy failed while its real base passes): ${paired.filter(r => failuresAt(r, s).length > 0).length}/${paired.length}`);
    const types = [...new Set(results.filter(r => r.item.errorType).map(r => r.item.errorType))];
    console.log(`  catch by injected error (dev + test): ${types.map(t => {
      const rs = results.filter(r => r.item.errorType === t);
      return `${t} ${rs.filter(r => failuresAt(r, s).length > 0).length}/${rs.length}`;
    }).join(', ')}`);
    for (const r of results) {
      const f = failuresAt(r, s);
      if (r.label === 'faithful' && f.length > 0) {
        const key = r.missingEntities.filter(t => r.keyTexts.includes(t));
        console.log(
          `  false fail ${r.item.id} [${r.item.split}]: ${f.join(' + ')} (sim ${r.similarity.toFixed(3)}` +
          `${r.missingEntities.length ? `, missing ${r.missingEntities.join(', ')}` : ''}${key.length ? `; key ${key.join(', ')}` : ''})`,
        );
      }
      if (r.label === 'unfaithful' && f.length === 0) console.log(`  missed     ${r.item.id} [${r.item.split}] (sim ${r.similarity.toFixed(3)}, min entailment ${Math.min(...r.sentenceScores.filter(x => !x.exempt).map(x => x.entailment)).toFixed(3)})`);
    }
  };
  show('Current config', current);
  if (chosen) show('Chosen on dev', chosen);

  if (verbose) {
    console.log('\nItems:');
    for (const r of results) {
      const minE = Math.min(...r.sentenceScores.filter(x => !x.exempt).map(x => x.entailment));
      const maxC = Math.max(0, ...r.sentenceScores.map(x => x.contradiction));
      console.log(
        `  ${r.item.id.padEnd(48)} ${r.item.split} ${r.label.padEnd(10)} sim ${r.similarity.toFixed(3)} ` +
        `ent ${minE.toFixed(3)} con ${maxC.toFixed(3)} sentences ${r.sentenceScores.length}` +
        `${r.missingEntities.length ? ` missing [${r.missingEntities.join(', ')}]` : ''}`,
      );
    }
  }
  const truncated = results.reduce((a, r) => a + r.truncatedPairs, 0);
  console.log(`\nTruncated pairs (> 512 tokens): ${truncated}`);

  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify({
      at: new Date().toISOString(),
      reviewedOnly,
      chosen,
      qualifying: qualifying.length,
      items: results.map(r => ({
        id: r.item.id, split: r.item.split, label: r.label, similarity: r.similarity,
        missingEntities: r.missingEntities, sentenceScores: r.sentenceScores,
      })),
    }, null, 2));
    console.log(`[Clarity] Scores written to ${jsonOut}`);
  }
} finally {
  await vite.close();
}
