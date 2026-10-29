/**
 * npm run nli:perf -- [report.json …] [--configs cpu1,cpu4,webgpu] [--baseline in.json] [--json out.json]
 * — NLI time per scored version on the app's own batching (NLI_BATCH_SIZE),
 * by backend, and whether any verdict differs between backends or from a
 * saved run. Writes nothing unless --json is given; the numbers go into
 * eval/checker/NLI_PERF.md by hand.
 *
 * Design decisions:
 *  - Inputs are real scored versions: every candidate with NLI time in the
 *    given run reports (default: the committed UK fixture,
 *    eval/fixtures/runs/uk-wiki-2026-10-19.json). The original is the
 *    report's modelInput, or cleanForModel(originalText) for format 3, as
 *    the app checked it. Identical (original, text) versions are scored once.
 *  - The app's own checkEntailment and NliClient run through the Vite
 *    loader, with word-overlap premise ranking (no Ollama needed, so every
 *    configuration scores the same pairs), one fresh client per version.
 *    Hinted words are not in the reports, so no glossary exemptions apply;
 *    that changes no pair count.
 *  - Batching is the app's only: NliClient sends the uncached pairs in order
 *    in batches of NLI_BATCH_SIZE (config.ts), pinned because q8 scores
 *    depend on batch composition (NLI_PERF.md). The backend wrapper only
 *    counts padded and real tokens. The comparison strategies this script
 *    used to run (in order 32, length-sorted, one pair per call) were removed
 *    with the pin; their numbers are in eval/checker/nli-perf-before.json and
 *    the script that made them is at commit 50f401d.
 *  - Configurations: onnxruntime-node on the CPU with 1 thread (the
 *    calibration setup), with 4 threads (the extension's NLI_WASM_THREADS),
 *    and on ORT's native WebGPU EP (the C++ EP that the extension's asyncify
 *    wasm build also compiles; debug:nliDevice = 'webgpu').
 *  - Verdict agreement: the FULL combined score (frozen, config.ts) from the
 *    report's similarity and entity recall, the length ratio, and the NLI
 *    parts, compared across configurations and, with --baseline, with the
 *    same configuration of a saved --json run: its `app` results, or for a
 *    file written before the pin its in-order run at NLI_BATCH_SIZE.
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
const baselinePath = flag('--baseline');
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
console.log(
  `[Clarity] ${versions.length} scored versions from ${reportPaths.length} report(s), ` +
  `batches of ${config.NLI_BATCH_SIZE}`,
);

const baseline = baselinePath ? JSON.parse(await readFile(baselinePath, 'utf8')) : null;
if (baseline && JSON.stringify(baseline.versions) !== JSON.stringify(versions.map(v => v.source))) {
  throw new Error(`${baselinePath} scored other versions; pass the same reports in the same order`);
}

// ─── Measure ──────────────────────────────────────────────────────────────────

/** An NliBackend that scores what NliClient sends and counts padded and real tokens. */
function countingBackend(model, stats) {
  return {
    async score(pairs) {
      const lengths = model.tokenLengths(pairs).map(n => Math.min(n, 512));
      stats.padded += Math.max(...lengths) * pairs.length;
      stats.real += lengths.reduce((sum, n) => sum + n, 0);
      stats.batches += 1;
      return model.score(pairs);
    },
  };
}

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
  const stats = { padded: 0, real: 0, batches: 0 };
  const perVersion = [];
  let pairs = 0;
  for (const v of versions) {
    const client = new nli.NliClient(countingBackend(model, stats));
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
  results[name] = { app: { batchSize: config.NLI_BATCH_SIZE, total, perVersion, pairs, ...stats } };
  console.log(
    `[Clarity] ${name.padEnd(6)} ${Math.round(total / versions.length)} ms/version, ` +
    `${pairs} pairs, ${stats.batches} batches, padded/real tokens ${stats.padded}/${stats.real} ` +
    `(${(stats.padded / stats.real).toFixed(2)}x)`,
  );
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

/** A saved run's results for `name` at the app's batching (`app`, or the pre-pin in-order run). */
function baselineOf(name) {
  const saved = baseline?.results?.[name];
  return saved?.app ?? saved?.[`in-order-${config.NLI_BATCH_SIZE}`] ?? null;
}

const row = (label, vs, g) =>
  `| ${label} | ${vs} | ${g.flips}/${versions.length} | ${g.reasonChanges} | ` +
  `${g.maxScore.toExponential(2)} | ${g.maxNliMin.toExponential(2)} | ${g.maxContra.toExponential(2)} |`;

console.log('\n| Config | vs | Verdict flips | Sentence-verdict changes | max |Δscore| | max |ΔnliMin| | max |Δcontra| |');
console.log('|---|---|---|---|---|---|---|');
const names = Object.keys(results);
for (let i = 1; i < names.length; i++) {
  console.log(row(names[i], names[0], agreement(results[names[0]].app, results[names[i]].app)));
}
for (const name of names) {
  const ref = baselineOf(name);
  if (ref) console.log(row(name, `${name} in ${baselinePath}`, agreement(ref, results[name].app)));
}

const msRow = (label, r) => {
  const sorted = r.perVersion.map(x => x.ms).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  return `| ${label} | ${Math.round(r.total / versions.length)} | ${Math.round(p50)} | ` +
    `${(r.pairs / versions.length).toFixed(1)} | ${(r.padded / r.real).toFixed(2)}x |`;
};

console.log('\n| Config | Mean ms/version | p50 | Pairs/version | Padded/real tokens |');
console.log('|---|---|---|---|---|');
for (const name of names) {
  console.log(msRow(`${name} (this run, batches of ${config.NLI_BATCH_SIZE})`, results[name].app));
  // The saved run's timings, every batching it measured (another session: compare with care)
  for (const [key, r] of Object.entries(baseline?.results?.[name] ?? {})) {
    console.log(msRow(`${name} ${key} (baseline)`, r));
  }
}

if (jsonOut) {
  await writeFile(jsonOut, JSON.stringify({ versions: versions.map(v => v.source), results }, null, 1));
  console.log(`[Clarity] wrote ${jsonOut}`);
}
await vite.close();
