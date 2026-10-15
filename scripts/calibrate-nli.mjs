/**
 * npm run calibrate-nli — calibrates ENTAILMENT_MIN on the hand-labelled
 * set in eval/nli-calibration/ before the thesis benchmark.
 *
 * Design decisions:
 *  - Same model, same weights: Xenova/nli-deberta-v3-xsmall q8 from
 *    public/models/ (npm run fetch-models), env.allowRemoteModels = false.
 *    Node runs it on onnxruntime-node (CPU) instead of onnxruntime-web; the
 *    graph and the quantized weights are identical, so probabilities match
 *    to rounding. One intra-op thread, like the extension's wasm backend, so
 *    the timings are a rough proxy for wasm (not for WebGPU).
 *  - Same code: premises (buildPremises, rankPremises, lexicalRank,
 *    aggregate), sentence splitting and the thresholds are the extension's
 *    TypeScript modules, loaded through Vite's ssrLoadModule (no new
 *    dependency, no copy of the logic that could drift).
 *  - Same ranking: all-minilm through local Ollama when it answers, else the
 *    word-overlap fallback (printed). Every premise is scored, so the table
 *    also shows what pruning to the top 3 costs ("all premises").
 *  - An item is one simplified sentence (hypothesis) of one paragraph. It
 *    FAILS at threshold t when entailment < t or contradiction >
 *    CONTRADICTION_MAX. False-fail rate = failed faithful / faithful; catch
 *    rate = failed wrong / wrong. "before" is the old strategy (the whole
 *    paragraph as the only premise), for comparison.
 *  - Recommendation: the highest t with false-fail ≤ 10% and catch ≥ 90% for
 *    the app's configuration (top 3 premises, NLI_CONTRADICTION_AGG); none
 *    when no t qualifies. The chosen value is written into config.ts by hand,
 *    with the date and both rates, and then frozen for the benchmark.
 *  - Flags: --reviewed-only (items with reviewed: true), --verbose (every
 *    item's scores), --compare-fp16 (also scores every pruned pair with the
 *    fp16 weights, npm run fetch-models -- --fp16, and reports how often the
 *    sentence and paragraph decisions agree with q8; CPU only, so its
 *    timings say nothing about WebGPU — clarityNliExperiment() measures
 *    those in Chrome).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'eval', 'nli-calibration');
const OLLAMA = 'http://localhost:11434';
const EMBED_MODEL = 'all-minilm';
const MAX_TOKENS = 512;
const THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const MAX_FALSE_FAIL = 0.1;
const MIN_CATCH = 0.9;

const args = new Set(process.argv.slice(2));
const reviewedOnly = args.has('--reviewed-only');
const verbose = args.has('--verbose');
const compareFp16 = args.has('--compare-fp16');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readJsonl(name) {
  const text = await readFile(join(DATA_DIR, name), 'utf8');
  return text.split(/\r?\n/).filter(l => l.trim() !== '').map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      throw new Error(`${name} line ${i + 1}: ${err.message}`);
    }
  });
}

const pct = x => (x === null ? '  n/a' : `${(x * 100).toFixed(1).padStart(5)}%`);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function softmax(row) {
  const max = Math.max(...row);
  const exps = row.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

/** all-minilm vectors from Ollama, or null when it doesn't answer. */
async function embed(texts) {
  try {
    const res = await fetch(`${OLLAMA}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: '10m' }),
    });
    if (!res.ok) return null;
    return (await res.json()).embeddings;
  } catch {
    return null;
  }
}

// ─── Model ────────────────────────────────────────────────────────────────────

async function loadModel(modelId, dtype = 'q8') {
  const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = join(ROOT, 'public', 'models') + '/';
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
    dtype,
    device: 'cpu',
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  const id2label = model.config.id2label ?? {};
  const find = label => Number(Object.entries(id2label).find(([, l]) => l.toLowerCase() === label)?.[0]);
  const index = { entailment: find('entailment'), contradiction: find('contradiction') };
  if (Number.isNaN(index.entailment) || Number.isNaN(index.contradiction)) throw new Error('model labels missing');

  /** Probabilities and truncation flags for a batch of pairs (same code path as nli.worker.ts). */
  async function score(pairs) {
    const full = tokenizer(pairs.map(p => p.premise), {
      text_pair: pairs.map(p => p.hypothesis), padding: false, truncation: false, return_tensor: false,
    });
    const inputs = tokenizer(pairs.map(p => p.premise), {
      text_pair: pairs.map(p => p.hypothesis), padding: true, truncation: true, max_length: MAX_TOKENS,
    });
    const { logits } = await model(inputs);
    const labels = logits.dims[1];
    return pairs.map((_, i) => {
      const p = softmax(Array.from({ length: labels }, (_, j) => Number(logits.data[i * labels + j])));
      return {
        entailment: p[index.entailment],
        contradiction: p[index.contradiction],
        truncated: full.input_ids[i].length > MAX_TOKENS,
      };
    });
  }
  return { score };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const { createServer } = await import(pathToFileURL(join(ROOT, 'node_modules/vite/dist/node/index.js')).href);
const vite = await createServer({
  root: ROOT, configFile: false, logLevel: 'error', appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
});

try {
  const config = await vite.ssrLoadModule('/src/lib/quality/config.ts');
  const premisesLib = await vite.ssrLoadModule('/src/lib/quality/premises.ts');
  const { splitSentences } = await vite.ssrLoadModule('/src/lib/quality/nli.ts');
  const { nliVerdict } = await vite.ssrLoadModule('/src/lib/quality/verdict.ts');
  const { buildPremises, rankPremises, lexicalRank, aggregate } = premisesLib;
  const K = config.NLI_TOP_PREMISES;

  const paragraphs = new Map((await readJsonl('paragraphs.jsonl')).map(p => [p.id, p]));
  let items = await readJsonl('pairs.jsonl');
  if (reviewedOnly) items = items.filter(i => i.reviewed === true);
  const label = i => i.label ?? i.proposedLabel;
  for (const item of items) {
    if (!paragraphs.has(item.paragraphId)) throw new Error(`${item.id}: unknown paragraph ${item.paragraphId}`);
    if (!['faithful', 'wrong'].includes(label(item))) throw new Error(`${item.id}: label must be faithful or wrong`);
  }
  console.log(
    `[Clarity] NLI calibration: ${items.length} items (${items.filter(i => label(i) === 'faithful').length} faithful, ` +
    `${items.filter(i => label(i) === 'wrong').length} wrong) from ${paragraphs.size} paragraphs` +
    `${reviewedOnly ? ', reviewed only' : ', proposed labels (not yet reviewed)'}; model ${config.NLI_MODEL_ID} q8`,
  );

  const { score } = await loadModel(config.NLI_MODEL_ID);
  const fp16 = compareFp16 ? await loadModel(config.NLI_MODEL_ID, 'fp16') : null;
  const embeddingsOk = (await embed(['probe'])) !== null;
  console.log(`[Clarity] Premise ranking: ${embeddingsOk ? `${EMBED_MODEL} via Ollama` : 'word overlap (Ollama/all-minilm not reachable)'}`);

  // Per item: scores over every premise, the top-K subset, and the old paragraph premise
  const results = [];
  for (const item of items) {
    const paragraph = paragraphs.get(item.paragraphId).text;
    const premises = buildPremises(splitSentences(paragraph));
    const hyp = item.hypothesis;
    const all = await score(premises.map(premise => ({ premise, hypothesis: hyp })));
    let top;
    if (premises.length <= K) top = premises.map((_, i) => i);
    else if (embeddingsOk) {
      const vecs = await embed([...premises, hyp]);
      top = vecs ? rankPremises(vecs.slice(0, -1), [vecs.at(-1)], K)[0] : lexicalRank(premises, [hyp], K)[0];
    } else top = lexicalRank(premises, [hyp], K)[0];
    const [before] = await score([{ premise: paragraph, hypothesis: hyp }]);
    const pruned = top.map(i => all[i]);
    const prunedFp16 = fp16 ? await fp16.score(top.map(i => ({ premise: premises[i], hypothesis: hyp }))) : null;
    results.push({
      fp16Verdict: prunedFp16 && aggregate(prunedFp16, config.NLI_CONTRADICTION_AGG),
      item,
      label: label(item),
      verdicts: {
        'top3 / max': aggregate(pruned, 'max'),
        'top3 / best-entailing': aggregate(pruned, 'best-entailing'),
        'all premises / max': aggregate(all, 'max'),
        'before (paragraph)': { entailment: before.entailment, contradiction: before.contradiction },
      },
      truncatedAfter: pruned.filter(p => p.truncated).length,
      pairsAfter: pruned.length,
      truncatedBefore: before.truncated ? 1 : 0,
    });
    if (verbose) {
      const v = results.at(-1).verdicts[`top3 / ${config.NLI_CONTRADICTION_AGG}`];
      console.log(`  ${item.id} [${label(item)}${item.errorType ? `/${item.errorType}` : ''}] e=${v.entailment.toFixed(3)} c=${v.contradiction.toFixed(3)} before e=${before.entailment.toFixed(3)} c=${before.contradiction.toFixed(3)}  ${hyp}`);
    }
  }

  // ── Threshold tables
  const fails = (v, t) => v.entailment < t || v.contradiction > config.CONTRADICTION_MAX;
  const rates = (strategy, t) => {
    const faithful = results.filter(r => r.label === 'faithful');
    const wrong = results.filter(r => r.label === 'wrong');
    const ff = faithful.length ? faithful.filter(r => fails(r.verdicts[strategy], t)).length / faithful.length : null;
    const cr = wrong.length ? wrong.filter(r => fails(r.verdicts[strategy], t)).length / wrong.length : null;
    return { falseFail: ff, catchRate: cr };
  };
  const recommend = strategy => {
    const ok = THRESHOLDS.filter(t => {
      const r = rates(strategy, t);
      return r.falseFail !== null && r.catchRate !== null && r.falseFail <= MAX_FALSE_FAIL && r.catchRate >= MIN_CATCH;
    });
    return ok.length ? ok[ok.length - 1] : null;
  };

  const strategies = ['top3 / max', 'top3 / best-entailing', 'all premises / max', 'before (paragraph)'];
  console.log(`\nCONTRADICTION_MAX = ${config.CONTRADICTION_MAX}; an item fails when entailment < t or contradiction > ${config.CONTRADICTION_MAX}`);
  for (const strategy of strategies) {
    console.log(`\n${strategy}${strategy.startsWith('top3 / ' + config.NLI_CONTRADICTION_AGG) ? '   <- app configuration' : ''}`);
    console.log('  ENTAILMENT_MIN   false-fail (faithful)   catch (wrong)');
    for (const t of THRESHOLDS) {
      const r = rates(strategy, t);
      const mark = r.falseFail !== null && r.falseFail <= MAX_FALSE_FAIL && r.catchRate >= MIN_CATCH ? '  ok' : '';
      console.log(`  ${t.toFixed(2).padStart(14)}   ${pct(r.falseFail).padStart(20)}   ${pct(r.catchRate).padStart(13)}${mark}`);
    }
    const best = recommend(strategy);
    console.log(`  recommended: ${best === null ? `none (no t with false-fail ≤ ${MAX_FALSE_FAIL * 100}% and catch ≥ ${MIN_CATCH * 100}%)` : best.toFixed(2)}`);
  }

  // ── Catch rate by error type, and contradiction-only failures, at the current threshold
  const appStrategy = `top3 / ${config.NLI_CONTRADICTION_AGG}`;
  const t0 = recommend(appStrategy) ?? config.ENTAILMENT_MIN;
  console.log(`\nAt ENTAILMENT_MIN ${t0.toFixed(2)} (${appStrategy}):`);
  const types = [...new Set(results.filter(r => r.label === 'wrong').map(r => r.item.errorType ?? 'unspecified'))];
  for (const type of types) {
    const rs = results.filter(r => r.label === 'wrong' && (r.item.errorType ?? 'unspecified') === type);
    console.log(`  catch ${type.padEnd(12)} ${pct(rs.filter(r => fails(r.verdicts[appStrategy], t0)).length / rs.length)} (${rs.length} items)`);
  }
  const falseContradictions = results.filter(r => r.label === 'faithful' && r.verdicts[appStrategy].contradiction > config.CONTRADICTION_MAX);
  console.log(`  faithful items failed by contradiction alone: ${falseContradictions.length}`);
  for (const r of falseContradictions) console.log(`    ${r.item.id}: c=${r.verdicts[appStrategy].contradiction.toFixed(3)} "${r.item.hypothesis}"`);
  const missed = results.filter(r => r.label === 'wrong' && !fails(r.verdicts[appStrategy], t0));
  for (const r of missed) console.log(`  missed ${r.item.id} [${r.item.errorType}]: e=${r.verdicts[appStrategy].entailment.toFixed(3)} c=${r.verdicts[appStrategy].contradiction.toFixed(3)} "${r.item.hypothesis}"`);

  // ── Truncation, per item pair
  const sum = (k) => results.reduce((a, r) => a + r[k], 0);
  console.log(`\nTruncated pairs (> ${MAX_TOKENS} tokens): before ${sum('truncatedBefore')}/${results.length}, after ${sum('truncatedAfter')}/${sum('pairsAfter')}`);

  // ── Timing proxy: whole simplified paragraphs, one batch per paragraph, one CPU thread
  const before = [];
  const after = [];
  const paragraphDecisions = [];
  let truncBefore = 0;
  let truncAfter = 0;
  let pairsBefore = 0;
  let pairsAfter = 0;
  for (const p of paragraphs.values()) {
    if (!p.simplification) continue;
    const hyps = splitSentences(p.simplification);
    const premises = buildPremises(splitSentences(p.text));
    const vecs = premises.length > K && embeddingsOk ? await embed([...premises, ...hyps]) : null;
    const top = premises.length <= K
      ? hyps.map(() => premises.map((_, i) => i))
      : vecs ? rankPremises(vecs.slice(0, premises.length), vecs.slice(premises.length), K) : lexicalRank(premises, hyps, K);
    const oldPairs = hyps.map(h => ({ premise: p.text, hypothesis: h }));
    const newPairs = hyps.flatMap((h, i) => top[i].map(j => ({ premise: premises[j], hypothesis: h })));
    if (fp16) {
      // Paragraph decision under the app's rule, q8 vs fp16 (no glossary hints here)
      const verdictOf = async (scorer) => {
        const probs = await scorer(newPairs);
        let offset = 0;
        return nliVerdict(hyps.map((sentence, i) => {
          const own = probs.slice(offset, offset + top[i].length);
          offset += top[i].length;
          const v = aggregate(own, config.NLI_CONTRADICTION_AGG);
          return { sentence, entailment: v.entailment, contradiction: v.contradiction, exempt: false };
        })).passed;
      };
      paragraphDecisions.push([await verdictOf(score), await verdictOf(fp16.score)]);
    }
    let s = performance.now();
    const o = await score(oldPairs);
    before.push(performance.now() - s);
    s = performance.now();
    const n = await score(newPairs);
    after.push(performance.now() - s);
    truncBefore += o.filter(x => x.truncated).length;
    truncAfter += n.filter(x => x.truncated).length;
    pairsBefore += oldPairs.length;
    pairsAfter += newPairs.length;
  }
  if (before.length) {
    console.log(
      `\nNode CPU proxy (1 thread, ${before.length} simplified paragraphs, one batch each): ` +
      `before ${Math.round(mean(before))} ms per paragraph (${pairsBefore} pairs, ${truncBefore} truncated), ` +
      `after ${Math.round(mean(after))} ms per paragraph (${pairsAfter} pairs, ${truncAfter} truncated)`,
    );
  }

  // ── fp16 vs q8 decisions (same pruned premises)
  if (fp16) {
    const appStrategyKey = `top3 / ${config.NLI_CONTRADICTION_AGG}`;
    const t = config.ENTAILMENT_MIN;
    const agree = results.filter(r => fails(r.verdicts[appStrategyKey], t) === fails(r.fp16Verdict, t)).length;
    const maxDiff = Math.max(...results.map(r => Math.max(
      Math.abs(r.verdicts[appStrategyKey].entailment - r.fp16Verdict.entailment),
      Math.abs(r.verdicts[appStrategyKey].contradiction - r.fp16Verdict.contradiction),
    )));
    const pAgree = paragraphDecisions.filter(([a, b]) => a === b).length;
    console.log(
      `
fp16 vs q8 (CPU, ENTAILMENT_MIN ${t}, rule ${config.NLI_PARAGRAPH_RULE}): ` +
      `sentence decisions agree ${agree}/${results.length}, paragraph decisions agree ${pAgree}/${paragraphDecisions.length}, ` +
      `largest probability difference ${maxDiff.toFixed(4)}`,
    );
    for (const r of results.filter(r => fails(r.verdicts[appStrategyKey], t) !== fails(r.fp16Verdict, t))) {
      const q = r.verdicts[appStrategyKey];
      console.log(
        `  differs ${r.item.id} [${r.label}]: q8 e=${q.entailment.toFixed(3)} c=${q.contradiction.toFixed(3)}, ` +
        `fp16 e=${r.fp16Verdict.entailment.toFixed(3)} c=${r.fp16Verdict.contradiction.toFixed(3)} "${r.item.hypothesis}"`,
      );
    }
  }
} finally {
  await vite.close();
}
