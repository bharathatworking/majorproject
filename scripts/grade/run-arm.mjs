/**
 * npm run grade:run — Prompt 11 grade-targeting evaluation
 * (eval/grade-targeting/PREREG.md): draws the frozen item set once, then
 * runs one arm over it against local Ollama.
 *
 *   node scripts/grade/run-arm.mjs --select-items [--force]   # once: eval/grade-targeting/items.jsonl
 *   node scripts/grade/run-arm.mjs --arm A [--limit N]        # A now; B and C after Prompt 11
 *
 * Design decisions:
 *  - Items come only from training/data/asset_val.jsonl, minus every row of
 *    the Prompt 10 items (training/eval/items.json). turk_val.jsonl is never
 *    read: it has the same 2,000 sources and CLAUDE.md reserves it. Rows and
 *    joined windows are dropped when the Prompt 10 8-gram matcher
 *    (reservedHits, containment ≥ 0.5 either way) finds them in a reserved
 *    set: ASSET/TurkCorpus test, the NLI calibration, the bake-off, the
 *    fixtures (all from reserved.jsonl), the Prompt 10 item texts and the
 *    UK Wikipedia fixture read directly. The asset-val and turk-val entries of
 *    reserved.jsonl are skipped (they are the pool itself).
 *  - Eligibility uses the app's code: isAlreadySimple(text, target) false,
 *    and sentences need shouldCheckNode's 8 words, so every item is
 *    meaning-checked.
 *  - Arm A is the app's per-node path (simplify.ts generate() with extra
 *    quality off, Full quality mode) for one pasted paragraph: renderPrompt
 *    (buildPrompt 'standard', the app's hints, no rolling context), one
 *    streamed call, the <think> strip, flattenLists for a plain-style
 *    paragraph, assessMeaning with echoGuard, the one meaning retry
 *    (shouldRetry, buildRetryInstruction(retryInputOf(…))), pickBetterVersion
 *    and the echo-strip last resort. Only the call itself is ours, because
 *    OllamaProvider sends no temperature: options are EVAL_OPTIONS
 *    (temperature 0, seed 42) and `think` follows thinkSetting.
 *  - The meaning checks run like replay-meaning.mjs: SBERT through
 *    checkMeaning with all-minilm, NLI through checkEntailment with the
 *    bundled model on onnxruntime-node (NliClient), main claim through
 *    mainClaimIndexes. A missing NLI model or all-minilm stops the run before
 *    the first item (no Lite fallback); a single failed check for one item
 *    counts it as not fully checked, as in the app.
 *  - Measures use the app's code: FKGL of toPlainText(output), entities via
 *    detectEntities + findMissingEntities (train-eval lib), the word edit
 *    ratio from the bake-off lib.
 *  - Any Ollama error stops the run; the item is not recorded and a rerun
 *    resumes there (temperature 0, so the redo is the same request). Records
 *    are appended as each item finishes, keyed by arm, item and prompt hash.
 *  - --limit N is a smoke test: it writes to runs/smoke/ (git-ignored),
 *    never to the pre-registered runs/arm-<X>.jsonl.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppLoader, embed, embedOrThrow, loadModel, readJsonl, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const OLLAMA = 'http://localhost:11434';
const KEEP_ALIVE = '10m';
const EMBED_MODEL = 'all-minilm';
const DATA = join(ROOT, 'training', 'data');
const ASSET_VAL = join(DATA, 'asset_val.jsonl');
const RESERVED = join(DATA, 'reserved.jsonl');
const P10_ITEMS = join(ROOT, 'training', 'eval', 'items.json');
const UK_FIXTURE = join(ROOT, 'eval', 'fixtures', 'uk-wiki-paste.txt');
const DIR = join(ROOT, 'eval', 'grade-targeting');
const ITEMS = join(DIR, 'items.jsonl');
/** reserved.jsonl sources that are reserved sets (asset-val / turk-val are the pool's own sources). */
const RESERVED_SOURCES = ['asset-test', 'turk-test', 'nli-calibration', 'model-bakeoff', 'fixtures'];

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const round = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(x.toFixed(d)));
const sha256 = text => createHash('sha256').update(text).digest('hex');

// ─── App ──────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
const load = path => vite.ssrLoadModule(path);
// Loaded one at a time: parallel ssrLoadModule calls can time out Vite's transport
const modules = [];
for (const path of [
  '/scripts/grade/lib.ts',
  '/scripts/train-eval/lib.ts',
  '/scripts/train-data/lib.ts',
  '/scripts/train-data/render.ts',
  '/src/lib/metrics/engine.ts',
  '/src/lib/metrics/node-grade.ts',
  '/src/lib/quality/semantic.ts',
  '/src/lib/quality/meaning.ts',
  '/src/lib/quality/nli.ts',
  '/src/lib/quality/premises.ts',
  '/src/lib/quality/echo.ts',
  '/src/lib/render/format-output.ts',
  '/src/lib/llm/ollama-think.ts',
  '/scripts/bakeoff/lib.ts',
  '/src/lib/quality/config.ts',
]) modules.push(await load(path));
const [lib, evalLib, trainLib, render, engine, nodeGrade, semantic, meaning, nli, premises, echo, format, think, bakeoff, config] = modules;
const wordSet = render.baseWordSet();

/** Readability of a text as the app measures it (list markers stripped). */
function readability(text) {
  const report = engine.computeReadabilityReport(format.toPlainText(text), wordSet);
  return { fkgl: report.fleschKincaidGradeLevel, grade: report.estimatedGradeLevel };
}

// ─── Items ────────────────────────────────────────────────────────────────────

async function readAssetVal() {
  const rows = await readJsonl(ASSET_VAL);
  if (rows.length !== 2000 || rows.some(r => typeof r.original !== 'string')) {
    throw new Error('training/data/asset_val.jsonl is not ASSET validation (2000 rows); re-run training/prepare/download.py');
  }
  return rows.map(r => r.original);
}

/** Row indexes of the Prompt 10 items, sorted. */
async function prompt10Rows() {
  const p10 = JSON.parse(await readFile(P10_ITEMS, 'utf8'));
  return {
    sentences: [...p10.sentences].sort((a, b) => a - b),
    paragraphs: p10.paragraphs.map(rs => [...rs]),
    all: [...new Set([...p10.sentences, ...p10.paragraphs.flat()])].sort((a, b) => a - b),
  };
}

async function selectItems() {
  if (existsSync(ITEMS) && !flag('--force')) {
    throw new Error('eval/grade-targeting/items.jsonl exists; it is pre-registered and never re-drawn (--force only to check that a redraw is byte-identical)');
  }
  const originals = await readAssetVal();
  const p10 = await prompt10Rows();
  const p10Set = new Set(p10.all);

  // Reserved texts for the 8-gram matcher
  const reserved = (await readJsonl(RESERVED)).filter(r => RESERVED_SOURCES.includes(r.source));
  const p10Texts = [
    ...p10.sentences.map(r => originals[r]),
    ...p10.paragraphs.map(rs => evalLib.itemText({ id: '', kind: 'para', rows: rs }, originals)),
  ].map(text => ({ source: 'prompt10-eval', text }));
  const ukTexts = (await readFile(UK_FIXTURE, 'utf8')).split(/\r?\n\s*\r?\n/).map(t => t.trim()).filter(Boolean)
    .map(text => ({ source: 'uk-wiki-fixture', text }));
  const index = trainLib.buildReservedIndex([...reserved, ...p10Texts, ...ukTexts]);
  const reservedCounts = {};
  for (const r of [...reserved, ...p10Texts, ...ukTexts]) reservedCounts[r.source] = (reservedCounts[r.source] ?? 0) + 1;

  // Pool: not a Prompt 10 row, no overlap with a reserved text
  const rowHits = originals.map((text, row) => (p10Set.has(row) ? [] : trainLib.reservedHits(index, text)));
  const inPool = row => !p10Set.has(row) && rowHits[row].length === 0;
  const overlapBySource = {};
  rowHits.forEach(hits => hits.forEach(s => { overlapBySource[s] = (overlapBySource[s] ?? 0) + 1; }));
  const poolSize = originals.filter((_, r) => inPool(r)).length;
  const wordsOf = text => text.trim().split(/\s+/).filter(Boolean).length;
  const shortRows = originals.filter((t, r) => inPool(r) && wordsOf(t) < lib.MIN_ITEM_WORDS).length;

  const textOf = rows => evalLib.itemText({ id: '', kind: rows.length === 1 ? 'sent' : 'para', rows }, originals);
  const picked = lib.selectGradeItems({
    rowCount: originals.length,
    inPool,
    sentenceLongEnough: row => wordsOf(originals[row]) >= lib.MIN_ITEM_WORDS,
    windowOverlaps: rows => trainLib.reservedHits(index, textOf(rows)).length > 0,
    alreadySimple: (rows, target) => nodeGrade.isAlreadySimple(textOf(rows), target, wordSet),
  });

  const items = picked.items.map(d => {
    const text = textOf(d.rows);
    const r = readability(text);
    return { ...d, text, sha256: sha256(text), fkgl: round(r.fkgl, 2), estimatedGrade: round(r.grade, 2) };
  });
  const buckets = {};
  for (const t of lib.GRADE_TARGETS) {
    buckets[t] = {
      sentences: items.filter(i => i.target === t && i.kind === 'sent').length,
      paragraphs: items.filter(i => i.target === t && i.kind === 'para').length,
    };
  }
  const sources = JSON.parse(await readFile(join(DATA, 'SOURCES.json'), 'utf8'));
  const header = {
    format: lib.ITEMS_FORMAT,
    source: `facebook/asset simplification validation @ ${sources['facebook/asset'].sha} (training/data/asset_val.jsonl)`,
    licence: 'CC BY-NC 4.0 (ASSET); non-commercial academic use only; see training/DATA_LICENSES.md',
    seed: lib.GRADE_SEED,
    targets: lib.GRADE_TARGETS,
    fillOrder: lib.FILL_ORDER,
    perTarget: { sentences: lib.SENTENCES_PER_TARGET, paragraphs: lib.PARAGRAPHS_PER_TARGET },
    paragraphRows: [lib.PARA_MIN_ROWS, lib.PARA_MAX_ROWS],
    provenance: {
      assetValidationRows: originals.length,
      prompt10RowsExcluded: p10.all.length,
      overlapRowsExcluded: rowHits.filter(h => h.length > 0).length,
      overlapRowsBySource: overlapBySource,
      reservedTextsChecked: reservedCounts,
      poolSize,
      poolRowsUnder8Words: shortRows,
      alreadySimpleSentencesRejected: picked.alreadySimpleSentences,
      alreadySimpleParagraphsRejected: picked.alreadySimpleParagraphs,
      overlappingWindowsRejected: picked.overlappingWindows,
      rowsUsed: items.reduce((n, i) => n + i.rows.length, 0),
    },
    buckets,
    dedupe: `normaliseForDedupe + reservedHits (scripts/train-data/lib.ts): exact match or ${trainLib.DEDUPE_NGRAM}-gram containment >= ${trainLib.DEDUPE_OVERLAP_MIN} either way`,
    eligibility: `isAlreadySimple(text, target) false with the base common-word list; sentences >= ${lib.MIN_ITEM_WORDS} words`,
  };
  mkdirSync(DIR, { recursive: true });
  const text = [JSON.stringify({ header }), ...items.map(i => JSON.stringify(i))].join('\n') + '\n';
  await writeFile(ITEMS, text);
  console.log(`[Clarity] eval/grade-targeting/items.jsonl: ${items.length} items; sha256 ${sha256(text)}`);
  console.log(`[Clarity] Provenance: ${JSON.stringify(header.provenance)}`);
  console.log(`[Clarity] Buckets: ${JSON.stringify(buckets)}`);
}

async function readItems() {
  const [first, ...items] = await readJsonl(ITEMS);
  if (first?.header?.format !== lib.ITEMS_FORMAT) throw new Error('eval/grade-targeting/items.jsonl has an unknown format');
  for (const i of items) {
    if (sha256(i.text) !== i.sha256) throw new Error(`item ${i.id}: text does not match its sha256`);
  }
  return items;
}

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

/** One streamed /api/chat call, like OllamaProvider plus EVAL_OPTIONS. */
async function chat(system, user, thinkValue) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: lib.GRADE_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: true,
      keep_alive: KEEP_ALIVE,
      options: { ...lib.EVAL_OPTIONS },
      ...(thinkValue !== undefined && { think: thinkValue }),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`/api/chat: HTTP ${res.status} ${await res.text()}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const take = line => {
    if (!line.trim()) return;
    const json = JSON.parse(line);
    if (json.error) throw new Error(`/api/chat: ${json.error}`);
    content += json.message?.content ?? '';
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(take);
  }
  take(buffer);
  // simplify.ts stripThinkingArtifacts
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ─── Arm A ────────────────────────────────────────────────────────────────────

/**
 * The app's per-node path for one item (see file header). Returns the kept
 * version, every candidate and the number of model calls.
 */
async function runArmA(item, prompt, client, thinkValue) {
  const node = { id: 'n0', type: 'paragraph', text: prompt.modelText, entities: prompt.entities };
  const hinted = prompt.hinted;
  const checked = semantic.shouldCheckNode(node);
  const flatten = !prompt.spec.allowBullets;
  const shape = text => (flatten ? format.flattenLists(text) : text);
  let calls = 0;

  const assess = text => meaning.assessMeaning(node.text, text, node.entities, hinted, {
    similarity: async (original, plain) => {
      try {
        return (await semantic.checkMeaning(original, plain, embedOrThrow)).similarity;
      } catch (err) {
        console.warn(`[Clarity] Similarity check failed for ${item.id}`, err.message);
        return null;
      }
    },
    entail: async (original, simplified, words) => {
      try {
        return await nli.checkEntailment(original, simplified, words, client, { label: item.id, embed: embedOrThrow });
      } catch (err) {
        console.warn(`[Clarity] NLI check failed for ${item.id}`, err.message);
        return null;
      }
    },
    mainClaim: async (original, sentences) => {
      if (sentences.length <= 2) return null;
      try {
        const [paragraph, ...vecs] = await embedOrThrow([original, ...sentences]);
        return premises.mainClaimIndexes(sentences.length, { sentences: vecs, paragraph });
      } catch {
        return null;
      }
    },
    mainClaimEntailment: async (original, simplified, claim) => {
      try {
        return await nli.checkMainClaim(original, simplified, claim, client, { label: item.id, embed: embedOrThrow });
      } catch {
        return null;
      }
    },
  }, { echoGuard: true });

  async function attempt(retryFrom) {
    if (calls >= config.MAX_MODEL_CALLS_PER_NODE) throw new Error(`model call limit reached for ${item.id}`);
    calls++;
    const user = retryFrom === null
      ? prompt.user
      : `${meaning.buildRetryInstruction(meaning.retryInputOf(retryFrom))}\n\n${prompt.user}`;
    const text = shape(await chat(prompt.system, user, thinkValue));
    return { text, meaning: checked ? await assess(text) : null, retry: retryFrom !== null };
  }

  const first = await attempt(null);
  const tried = [first];
  let chosen = first;
  if (checked && !meaning.candidatePasses(first) && first.meaning && meaning.shouldRetry(first.meaning)) {
    const retry = await attempt(first.meaning);
    tried.push(retry);
    chosen = meaning.pickBetterVersion(first, retry);
  }
  if (chosen.meaning?.echo) {
    const ctx = { original: node.text, entities: node.entities };
    const stripped = echo.stripEchoLines(chosen.text, ctx);
    const finding = echo.findEcho(stripped, ctx);
    if (stripped !== '' && stripped !== chosen.text && finding.lines.length === 0 && !finding.instruction) {
      const cleaned = { text: stripped, meaning: await assess(stripped), retry: chosen.retry, echoStripped: true };
      tried.push(cleaned);
      chosen = cleaned;
    }
  }
  return { chosen, tried, calls };
}

const ARM_RUNNERS = { A: runArmA };

// ─── Measures ─────────────────────────────────────────────────────────────────

/** The pre-registered measures of one kept output (PREREG.md "Definitions"). */
function measure(item, prompt, output) {
  const plainSource = format.toPlainText(prompt.modelText);
  const plain = output.trim() === '' ? '' : format.toPlainText(output);
  const fkglAfter = plain === '' ? null : engine.computeReadabilityReport(plain, wordSet).fleschKincaidGradeLevel;
  const distinct = evalLib.distinctTexts(prompt.entities.map(e => e.text));
  const missing = plain === '' ? distinct : semantic.findMissingEntities(prompt.entities, plain);
  const editRatio = bakeoff.wordEditRatio(plainSource, plain);
  return {
    fkglBefore: round(engine.computeReadabilityReport(plainSource, wordSet).fleschKincaidGradeLevel, 2),
    fkglAfter: round(fkglAfter, 2),
    gradeHit: evalLib.gradeHit(fkglAfter, item.target),
    editRatio: round(editRatio, 4),
    nearCopy: plain !== '' && lib.isNearCopyEdit(editRatio),
    entities: distinct,
    entitiesMissing: missing,
    entityRecall: round(evalLib.entityRecall(distinct.length, missing.length), 4),
    outputWords: engine.countWords(plain),
  };
}

const candidateLog = c => ({
  text: c.text,
  retry: c.retry,
  ...(c.echoStripped && { echoStripped: true }),
  passed: c.meaning ? c.meaning.passed : null,
  score: round(c.meaning?.score ?? null, 4),
  similarity: round(c.meaning?.similarity ?? null, 4),
  nliChecked: c.meaning?.nliChecked ?? false,
  failures: c.meaning?.failures ?? [],
  reasons: c.meaning?.reasons ?? [],
});

// ─── Run ──────────────────────────────────────────────────────────────────────

async function runArm(arm) {
  if (!lib.ARMS.includes(arm)) throw new Error(`unknown arm ${arm} (A, B or C)`);
  const runner = ARM_RUNNERS[arm];
  if (!runner) throw new Error(`Arm ${arm} needs Prompt 11's grade-targeting code (not in src/ yet); only arm A runs before Prompt 11`);

  const items = await readItems();
  const limit = option('--limit') ? Number(option('--limit')) : Infinity;
  const smoke = Number.isFinite(limit);
  const outDir = smoke ? join(DIR, 'runs', 'smoke') : join(DIR, 'runs');
  const outFile = join(outDir, `arm-${arm}.jsonl`);
  mkdirSync(outDir, { recursive: true });

  const wanted = items.map(item => {
    const prompt = render.renderPrompt(item.text, item.target, 'app', wordSet);
    return { arm, itemId: item.id, item, prompt, promptHash: sha256(`${prompt.system}\n\n${prompt.user}`) };
  });
  const done = existsSync(outFile) ? await readJsonl(outFile) : [];
  const pending = lib.pendingItems(wanted, done).slice(0, limit);
  console.log(`[Clarity] Arm ${arm}: ${items.length} items, ${done.length} done, ${pending.length} to run → ${outFile.slice(ROOT.length + 1)}`);
  if (pending.length === 0) return;

  // Preflight: chat model, all-minilm and the NLI model, or no run
  const tags = (await api('/api/tags')).models;
  const tag = tags.find(t => t.name === lib.GRADE_MODEL);
  if (!tag) throw new Error(`Ollama has no ${lib.GRADE_MODEL} (ollama pull ${lib.GRADE_MODEL})`);
  if (!tags.some(t => t.name === EMBED_MODEL || t.name === `${EMBED_MODEL}:latest`)) throw new Error(`Ollama has no ${EMBED_MODEL} (ollama pull ${EMBED_MODEL})`);
  const { version } = await api('/api/version');
  const thinkValue = think.thinkSetting(await api('/api/show', { model: lib.GRADE_MODEL }));
  let model;
  try {
    model = await loadModel(config.NLI_MODEL_ID);
  } catch (err) {
    throw new Error(`NLI model ${config.NLI_MODEL_ID} did not load (npm run fetch-models): ${err.message}`);
  }
  const client = new nli.NliClient({ score: pairs => model.score(pairs) });

  // Warm-up (untimed): chat model, embeddings, NLI
  await unloadAll();
  await chat(pending[0].prompt.system, pending[0].prompt.user, thinkValue);
  if (!(await embed(['warm-up']))) throw new Error(`${EMBED_MODEL} did not answer`);
  await model.score([{ premise: 'A cat sat.', hypothesis: 'A cat sat.' }]);
  console.log(`[Clarity] Warmed up ${lib.GRADE_MODEL} (Ollama ${version}), ${EMBED_MODEL}, ${config.NLI_MODEL_ID}`);

  for (const w of pending) {
    const started = performance.now();
    const { chosen, tried, calls } = await runner(w.item, w.prompt, client, thinkValue);
    const wallSeconds = (performance.now() - started) / 1000;
    const m = chosen.meaning;
    const record = {
      format: lib.RUN_FORMAT,
      arm, itemId: w.item.id, kind: w.item.kind, rows: w.item.rows, target: w.item.target,
      model: lib.GRADE_MODEL, digest: tag.digest, ollamaVersion: version,
      options: lib.EVAL_OPTIONS, think: thinkValue ?? null,
      promptHash: w.promptHash, depthTier: w.prompt.spec.depthTier, hinted: w.prompt.hinted,
      calls,
      candidates: tried.map(candidateLog),
      output: chosen.text,
      ...measure(w.item, w.prompt, chosen.text),
      meaningPassed: meaning.candidatePasses(chosen),
      meaningScore: round(m?.score ?? null, 4),
      fullyChecked: m !== null && m.nliChecked && m.similarity !== null,
      wallSeconds: round(wallSeconds),
      createdAt: new Date().toISOString(),
    };
    await appendFile(outFile, JSON.stringify(record) + '\n');
    console.log(
      `[Clarity] ${arm} ${w.item.id}: FKGL ${record.fkglBefore} → ${record.fkglAfter} @${w.item.target} ` +
      `(${record.gradeHit ? 'hit' : 'miss'}), meaning ${record.meaningPassed ? 'pass' : 'fail'}${record.fullyChecked ? '' : ' (not fully checked)'}, ` +
      `${calls} call${calls === 1 ? '' : 's'}, ${wallSeconds.toFixed(1)} s`,
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  if (flag('--select-items')) await selectItems();
  else if (option('--arm')) await runArm(option('--arm'));
  else throw new Error('usage: npm run grade:run -- --select-items [--force] | --arm A|B|C [--limit N]');
} catch (err) {
  console.error(`[Clarity] ${err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
