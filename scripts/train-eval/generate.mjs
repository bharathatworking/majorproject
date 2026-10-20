/**
 * npm run train:eval:gen — Prompt 10 Part C: the base model and
 * clarity-simplify on the pre-registered ASSET validation items, at target
 * grades 6 and 8, with the app's own prompt. Writes
 * training/out/eval_generations.jsonl (resumable); training/evaluate.py
 * scores it.
 *
 *   node scripts/train-eval/generate.mjs --select-items   # once, before PREREG: training/eval/items.json
 *   node scripts/train-eval/generate.mjs --dry-run        # render every prompt, no Ollama
 *   node scripts/train-eval/generate.mjs [--model <tag>] [--limit N] [--flags-only]
 *
 * Design decisions:
 *  - The prompt is render.ts with the app's hints ('app'): exactly what the
 *    app sends for a pasted paragraph with the default profile at that grade.
 *    Both models get the identical prompt (the prompt hash is recorded).
 *  - Sampling: temperature 0 and seed 42 for both (the app sends no
 *    temperature yet; Prompt 11 fixes it). `think` follows the app's rule
 *    (thinkSetting from /api/show).
 *  - Timing as in the bake-off: every resident model is unloaded before each
 *    model, one untimed warm-up call loads it, then wall-clock seconds per
 *    100 input words. GPU only.
 *  - Measures use the app's code: FKGL of the plain output, grade hit
 *    (|FKGL − target| ≤ 1), entities kept (detectEntities on the cleaned
 *    source, findMissingEntities on the output), near copy (the calibration
 *    rule: word edit ratio < 10% or all-minilm similarity > 0.97; the
 *    similarity is filled in a last pass, like the bake-off).
 *  - Only training/data/asset_val.jsonl is read. ASSET test and TurkCorpus
 *    are reserved for the final benchmark.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppLoader, embed, readJsonl, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const OLLAMA = 'http://localhost:11434';
const KEEP_ALIVE = '10m';
const ASSET_VAL = join(ROOT, 'training', 'data', 'asset_val.jsonl');
const ITEMS = join(ROOT, 'training', 'eval', 'items.json');
const OUT_DIR = join(ROOT, 'training', 'out');
const OUTPUTS = join(OUT_DIR, 'eval_generations.jsonl');

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const round = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(x.toFixed(d)));
const sha256 = text => createHash('sha256').update(text).digest('hex');

// ─── Ollama ───────────────────────────────────────────────────────────────────

async function api(path, body) {
  const res = await fetch(`${OLLAMA}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function unloadAll() {
  for (let i = 0; i < 60; i++) {
    const { models } = await api('/api/ps');
    if (models.length === 0) return;
    for (const m of models) await api('/api/generate', { model: m.name, keep_alive: 0 });
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('models did not unload within 30 s');
}

/** One streamed /api/chat call, like OllamaProvider. */
async function chat(model, system, user, think) {
  const started = performance.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: true,
      keep_alive: KEEP_ALIVE,
      options: { ...app.lib.EVAL_OPTIONS },
      ...(think !== undefined && { think }),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`/api/chat ${model}: HTTP ${res.status} ${await res.text()}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let final = null;
  const take = line => {
    if (!line.trim()) return;
    const json = JSON.parse(line);
    if (json.error) throw new Error(`/api/chat ${model}: ${json.error}`);
    content += json.message?.content ?? '';
    if (json.done) final = json;
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(take);
  }
  take(buffer);
  return { content, wallSeconds: (performance.now() - started) / 1000, final };
}

// ─── App ──────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
const load = path => vite.ssrLoadModule(path);
const app = {
  lib: await load('/scripts/train-eval/lib.ts'),
  render: await load('/scripts/train-data/render.ts'),
  engine: await load('/src/lib/metrics/engine.ts'),
  nodeGrade: await load('/src/lib/metrics/node-grade.ts'),
  semantic: await load('/src/lib/quality/semantic.ts'),
  similarity: await load('/src/lib/quality/similarity.ts'),
  format: await load('/src/lib/render/format-output.ts'),
  think: await load('/src/lib/llm/ollama-think.ts'),
  bakeoff: await load('/scripts/bakeoff/lib.ts'),
};
const wordSet = app.render.baseWordSet();

/** Measures of one output against its source (similarity may be null until the flag pass). */
function measure(source, entities, output, target, similarity) {
  const plainSource = app.format.toPlainText(source);
  const plain = output.trim() === '' ? '' : app.format.toPlainText(output);
  const fkglAfter = plain === '' ? null : app.engine.computeReadabilityReport(plain, wordSet).fleschKincaidGradeLevel;
  const distinct = app.lib.distinctTexts(entities.map(e => e.text));
  const missing = plain === '' ? distinct : app.semantic.findMissingEntities(entities, plain);
  const editRatio = app.bakeoff.wordEditRatio(plainSource, plain);
  return {
    fkglBefore: round(app.engine.computeReadabilityReport(plainSource, wordSet).fleschKincaidGradeLevel, 2),
    fkglAfter: round(fkglAfter, 2),
    gradeHit: app.lib.gradeHit(fkglAfter, target),
    entities: distinct,
    entitiesMissing: missing,
    entityRecall: round(app.lib.entityRecall(distinct.length, missing.length), 4),
    editRatio: round(editRatio, 4),
    similarity: round(similarity, 4),
    nearCopy: plain !== '' && app.bakeoff.isNearCopy(editRatio, similarity),
    outputWords: app.engine.countWords(plain),
  };
}

// ─── Items ────────────────────────────────────────────────────────────────────

async function readAssetVal() {
  const rows = await readJsonl(ASSET_VAL);
  if (rows.length !== 2000 || rows.some(r => !Array.isArray(r.references) || r.references.length !== 10)) {
    throw new Error('training/data/asset_val.jsonl is not ASSET validation (2000 rows x 10 references); re-run download.py');
  }
  return rows;
}

async function selectItems() {
  if (existsSync(ITEMS) && !flag('--force')) throw new Error('training/eval/items.json exists; it is pre-registered and never re-drawn (--force only before PREREG.md is committed)');
  const rows = await readAssetVal();
  const originals = rows.map(r => r.original);
  const notSimple = text => !app.nodeGrade.isAlreadySimple(text, app.lib.ELIGIBILITY_GRADE, wordSet);
  const picked = app.lib.selectItems(
    originals.length,
    r => notSimple(originals[r]),
    rs => notSimple(app.lib.itemText({ id: '', kind: 'para', rows: rs }, originals)),
  );
  const sources = JSON.parse(await readFile(join(ROOT, 'training', 'data', 'SOURCES.json'), 'utf8'));
  const items = {
    format: app.lib.ITEMS_FORMAT,
    source: `facebook/asset simplification validation @ ${sources['facebook/asset'].sha}`,
    seed: app.lib.EVAL_SEED,
    targets: app.lib.EVAL_TARGETS,
    eligibility: `isAlreadySimple(text, ${app.lib.ELIGIBILITY_GRADE}) is false (estimated grade with the base common-word list > ${app.lib.ELIGIBILITY_GRADE})`,
    ineligibleSentences: picked.ineligibleSentences,
    rejectedParagraphWindows: picked.rejectedParagraphs,
    sentences: picked.sentences.map(i => i.rows[0]),
    paragraphs: picked.paragraphs.map(i => i.rows),
  };
  mkdirSync(join(ROOT, 'training', 'eval'), { recursive: true });
  const text = JSON.stringify(items, null, 1) + '\n';
  await writeFile(ITEMS, text);
  console.log(
    `[Clarity] training/eval/items.json: ${items.sentences.length} sentences, ${items.paragraphs.length} paragraphs ` +
    `(${items.ineligibleSentences} of 2000 rows already simple at grade ${app.lib.ELIGIBILITY_GRADE}); sha256 ${sha256(text)}`,
  );
}

async function readItems(rows) {
  const items = JSON.parse(await readFile(ITEMS, 'utf8'));
  if (items.format !== app.lib.ITEMS_FORMAT) throw new Error('training/eval/items.json has an unknown format');
  const originals = rows.map(r => r.original);
  const list = [
    ...items.sentences.map(r => ({ id: app.lib.itemId('sent', [r]), kind: 'sent', rows: [r] })),
    ...items.paragraphs.map(rs => ({ id: app.lib.itemId('para', rs), kind: 'para', rows: rs })),
  ];
  return list.map(item => ({ ...item, text: app.lib.itemText(item, originals) }));
}

// ─── Flag pass ────────────────────────────────────────────────────────────────

async function flagPass(byId) {
  if (!existsSync(OUTPUTS)) return;
  const records = await readJsonl(OUTPUTS);
  let embedded = 0;
  let missing = false;
  for (const r of records) {
    const item = byId.get(r.itemId);
    let similarity = r.similarity;
    if (similarity === null && r.output.trim() !== '' && !missing) {
      const v = await embed([app.format.toPlainText(item.text), app.format.toPlainText(r.output)]);
      if (v) {
        similarity = app.similarity.cosineSimilarity(v[0], v[1]);
        embedded++;
      } else missing = true;
    }
    const rendered = app.render.renderPrompt(item.text, r.target, 'app');
    Object.assign(r, measure(item.text, rendered.entities, r.output, r.target, similarity));
  }
  if (missing) console.warn('[Clarity] all-minilm did not answer: near copies use the edit ratio only until --flags-only is re-run');
  await writeFile(OUTPUTS, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[Clarity] Flag pass: ${embedded} similarities added, ${records.length} records`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  if (flag('--select-items')) {
    await selectItems();
  } else {
    const rows = await readAssetVal();
    const items = await readItems(rows);
    const byId = new Map(items.map(i => [i.id, i]));
    const wanted = items.flatMap(item => app.lib.EVAL_TARGETS.map(target => {
      const r = app.render.renderPrompt(item.text, target, 'app');
      return { item, target, prompt: r, promptHash: sha256(`${r.system}\n\n${r.user}`) };
    }));
    console.log(`[Clarity] ${items.length} items x ${app.lib.EVAL_TARGETS.length} targets = ${wanted.length} prompts per model`);

    if (flag('--dry-run')) {
      const tiers = {};
      for (const w of wanted) tiers[w.prompt.spec.depthTier] = (tiers[w.prompt.spec.depthTier] ?? 0) + 1;
      console.log(`[Clarity] Dry run: depth tiers ${JSON.stringify(tiers)}; with a hint ${wanted.filter(w => w.prompt.hinted.length > 0).length}`);
      console.log(`[Clarity] Example (${wanted[0].item.id}, grade ${wanted[0].target}):\n--- system ---\n${wanted[0].prompt.system}\n--- user ---\n${wanted[0].prompt.user}`);
    } else if (!flag('--flags-only')) {
      const selected = option('--model') ? [option('--model')] : [...app.lib.EVAL_MODELS];
      const unknown = selected.filter(m => !app.lib.EVAL_MODELS.includes(m));
      if (unknown.length > 0) throw new Error(`not an evaluation model: ${unknown.join(', ')}`);
      const tags = (await api('/api/tags')).models;
      const absent = selected.filter(m => !tags.some(t => t.name === m || t.name === `${m}:latest`));
      if (absent.length > 0) throw new Error(`Ollama has no ${absent.join(', ')} (for clarity-simplify: ollama create clarity-simplify -f Modelfile)`);
      const { version } = await api('/api/version');
      const limit = option('--limit') ? Number(option('--limit')) : Infinity;
      mkdirSync(OUT_DIR, { recursive: true });
      const done = existsSync(OUTPUTS) ? await readJsonl(OUTPUTS) : [];

      for (const model of selected) {
        const show = await api('/api/show', { model });
        const think = app.think.thinkSetting(show);
        const tag = tags.find(t => t.name === model || t.name === `${model}:latest`);
        const pending = app.lib.pendingGenerations(
          wanted.map(w => ({ ...w, model, itemId: w.item.id })), done,
        ).slice(0, limit);
        if (pending.length === 0) {
          console.log(`[Clarity] ${model}: all done`);
          continue;
        }
        await unloadAll();
        await chat(model, pending[0].prompt.system, pending[0].prompt.user, think);
        console.log(`[Clarity] ${model}: warmed up; ${pending.length} to run`);
        for (const w of pending) {
          const out = await chat(model, w.prompt.system, w.prompt.user, think);
          const { text: output, hadThink } = app.bakeoff.stripThink(out.content);
          const inputWords = app.engine.countWords(w.item.text);
          const record = {
            model, itemId: w.item.id, kind: w.item.kind, rows: w.item.rows, target: w.target,
            promptHash: w.promptHash, depthTier: w.prompt.spec.depthTier, hinted: w.prompt.hinted,
            options: app.lib.EVAL_OPTIONS, think: think ?? null,
            raw: out.content, output, hadThink,
            wallSeconds: round(out.wallSeconds), inputWords,
            secPer100: round(app.bakeoff.secPer100Words(out.wallSeconds, inputWords)),
            outputTokens: out.final?.eval_count ?? null,
            ...measure(w.item.text, w.prompt.entities, output, w.target, null),
            ollamaVersion: version, digest: tag.digest, createdAt: new Date().toISOString(),
          };
          await appendFile(OUTPUTS, JSON.stringify(record) + '\n');
          done.push(record);
          console.log(`[Clarity] ${model} ${w.item.id} @${w.target}: FKGL ${record.fkglAfter} (${record.gradeHit ? 'hit' : 'miss'}), ${record.wallSeconds.toFixed(1)} s`);
        }
        await unloadAll();
      }
    }
    if (!flag('--dry-run')) await flagPass(byId);
  }
} catch (err) {
  console.error(`[Clarity] ${err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
