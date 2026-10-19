/**
 * Shared by the bake-off scripts: opens the Vite loader once and builds,
 * from the app's own modules, the exact prompt a run sends for a paragraph,
 * plus the metrics the bake-off reports.
 *
 * Design decisions:
 *  - Same code path as simplify.ts for one node: detectEntities, a
 *    one-paragraph document report (computeReadabilityReport with the base
 *    common-word list, no custom words), resolveProfile, findDifficultWords,
 *    buildPrompt ('standard' variant, no rolling context). The paragraph is
 *    one 'paragraph' node with its "- " list lines kept, as in the NLI
 *    calibration, so the model sees a whole list at once.
 *  - Profile: the Student preset (teen, targetGradeLevel 'auto' → grade 8,
 *    bullet-summary). isAlreadySimple uses the same target grade.
 *  - The prompt hash is sha256(system + "\n\n" + user), the resume key that
 *    catches a changed prompt.
 */

import { join } from 'node:path';
import { createAppLoader, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

export const DIR = join(ROOT, 'eval', 'model-bakeoff');
export const PARAGRAPHS = join(DIR, 'paragraphs.jsonl');
export const OUTPUTS = join(DIR, 'outputs.jsonl');
export const CSV = join(DIR, 'labels_bakeoff.csv');
export const KEY = join(DIR, 'blind_key.json');
export const MODELS_INFO = join(DIR, 'models.json');
export const REPORT = join(DIR, 'REPORT.md');
export const CALIBRATION_DIR = join(ROOT, 'eval', 'nli-calibration');
export const PRESET_ID = 'student';

// ─── Loader ───────────────────────────────────────────────────────────────────

/** The app modules, the bake-off lib and helpers; close() when done. */
export async function openApp() {
  const vite = await createAppLoader();
  const load = path => vite.ssrLoadModule(path);
  const [ner, engine, common, difficult, nodeGrade, resolver, builder, presets, format, hash, similarity, think, lib] =
    await Promise.all([
      load('/src/lib/segmentation/ner.ts'),
      load('/src/lib/metrics/engine.ts'),
      load('/src/lib/metrics/common-words.ts'),
      load('/src/lib/metrics/difficult-words.ts'),
      load('/src/lib/metrics/node-grade.ts'),
      load('/src/lib/profile/resolver.ts'),
      load('/src/lib/prompt-builder/builder.ts'),
      load('/src/lib/profile/presets.ts'),
      load('/src/lib/render/format-output.ts'),
      load('/src/lib/utils/hash.ts'),
      load('/src/lib/quality/similarity.ts'),
      load('/src/lib/llm/ollama-think.ts'),
      load('/scripts/bakeoff/lib.ts'),
    ]);
  const wordSet = new Set(common.BASE_COMMON_WORDS);
  const profile = presets.getPreset(PRESET_ID).profile;

  /** Readability of a text as the app measures it (list markers stripped). */
  function metrics(text) {
    const plain = format.toPlainText(text);
    const report = engine.computeReadabilityReport(plain, wordSet);
    return {
      fkgl: report.fleschKincaidGradeLevel,
      grade: report.estimatedGradeLevel,
      words: engine.countWords(plain),
    };
  }

  /** List items in a text, as the Reading page parses model output. */
  function listItems(text) {
    return format.parseSimplifiedText(text)
      .filter(b => b.kind === 'list')
      .reduce((n, b) => n + b.items.length, 0);
  }

  /** The app's prompt and spec for one paragraph. */
  async function prepare(text) {
    const entities = ner.detectEntities(text);
    const report = engine.computeReadabilityReport(text, wordSet);
    const spec = resolver.resolveProfile(profile, report.estimatedGradeLevel);
    const words = difficult.findDifficultWords(text, entities, wordSet);
    const node = { id: 'n0', type: 'paragraph', text, entities };
    const { system, user } = builder.buildPrompt(node, spec, report, '', words);
    return {
      system,
      user,
      spec,
      report,
      promptHash: await hash.sha256(`${system}\n\n${user}`),
      alreadySimple: nodeGrade.isAlreadySimple(text, spec.targetGrade, wordSet),
    };
  }

  return {
    lib,
    metrics,
    listItems,
    prepare,
    toPlainText: format.toPlainText,
    isEnglishWord: word => common.isCommonWord(word),
    cosineSimilarity: similarity.cosineSimilarity,
    thinkSetting: think.thinkSetting,
    targetGrade: resolver.resolveTargetGrade(profile),
    close: () => vite.close(),
  };
}
