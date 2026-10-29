/**
 * npm run nli:perf -- [report.json …] [--configs cpu1,cpu4,webgpu] [--json out.json]
 * — where the NLI meaning check spends its time, and whether a batching
 * change moves any verdict. Writes nothing unless --json is given; the
 * numbers go into eval/checker/NLI_PERF.md by hand.
 *
 * Design decisions:
 *  - Inputs are real scored versions: every candidate with NLI time in the
 *    given run reports (default: the committed UK fixture,
 *    eval/fixtures/runs/uk-wiki-2026-10-19.json). The original is the
 *    report's modelInput, or cleanForModel(originalText) for format 3, as
 *    the app checked it. Identical (original, text) versions are scored once.
 *  - The app's own checkEntailment and NliClient run through the Vite
 *    loader, with word-overlap premise ranking (no Ollama needed, so every
 *    configuration scores the same pairs). Hinted words are not in the
 *    reports, so no glossary exemptions apply; that changes no pair count.
 *  - Batching strategies are applied inside a backend wrapper (the client
 *    sends a version's uncached pairs in one call): in-order-32 (the app on
 *    WebGPU before the fix), in-order-8 (wasm, and the calibration and
 *    checker fit), sorted (length-sorted batches with a token budget; tried,
 *    not adopted) and single (one pair per call, no padding at all).
 *  - Configurations: onnxruntime-node on the CPU with 1 thread (the
 *    extension's wasm and the calibration setup), with 4 threads, and on
 *    ORT's native WebGPU EP (the C++ EP that the extension's asyncify wasm
 *    build also compiles). The WebGPU session is the one the probe in
 *    NLI_PERF.md showed placing every MatMulInteger and DynamicQuantizeLinear
 *    on the CPU EP.
 *  - Verdict agreement: the FULL combined score (frozen, config.ts) from the
 *    report's similarity and entity recall, the length ratio, and the NLI
 *    parts of each strategy, compared with in-order-32 and in-order-8.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppLoader, loadModel, ROOT } from './lib/nli-node.mjs';

// ─── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const configNames = (flag('--configs') ?? 'cpu1,cpu4,webgpu').split(',');
const jsonOut = flag('--json');
const reportPaths = args.length > 0 ? args : [join(ROOT, 'eval/fixtures/runs/uk-wiki-2026-10-19.json')];

const CONFIGS = {
  cpu1: { device: 'cpu', threads: 1 },
  cpu4: { device: 'cpu', threads: 4 },
  webgpu: { device: 'webgpu', threads: 1 },
};

// ─── App code ─────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
const load = path => vite.ssrLoadModule(path);
const nli = await load('/src/lib/quality/nli.ts');
const config = await load('/src/lib/quality/config.ts');
const checker = await load('/src/lib/quality/checker.ts');
const { cleanForModel } = await load('/src/lib/segmentation/clutter.ts');
const { toPlainText } = await load('/src/lib/render/format-output.ts');

// ─── Versions ─────────────────────────────────────────────────────────────────

const versions = [];
const seen = new Set();
for (const path of reportPaths) {
  const report = JSON.parse(await readFile(path, 'utf8'));
  for (const run of report.runs ?? []) {
    for (const node of run.nodes ?? []) {
      const original = node.modelInput || cleanForModel(node.originalText ?? '');
      for (const c of node.candidates ?? []) {
        if (!c.nliMs || !c.text) continue;
        const key = `${original}\u0000${c.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        versions.push({
          source: `${path.split(/[\\/]/).at(-1)} ${node.nodeId}`,
          original,
          text: c.text,
          similarity: c.scores?.similarity ?? null,
          entityRecall: c.scores?.entityRecall ?? null,
          appNliMs: c.nliMs,
        });
      }
    }
  }
}
console.log(`[Clarity] ${versions.length} scored versions from ${reportPaths.length} report(s)`);

// ─── Batching ─────────────────────────────────────────────────────────────────

/** Padded-token budget of one sorted batch (pairs × longest pair). */
const SORTED_TOKEN_BUDGET = 2048;

/**
 * Index batches sorted by token length, cut so no batch pads more than
 * `tokenBudget` tokens or holds more than `maxPairs` pairs (tried as a fix
 * and not adopted: NLI_PERF.md).
 */
function sortedBatches(lengths, tokenBudget, maxPairs) {
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b] || a - b);
  const batches = [];
  let current = [];
  for (const i of order) {
    if (current.length > 0 && (current.length >= maxPairs || (current.length + 1) * lengths[i] > tokenBudget)) {
      batches.push(current);
      current = [];
    }
    current.push(i);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Index batches of `lengths` for one strategy. */
function batchesFor(strategy, lengths) {
  const order = lengths.map((_, i) => i);
  if (strategy === 'single') return order.map(i => [i]);
  if (strategy === 'sorted') return sortedBatches(lengths, SORTED_TOKEN_BUDGET, config.NLI_BATCH_SIZE_WEBGPU);
  const size = strategy === 'in-order-8' ? 8 : 32;
  const out = [];
  for (let i = 0; i < order.length; i += size) out.push(order.slice(i, i + size));
  return out;
}

/** An NliBackend that batches one call's pairs by `strategy` and counts tokens. */
function strategyBackend(model, strategy, stats) {
  return {
    async score(pairs) {
      const lengths = model.tokenLengths(pairs).map(n => Math.min(n, 512));
      const out = new Array(pairs.length);
      for (const batch of batchesFor(strategy, lengths)) {
        const maxLen = Math.max(...batch.map(i => lengths[i]));
        stats.padded += maxLen * batch.length;
        stats.real += batch.reduce((sum, i) => sum + lengths[i], 0);
        stats.batches += 1;
        const probs = await model.score(batch.map(i => pairs[i]));
        batch.forEach((i, j) => { out[i] = probs[j]; });
      }
      return out;
    },
  };
}

// ─── Measure ──────────────────────────────────────────────────────────────────

const STRATEGIES = ['in-order-32', 'in-order-8', 'sorted', 'single'];
const results = {};

for (const name of configNames) {
  const cfg = CONFIGS[name];
  if (!cfg) throw new Error(`unknown config ${name}`);
  let model;
  try {
    model = await loadModel(config.NLI_MODEL_ID, 'q8', cfg);
  } catch (err) {
    console.log(`[Clarity] ${name}: model did not load (${err.message})`);
    continue;
  }
  // Untimed warm-up (WebGPU compiles its shaders on the first shapes)
  await model.score(nli.benchPairs());
  results[name] = {};
  for (const strategy of STRATEGIES) {
    const stats = { padded: 0, real: 0, batches: 0 };
    const perVersion = [];
    let pairs = 0;
    for (const v of versions) {
      const client = new nli.NliClient(strategyBackend(model, strategy, stats), Number.MAX_SAFE_INTEGER);
      const started = performance.now();
      const check = await nli.checkEntailment(v.original, v.text, [], client);
      const ms = performance.now() - started;
      pairs += check.pairs;
      const lenRatio = checker.lengthRatioOf(v.original, toPlainText(v.text));
      const { score } = checker.combinedScore(config.COMBINED_SCORE_FULL, {
        sbert: v.similarity, entity: v.entityRecall, lenRatio,
        nliMin: check.minEntailment, contra: check.maxContradiction,
      });
      perVersion.push({
        ms, pairs: check.pairs, sentences: check.sentences, nliMin: check.minEntailment,
        contra: check.maxContradiction, score, pass: score >= config.COMBINED_SCORE_FULL.threshold,
        unsupported: check.unsupportedSentences.length, contradicted: check.contradictedSentences.length,
      });
    }
    const total = perVersion.reduce((s, x) => s + x.ms, 0);
    results[name][strategy] = { total, perVersion, pairs, ...stats };
    console.log(
      `[Clarity] ${name.padEnd(6)} ${strategy.padEnd(11)} ${Math.round(total / versions.length)} ms/version, ` +
      `${pairs} pairs, ${stats.batches} batches, padded/real tokens ${stats.padded}/${stats.real} ` +
      `(${(stats.padded / stats.real).toFixed(2)}x)`,
    );
  }
}

// ─── Agreement ────────────────────────────────────────────────────────────────

function agreement(a, b) {
  let flips = 0;
  let reasonChanges = 0;
  let maxScore = 0;
  let maxNliMin = 0;
  let maxContra = 0;
  a.perVersion.forEach((x, i) => {
    const y = b.perVersion[i];
    if (x.pass !== y.pass) flips++;
    if (x.unsupported !== y.unsupported || x.contradicted !== y.contradicted) reasonChanges++;
    maxScore = Math.max(maxScore, Math.abs(x.score - y.score));
    maxNliMin = Math.max(maxNliMin, Math.abs(x.nliMin - y.nliMin));
    maxContra = Math.max(maxContra, Math.abs(x.contra - y.contra));
  });
  return { flips, reasonChanges, maxScore, maxNliMin, maxContra };
}

console.log('\n| Config | Strategy | vs | Verdict flips | Sentence-verdict changes | max |Δscore| | max |ΔnliMin| | max |Δcontra| |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [name, byStrategy] of Object.entries(results)) {
  for (const ref of ['in-order-32', 'in-order-8']) {
    for (const strategy of STRATEGIES) {
      if (strategy === ref) continue;
      const g = agreement(byStrategy[ref], byStrategy[strategy]);
      console.log(
        `| ${name} | ${strategy} | ${ref} | ${g.flips}/${versions.length} | ${g.reasonChanges} | ` +
        `${g.maxScore.toExponential(2)} | ${g.maxNliMin.toExponential(2)} | ${g.maxContra.toExponential(2)} |`,
      );
    }
  }
}
// Across backends, same strategy (does the device change any number?)
const names = Object.keys(results);
for (let i = 1; i < names.length; i++) {
  for (const strategy of STRATEGIES) {
    const g = agreement(results[names[0]][strategy], results[names[i]][strategy]);
    console.log(
      `| ${names[i]} | ${strategy} | ${names[0]} ${strategy} | ${g.flips}/${versions.length} | ${g.reasonChanges} | ` +
      `${g.maxScore.toExponential(2)} | ${g.maxNliMin.toExponential(2)} | ${g.maxContra.toExponential(2)} |`,
    );
  }
}

console.log('\n| Config | Strategy | Mean ms/version | p50 | Pairs/version | Padded/real tokens |');
console.log('|---|---|---|---|---|---|');
for (const [name, byStrategy] of Object.entries(results)) {
  for (const strategy of STRATEGIES) {
    const r = byStrategy[strategy];
    const sorted = r.perVersion.map(x => x.ms).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `| ${name} | ${strategy} | ${Math.round(r.total / versions.length)} | ${Math.round(p50)} | ` +
      `${(r.pairs / versions.length).toFixed(1)} | ${(r.padded / r.real).toFixed(2)}x |`,
    );
  }
}

if (jsonOut) {
  await writeFile(jsonOut, JSON.stringify({ versions: versions.map(v => v.source), results }, null, 1));
  console.log(`[Clarity] wrote ${jsonOut}`);
}
await vite.close();
