/**
 * node scripts/replay-meaning.mjs <file.pdf | file.txt> — simplifies a
 * document the way a Chrome run does and prints the meaning failure
 * breakdown, without the browser.
 *
 * Design decisions:
 *  - Same code as a run, loaded from src/ through Vite's ssrLoadModule: the
 *    PDF or paste splitter (pdfPagesToHtml's textToBlocks), isAlreadySimple,
 *    detectEntities, findDifficultWords, buildPrompt with the previous
 *    node's last sentence as context, OllamaProvider, assessMeaning (SBERT +
 *    entities + NLI with the current config), the one meaning retry with
 *    buildRetryInstruction, and pickBetterVersion. The NLI model runs on the
 *    CPU (onnxruntime-node), so timings are not the extension's.
 *  - Profile: the default adult profile, target grade 6 (as in the test plan
 *    runs). Extra quality is off.
 *  - Reads the document at run time and writes nothing to the repo: a PDF
 *    someone else wrote is not copied into the project.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppLoader, embedOrThrow, loadModel, ROOT } from './lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const TARGET_GRADE = 6;
const file = process.argv[2];
if (!file) {
  console.error('[Clarity] usage: node scripts/replay-meaning.mjs <file.pdf | file.txt>');
  process.exit(1);
}

// ─── Input ────────────────────────────────────────────────────────────────────

/** pdf.js text per page with a newline at each line end, as lib/input/pdf.ts reads it. */
async function pdfPages(path) {
  const require = createRequire(join(ROOT, 'package.json'));
  const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await readFile(path)), disableFontFace: true, useSystemFonts: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    let text = '';
    for (const item of (await (await pdf.getPage(i)).getTextContent()).items) {
      if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
    }
    if (text.trim()) pages.push(text);
  }
  return pages;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
try {
  const load = path => vite.ssrLoadModule(path);
  const config = await load('/src/lib/quality/config.ts');
  const { textToBlocks } = await load('/src/lib/input/text-blocks.ts');
  const { detectEntities } = await load('/src/lib/segmentation/ner.ts');
  const { computeReadabilityReport } = await load('/src/lib/metrics/engine.ts');
  const { BASE_COMMON_WORDS } = await load('/src/lib/metrics/common-words.ts');
  const { findDifficultWords } = await load('/src/lib/metrics/difficult-words.ts');
  const { isAlreadySimple } = await load('/src/lib/metrics/node-grade.ts');
  const { resolveProfile } = await load('/src/lib/profile/resolver.ts');
  const { buildPrompt, hintedWords } = await load('/src/lib/prompt-builder/builder.ts');
  const { DEFAULT_PROFILE } = await load('/src/lib/storage/settings.ts');
  const { OllamaProvider, DEFAULT_LLM_MODEL } = await load('/src/lib/llm/ollama-provider.ts');
  const { assessMeaning, buildRetryInstruction, candidatePasses, pickBetterVersion, retryInputOf } = await load('/src/lib/quality/meaning.ts');
  const { checkMeaning, shouldCheckNode } = await load('/src/lib/quality/semantic.ts');
  const { checkEntailment, NliClient } = await load('/src/lib/quality/nli.ts');
  const { failureBreakdown, formatFailureBreakdown } = await load('/src/lib/quality/verdict.ts');
  const { mainClaimIndexes } = await load('/src/lib/quality/premises.ts');
  const { toPlainText } = await load('/src/lib/render/format-output.ts');

  const raw = file.toLowerCase().endsWith('.pdf') ? (await pdfPages(file)).join('\n') : await readFile(file, 'utf8');
  const blocks = textToBlocks(raw);
  const nodes = blocks.map((b, i) => ({ id: `n${i}`, type: b.kind === 'paragraph' ? 'paragraph' : 'list-item', text: b.text }));
  const wordSet = new Set(BASE_COMMON_WORDS);
  const report = computeReadabilityReport(raw.replace(/\s+/g, ' '), wordSet);
  const spec = resolveProfile({ ...DEFAULT_PROFILE, targetGradeLevel: TARGET_GRADE }, report.estimatedGradeLevel);
  const llm = new OllamaProvider(DEFAULT_LLM_MODEL);
  await llm.createBaseSession(buildPrompt(nodes[0], spec, report).system);
  const { score } = await loadModel(config.NLI_MODEL_ID);
  const client = new NliClient({ score: pairs => score(pairs) });

  console.log(
    `[Clarity] Replay of ${file}: ${nodes.length} nodes, model ${DEFAULT_LLM_MODEL}, target grade ${spec.targetGrade} (${spec.depthTier}); ` +
    `SIM ${config.SIMILARITY_THRESHOLD}, ENT ${config.ENTAILMENT_MIN}, rule ${config.NLI_PARAGRAPH_RULE}`,
  );

  const complete = async prompt => {
    let text = '';
    for await (const chunk of await llm.simplifyChunk(prompt)) text += chunk;
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  };

  const statuses = [];
  const failures = [];
  let previous = '';
  for (const n of nodes) {
    if (isAlreadySimple(n.text, spec.targetGrade, wordSet)) {
      statuses.push('excluded');
      previous = n.text;
      continue;
    }
    const node = { ...n, entities: detectEntities(n.text) };
    const difficult = findDifficultWords(node.text, node.entities, wordSet);
    const hinted = hintedWords(spec, difficult);
    const context = previous.split(/(?<=[.!?])\s+/).at(-1) ?? '';
    const prompt = buildPrompt(node, spec, report, context, difficult).user;
    const assess = text => assessMeaning(node.text, text, node.entities, hinted, {
      similarity: async (original, plain) => (await checkMeaning(original, plain, embedOrThrow)).similarity,
      entail: (original, simplified, words) => checkEntailment(original, simplified, words, client, { embed: embedOrThrow }),
      mainClaim: async (original, sentences) => {
        if (node.type === 'list-item') return sentences.map((_, i) => i);
        if (sentences.length <= 2) return null;
        const [paragraph, ...vecs] = await embedOrThrow([original, ...sentences]);
        return mainClaimIndexes(sentences.length, { sentences: vecs, paragraph });
      },
    }, { echoGuard: true });

    const firstText = await complete(prompt);
    const checked = shouldCheckNode(node);
    let kept = { text: firstText, meaning: checked ? await assess(firstText) : null };
    if (checked && !candidatePasses(kept)) {
      const retryText = await complete(`${buildRetryInstruction(kept.meaning.reasons)}\n\n${prompt}`);
      kept = pickBetterVersion(kept, { text: retryText, meaning: await assess(retryText) });
    }
    previous = toPlainText(kept.text);
    if (!kept.meaning) {
      statuses.push('excluded');
    } else {
      statuses.push(kept.meaning.passed ? 'passed' : 'failed');
      failures.push(kept.meaning.failures);
    }
    console.log(
      `  ${n.id.padEnd(4)} ${n.type.padEnd(9)} ${kept.meaning ? (kept.meaning.passed ? 'passed' : `failed: ${kept.meaning.failures.join(' + ')}`) : 'not checked'}` +
      `${kept.meaning && !kept.meaning.passed ? ` — ${kept.meaning.reasons[0]}` : ''}`,
    );
  }

  const passed = statuses.filter(s => s === 'passed').length;
  const failed = statuses.filter(s => s === 'failed').length;
  console.log(
    `\n[Clarity] Meaning passed ${passed}/${passed + failed} (${statuses.filter(s => s === 'excluded').length} excluded); ` +
    `failures: ${formatFailureBreakdown(failureBreakdown(failures))}`,
  );
} finally {
  await vite.close();
}
