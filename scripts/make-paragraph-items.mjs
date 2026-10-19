/**
 * node scripts/make-paragraph-items.mjs — fills in the real model
 * simplification of every calibration paragraph that has none
 * (eval/nli-calibration/paragraphs.jsonl), exactly as the extension would
 * make it, and records the hinted words the glossary rule uses.
 *
 * Design decisions:
 *  - Same code as a run: detectEntities, computeReadabilityReport with the
 *    base common-word list, resolveProfile, findDifficultWords, hintedWords,
 *    buildPrompt ('standard', no rolling context) and OllamaProvider, all
 *    loaded from src/ through Vite's ssrLoadModule.
 *  - Profile: the default adult profile with target grade 6, as for the
 *    first 15 paragraphs. Model: DEFAULT_LLM_MODEL (qwen2.5:3b when the
 *    existing items were made; each records simplificationModel), default
 *    sampling, one attempt, no meaning retry: the calibration needs the
 *    model's first output, faithful or not.
 *  - Existing simplifications are never regenerated, so the labelled items
 *    stay valid; `hintedWords` is (re)computed for every paragraph, because
 *    it depends only on the original and the profile.
 *  - Needs Ollama on localhost:11434 with DEFAULT_LLM_MODEL pulled.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'eval', 'nli-calibration', 'paragraphs.jsonl');
const TARGET_GRADE = 6;

// ─── Main ─────────────────────────────────────────────────────────────────────

const { createServer } = await import(pathToFileURL(join(ROOT, 'node_modules/vite/dist/node/index.js')).href);
const vite = await createServer({
  root: ROOT, configFile: false, logLevel: 'error', appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
});

try {
  const load = path => vite.ssrLoadModule(path);
  const { detectEntities } = await load('/src/lib/segmentation/ner.ts');
  const { computeReadabilityReport } = await load('/src/lib/metrics/engine.ts');
  const { BASE_COMMON_WORDS } = await load('/src/lib/metrics/common-words.ts');
  const { findDifficultWords } = await load('/src/lib/metrics/difficult-words.ts');
  const { resolveProfile } = await load('/src/lib/profile/resolver.ts');
  const { buildPrompt, hintedWords } = await load('/src/lib/prompt-builder/builder.ts');
  const { DEFAULT_PROFILE } = await load('/src/lib/storage/settings.ts');
  const { OllamaProvider, DEFAULT_LLM_MODEL } = await load('/src/lib/llm/ollama-provider.ts');

  const lines = (await readFile(FILE, 'utf8')).split(/\r?\n/).filter(l => l.trim() !== '');
  const paragraphs = lines.map(l => JSON.parse(l));
  const wordSet = new Set(BASE_COMMON_WORDS);
  const profile = { ...DEFAULT_PROFILE, targetGradeLevel: TARGET_GRADE };

  for (const p of paragraphs) {
    const entities = detectEntities(p.text);
    const report = computeReadabilityReport(p.text, wordSet);
    const spec = resolveProfile(profile, report.estimatedGradeLevel);
    const difficult = findDifficultWords(p.text, entities, wordSet);
    p.hintedWords = hintedWords(spec, difficult);
    if (p.simplification) continue;

    const node = { id: 'n0', type: 'paragraph', text: p.text, entities };
    const { system, user } = buildPrompt(node, spec, report, '', difficult);
    const llm = new OllamaProvider(DEFAULT_LLM_MODEL);
    await llm.createBaseSession(system);
    let text = '';
    for await (const chunk of await llm.simplifyChunk(user)) text += chunk;
    p.simplification = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    p.simplificationModel = DEFAULT_LLM_MODEL;
    p.targetGrade = TARGET_GRADE;
    p.simplifiedOn = new Date().toISOString().slice(0, 10);
    console.log(`[Clarity] ${p.id} (${spec.depthTier}):\n${p.simplification}\n`);
  }

  await writeFile(FILE, paragraphs.map(p => JSON.stringify(p)).join('\n') + '\n');
  console.log(`[Clarity] ${paragraphs.length} paragraphs written to ${FILE}`);
} finally {
  await vite.close();
}
