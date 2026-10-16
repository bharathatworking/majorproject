/**
 * npm run bakeoff:run — generates one first-try simplification per model ×
 * paragraph for the base-model bake-off and records timing, memory,
 * readability and flags in eval/model-bakeoff/outputs.jsonl.
 *
 *   node scripts/bakeoff/run.mjs [--model <tag>] [--gpu-only | --cpu-only] [--limit N] [--flags-only]
 *
 * Design decisions:
 *  - The app's exact prompt (app.mjs: Student preset, grade 8, buildPrompt
 *    'standard'), streamed from /api/chat like OllamaProvider. One attempt:
 *    no meaning retry, no best-of-N, no meaning check in the loop.
 *  - Sampling as in the app: the app sends no temperature, so each model
 *    uses its Modelfile default (read from /api/show and recorded). Only
 *    options.seed = 42 is added, plus num_gpu = 0 for the CPU-only runs.
 *    think: false is sent only to models whose /api/show capabilities list
 *    'thinking'; <think> blocks are stripped and counted either way.
 *  - Timing: every loaded model (all-minilm included) is unloaded with
 *    keep_alive: 0 before each model and mode, one untimed warm-up call
 *    loads it, and /api/ps then gives its RAM/VRAM size (the file size from
 *    /api/tags is kept too, as diskSize). Seconds per 100
 *    input words use the wall-clock time of the whole call.
 *  - GPU mode runs all 40 paragraphs, CPU-only mode the 10 `cpuSubset`
 *    ones (num_gpu = 0 simulates a PC without a GPU; RAM is not limited).
 *  - Resumable: each output is appended as soon as it is done, and
 *    pendingPairs (lib.ts) skips pairs already in outputs.jsonl. A changed
 *    prompt for a done pair stops the run instead of mixing prompts.
 *  - The flag pass runs last: all-minilm similarity of original and output
 *    (plain text) completes the near-copy flag, and every record's measures
 *    and flags are recomputed, so a flag fix applies with --flags-only. Without all-minilm the
 *    similarity stays null and only the edit-ratio half of the rule applies.
 *  - Model tags are exact; a missing tag stops the run (never substituted).
 */

import { existsSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { embed, readJsonl } from '../lib/nli-node.mjs';
import { OUTPUTS, PARAGRAPHS, PRESET_ID, openApp } from './app.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const OLLAMA = 'http://localhost:11434';
const KEEP_ALIVE = '10m';

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

// ─── Ollama ───────────────────────────────────────────────────────────────────

async function api(path, body) {
  const res = await fetch(`${OLLAMA}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** Unloads every resident model and waits until /api/ps is empty. */
async function unloadAll() {
  for (let i = 0; i < 60; i++) {
    const { models } = await api('/api/ps');
    if (models.length === 0) return;
    for (const m of models) await api('/api/generate', { model: m.name, keep_alive: 0 });
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('models did not unload within 30 s');
}

/** Capabilities and the Modelfile's default temperature of a model. */
async function modelInfo(model) {
  const show = await api('/api/show', { model });
  const params = Object.fromEntries(
    (show.parameters ?? '').split('\n').map(l => l.trim().split(/\s+/)).filter(p => p.length >= 2).map(([k, v]) => [k, v]),
  );
  return {
    thinking: (show.capabilities ?? []).includes('thinking'),
    defaultTemperature: params.temperature !== undefined ? Number(params.temperature) : null,
    details: show.details ?? null,
  };
}

/** One streamed /api/chat call; the final NDJSON line carries Ollama's timing stats. */
async function chat(model, system, user, options, think) {
  const started = performance.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: true,
      keep_alive: KEEP_ALIVE,
      options,
      ...(think !== undefined && { think }),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`/api/chat ${model}: HTTP ${res.status} ${await res.text()}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  let final = null;
  const take = line => {
    if (!line.trim()) return;
    const json = JSON.parse(line);
    if (json.error) throw new Error(`/api/chat ${model}: ${json.error}`);
    content += json.message?.content ?? '';
    thinking += json.message?.thinking ?? '';
    if (json.done) final = json;
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(take);
  }
  take(buffer);
  return { content, thinking, wallSeconds: (performance.now() - started) / 1000, final };
}

// ─── Records ──────────────────────────────────────────────────────────────────

const round = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(x.toFixed(d)));

/** Readability, length, edit ratio and flags of one output (similarity may still be null). */
function measure(app, paragraph, cleaned, similarity) {
  const before = app.metrics(paragraph.text);
  const empty = cleaned.trim() === '';
  const after = empty ? null : app.metrics(cleaned);
  const outputWords = after?.words ?? 0;
  const lengthRatio = outputWords / before.words;
  const editRatio = app.lib.wordEditRatio(app.toPlainText(paragraph.text), app.toPlainText(cleaned));
  const originalListItems = app.listItems(paragraph.text);
  const outputListItems = empty ? 0 : app.listItems(cleaned);
  return {
    inputWords: before.words,
    outputWords,
    lengthRatio: round(lengthRatio),
    fkglBefore: round(before.fkgl, 2),
    fkglAfter: round(after?.fkgl ?? null, 2),
    gradeBefore: round(before.grade, 2),
    gradeAfter: round(after?.grade ?? null, 2),
    editRatio: round(editRatio),
    similarity: round(similarity, 4),
    originalListItems,
    outputListItems,
    flags: app.lib.outputFlags({
      output: cleaned, originalListItems, outputListItems, lengthRatio, editRatio, similarity, isEnglishWord: app.isEnglishWord,
    }),
  };
}

// ─── Flag pass ────────────────────────────────────────────────────────────────

/** Embeds original and output where the similarity is missing, then recomputes every record's measures and flags. */
async function flagPass(app, paragraphs) {
  if (!existsSync(OUTPUTS)) return;
  const records = await readJsonl(OUTPUTS);
  let embedded = 0;
  let missing = false;
  for (const r of records) {
    const p = paragraphs.get(r.paragraphId);
    let similarity = r.similarity;
    if (similarity === null && r.cleaned.trim() !== '' && !missing) {
      const vectors = await embed([app.toPlainText(p.text), app.toPlainText(r.cleaned)]);
      if (vectors) {
        similarity = app.cosineSimilarity(vectors[0], vectors[1]);
        embedded++;
      } else missing = true;
    }
    Object.assign(r, measure(app, p, r.cleaned, similarity));
  }
  if (missing) console.warn('[Clarity] all-minilm did not answer: near copies use the edit ratio only until the flag pass is re-run');
  await writeFile(OUTPUTS, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const gpu = records.filter(r => r.mode === 'gpu');
  const count = name => gpu.filter(r => r.flags[name]).length;
  console.log(
    `[Clarity] Flag pass: ${embedded} similarities added; ${records.length} records ` +
    `(${gpu.length} GPU, ${records.length - gpu.length} CPU). GPU flags over all models: ` +
    `${count('empty')} empty, ${count('refusal')} refusal, ${count('nonEnglish')} non-English, ${count('listLost')} list lost, ` +
    `${count('nearCopy')} near copy, ${count('lengthOutOfRange')} length out of range; ` +
    `${records.filter(r => r.hadThink).length} outputs had a think block`,
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const app = await openApp();
try {
  const list = await readJsonl(PARAGRAPHS);
  const paragraphs = new Map(list.map(p => [p.id, p]));

  if (!flag('--flags-only')) {
    const { BAKEOFF_MODELS, GENERATION_SEED, pendingPairs } = app.lib;
    const selected = option('--model') ? [option('--model')] : [...BAKEOFF_MODELS];
    const unknown = selected.filter(m => !BAKEOFF_MODELS.includes(m));
    if (unknown.length > 0) throw new Error(`not a bake-off model: ${unknown.join(', ')}`);
    const tags = (await api('/api/tags')).models;
    const missing = selected.filter(m => !tags.some(t => t.name === m));
    if (missing.length > 0) throw new Error(`Ollama has no ${missing.join(', ')}: run ollama pull (no substitutes)`);
    const { version } = await api('/api/version');
    const modes = flag('--gpu-only') ? ['gpu'] : flag('--cpu-only') ? ['cpu'] : ['gpu', 'cpu'];
    const limit = option('--limit') ? Number(option('--limit')) : Infinity;

    // The app's prompt for every paragraph (identical for every model)
    const prompts = new Map();
    for (const p of list) {
      const prepared = await app.prepare(p.text);
      if (prepared.alreadySimple) throw new Error(`${p.id} would be skipped as already simple; run npm run bakeoff:check`);
      prompts.set(p.id, prepared);
    }

    const done = existsSync(OUTPUTS) ? await readJsonl(OUTPUTS) : [];
    for (const model of selected) {
      const info = await modelInfo(model);
      const think = info.thinking ? false : undefined;
      const { digest, size: diskSize } = tags.find(t => t.name === model);
      for (const mode of modes) {
        const subset = list.filter(p => mode === 'gpu' || p.cpuSubset).slice(0, limit);
        const wanted = subset.map(p => ({ model, mode, paragraphId: p.id, promptHash: prompts.get(p.id).promptHash }));
        const pending = pendingPairs(wanted, done);
        if (pending.length === 0) {
          console.log(`[Clarity] ${model} ${mode}: all ${wanted.length} done`);
          continue;
        }
        const options = { seed: GENERATION_SEED, ...(mode === 'cpu' && { num_gpu: 0 }) };
        await unloadAll();
        const warm = prompts.get(subset[0].id);
        await chat(model, warm.system, warm.user, options, think);
        const ps = (await api('/api/ps')).models.find(m => m.name === model);
        const memory = ps ? { size: ps.size, sizeVram: ps.size_vram } : null;
        console.log(
          `[Clarity] ${model} ${mode}: warmed up (${memory ? `${(memory.size / 2 ** 30).toFixed(2)} GiB, ` +
          `${(memory.sizeVram / 2 ** 30).toFixed(2)} GiB in VRAM` : 'not in /api/ps'}); ${pending.length} to run`,
        );

        for (const pair of pending) {
          const p = paragraphs.get(pair.paragraphId);
          const prompt = prompts.get(p.id);
          const out = await chat(model, prompt.system, prompt.user, options, think);
          const { text: cleaned, hadThink } = app.lib.stripThink(out.content);
          const f = out.final ?? {};
          const record = {
            model, mode, paragraphId: p.id, promptHash: prompt.promptHash,
            preset: PRESET_ID, targetGrade: prompt.spec.targetGrade, depthTier: prompt.spec.depthTier,
            options, think: think ?? null, defaultTemperature: info.defaultTemperature,
            raw: out.content, thinking: out.thinking || null, cleaned, hadThink: hadThink || out.thinking.trim() !== '',
            wallSeconds: round(out.wallSeconds), totalSeconds: round((f.total_duration ?? 0) / 1e9),
            loadSeconds: round((f.load_duration ?? 0) / 1e9), promptTokens: f.prompt_eval_count ?? null,
            outputTokens: f.eval_count ?? null, evalSeconds: round((f.eval_duration ?? 0) / 1e9),
            secPer100: round(app.lib.secPer100Words(out.wallSeconds, p.words)),
            memory, diskSize,
            ...measure(app, p, cleaned, null),
            ollamaVersion: version, digest, createdAt: new Date().toISOString(),
          };
          await appendFile(OUTPUTS, JSON.stringify(record) + '\n');
          done.push(record);
          console.log(`[Clarity] ${model} ${mode} ${p.id}: ${record.wallSeconds.toFixed(1)} s (${record.secPer100.toFixed(2)} s/100 words)`);
        }
      }
      await unloadAll();
    }
  }

  await flagPass(app, paragraphs);
} catch (err) {
  console.error(`[Clarity] ${err.message}`);
  process.exitCode = 1;
} finally {
  await app.close();
}
