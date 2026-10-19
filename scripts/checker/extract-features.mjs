/**
 * npm run checker:extract -- --set calib|bakeoff — the 8 candidate features
 * of the combined meaning score for every item, computed by the app's own
 * code, into eval/checker/features_<set>.csv.
 *
 * Design decisions:
 *  - Same code the extension runs, through the Vite loader: detectEntities,
 *    findMissingEntities, entityVerdict, keyEntityTexts, checkEntailment and
 *    checkMainClaim with the bundled NLI model (onnxruntime-node, one
 *    thread), all-minilm via Ollama for SBERT, premise ranking and the main
 *    claim; checkerFeatures turns the parts into features.
 *  - calib: eval/nli-calibration/paragraph-items.jsonl (labels imported from
 *    labels.csv) with paragraphs.jsonl and its stored hintedWords. Real
 *    outputs that are near copies (word edit ratio < 10% or similarity >
 *    0.97, the calibrate-meaning rule) are left out; injected copies stay.
 *    Group = paragraph, so a real output and its copy share a CV fold.
 *  - bakeoff: eval/model-bakeoff/outputs.jsonl (GPU outputs that are not
 *    near copies, the rule of the bake-off REPORT.md) with paragraphs.jsonl.
 *    Hinted words are rebuilt the way the bake-off prompt built them
 *    (Student preset, findDifficultWords → hintedWords). This set NEVER
 *    reads the bake-off labels: only test-heldout.mjs does.
 *  - legacyPass is the current rule (SBERT ≥ SIMILARITY_THRESHOLD, entity
 *    rule, NLI paragraph rule) from the pure verdict.ts functions and the
 *    constants as they stand, the baseline of the fit and the test.
 *  - Cache: a row is reused when its hash, sha256(original, simplified, NLI
 *    model, embedding model, FEATURE_VERSION), is already in the CSV.
 *  - nliMs / mainClaimMs: wall time of each NLI call (Node CPU, one thread),
 *    for the latency line of the report.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppLoader, embed, embedOrThrow, loadModel, readJsonl, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const OUT_DIR = join(ROOT, 'eval', 'checker');
const EMBED_MODEL = 'all-minilm';
/** Bump when a feature's definition changes, so cached rows are recomputed. */
const FEATURE_VERSION = 1;
const PRESET_ID = 'student';

const argv = process.argv.slice(2);
const set = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : null;
if (set !== 'calib' && set !== 'bakeoff') {
  console.error('[Clarity] usage: node scripts/checker/extract-features.mjs --set calib|bakeoff');
  process.exit(1);
}
const OUT = join(OUT_DIR, `features_${set}.csv`);

// ─── Main ─────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
try {
  const load = path => vite.ssrLoadModule(path);
  const config = await load('/src/lib/quality/config.ts');
  const checker = await load('/src/lib/quality/checker.ts');
  const { checkEntailment, checkMainClaim, NliClient } = await load('/src/lib/quality/nli.ts');
  const { entityVerdict, nliVerdict } = await load('/src/lib/quality/verdict.ts');
  const { keyEntityTexts } = await load('/src/lib/quality/meaning.ts');
  const { mainClaimIndexes, splitSentences } = await load('/src/lib/quality/premises.ts');
  const { findMissingEntities } = await load('/src/lib/quality/semantic.ts');
  const { cosineSimilarity } = await load('/src/lib/quality/similarity.ts');
  const { detectEntities } = await load('/src/lib/segmentation/ner.ts');
  const { toPlainText } = await load('/src/lib/render/format-output.ts');
  const { sha256 } = await load('/src/lib/utils/hash.ts');
  const bakeoff = await load('/scripts/bakeoff/lib.ts');
  const { toPlainCsv, parsePlainCsv } = await load('/scripts/checker/lib.ts');

  if ((await embed(['probe'])) === null) throw new Error('Ollama with all-minilm is needed (ollama pull all-minilm)');

  // ── Items of the set: { id, group, model, original, simplified, hinted, label? }
  let items;
  if (set === 'calib') {
    const dir = join(ROOT, 'eval', 'nli-calibration');
    const paragraphs = new Map((await readJsonl(join(dir, 'paragraphs.jsonl'))).map(p => [p.id, p]));
    const all = (await readJsonl(join(dir, 'paragraph-items.jsonl'))).filter(i => !i.excluded && (i.label ?? i.proposedLabel));
    items = all.map(i => ({
      id: i.id, group: i.paragraphId, model: i.origin === 'injected' ? 'injected' : i.origin,
      origin: i.origin, original: paragraphs.get(i.paragraphId).text, simplified: i.simplified,
      hinted: paragraphs.get(i.paragraphId).hintedWords ?? [], label: i.label ?? i.proposedLabel,
    }));
  } else {
    const dir = join(ROOT, 'eval', 'model-bakeoff');
    const paragraphs = new Map((await readJsonl(join(dir, 'paragraphs.jsonl'))).map(p => [p.id, p]));
    const outputs = (await readJsonl(join(dir, 'outputs.jsonl'))).filter(o => o.mode === 'gpu' && !o.flags.nearCopy);
    // Hinted words as the bake-off prompt named them (scripts/bakeoff/app.mjs prepare)
    const engine = await load('/src/lib/metrics/engine.ts');
    const common = await load('/src/lib/metrics/common-words.ts');
    const difficult = await load('/src/lib/metrics/difficult-words.ts');
    const resolver = await load('/src/lib/profile/resolver.ts');
    const builder = await load('/src/lib/prompt-builder/builder.ts');
    const presets = await load('/src/lib/profile/presets.ts');
    const wordSet = new Set(common.BASE_COMMON_WORDS);
    const profile = presets.getPreset(PRESET_ID).profile;
    const hintedFor = text => {
      const report = engine.computeReadabilityReport(text, wordSet);
      const spec = resolver.resolveProfile(profile, report.estimatedGradeLevel);
      return builder.hintedWords(spec, difficult.findDifficultWords(text, detectEntities(text), wordSet));
    };
    items = outputs.map(o => ({
      id: `${o.model}|${o.paragraphId}`, group: o.paragraphId, model: o.model, origin: o.model,
      original: paragraphs.get(o.paragraphId).text, simplified: o.cleaned,
      hinted: hintedFor(paragraphs.get(o.paragraphId).text),
    }));
  }

  // ── Cache
  const cached = new Map();
  if (existsSync(OUT)) for (const row of parsePlainCsv(await readFile(OUT, 'utf8'))) cached.set(row.hash, row);

  const { score } = await loadModel(config.NLI_MODEL_ID);
  const client = new NliClient({ score: pairs => score(pairs) });
  const rows = [];
  const excluded = [];
  let reused = 0;
  for (const item of items) {
    const hash = await sha256(`${item.original}\u0000${item.simplified}\u0000${config.NLI_MODEL_ID}\u0000${EMBED_MODEL}\u0000${FEATURE_VERSION}`);
    const plain = toPlainText(item.simplified);
    const hit = cached.get(hash);
    if (hit) {
      reused++;
      rows.push({ ...hit, id: item.id, group: item.group, model: item.model, ...(item.label && { label: item.label }) });
      continue;
    }
    const [a, b] = await embedOrThrow([item.original, plain]);
    const similarity = cosineSimilarity(a, b);
    // Near copies (calib real outputs; the bake-off outputs were filtered by their flag)
    if (set === 'calib' && item.origin !== 'injected'
      && bakeoff.isNearCopy(bakeoff.wordEditRatio(toPlainText(item.original), plain), similarity)) {
      excluded.push(item.id);
      continue;
    }
    const entities = detectEntities(item.original);
    const missing = findMissingEntities(entities, plain);
    const sentences = splitSentences(item.original);
    let claim = mainClaimIndexes(sentences.length);
    if (sentences.length > 2) {
      const [paragraph, ...vecs] = await embedOrThrow([item.original, ...sentences]);
      claim = mainClaimIndexes(sentences.length, { sentences: vecs, paragraph });
    }
    const keyTexts = keyEntityTexts(item.original, entities, claim, sentences);
    const entity = entityVerdict({ entityTexts: entities.map(e => e.text), missing, keyTexts });
    const nli = await checkEntailment(item.original, item.simplified, item.hinted, client, { embed: embedOrThrow });
    const main = await checkMainClaim(item.original, item.simplified, claim, client, { embed: embedOrThrow });
    const missingSet = new Set(missing);
    const keyKept = keyTexts.length ? keyTexts.filter(t => !missingSet.has(t)).length / keyTexts.length : 1;
    const f = checker.checkerFeatures({
      similarity,
      entityRecall: entity.recall,
      nli,
      mainClaimEntailment: main.entailment,
      keyKept,
      lengthRatio: checker.lengthRatioOf(item.original, plain),
    });
    const legacyPass = similarity >= config.SIMILARITY_THRESHOLD && entity.passed && nliVerdict(nli.sentenceScores).passed;
    rows.push({
      id: item.id, group: item.group, model: item.model, ...(item.label && { label: item.label }), hash,
      ...Object.fromEntries(checker.FEATURES.map(k => [k, f[k].toFixed(6)])),
      legacyPass: legacyPass ? 1 : 0,
      sentences: nli.sentences, nliPairs: nli.pairs, mainClaimPairs: main.pairs,
      nliMs: nli.ms.toFixed(1), mainClaimMs: main.ms.toFixed(1),
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  // Cached calib rows that are near copies are never written, so they come back as excluded each run
  const kept = new Set(rows.map(r => r.id));
  for (const item of items) if (!kept.has(item.id) && !excluded.includes(item.id)) excluded.push(item.id);

  const header = ['id', 'group', 'model', ...(set === 'calib' ? ['label'] : []), 'hash', ...checker.FEATURES,
    'legacyPass', 'sentences', 'nliPairs', 'mainClaimPairs', 'nliMs', 'mainClaimMs'];
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT, toPlainCsv(header, rows.map(r => header.map(h => r[h] ?? ''))));

  const by = (k, v) => rows.filter(r => r[k] === v).length;
  console.log(`[Clarity] ${set}: ${rows.length} items written to ${OUT} (${reused} from cache)`);
  if (set === 'calib') {
    console.log(`[Clarity] calib: ${by('label', 'faithful')} faithful / ${by('label', 'unfaithful')} unfaithful; near copies excluded: ${excluded.length} (${excluded.join(', ')})`);
  } else {
    for (const m of [...new Set(rows.map(r => r.model))]) console.log(`[Clarity] bakeoff ${m}: ${by('model', m)} items`);
  }
} catch (err) {
  console.error(`[Clarity] ${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
