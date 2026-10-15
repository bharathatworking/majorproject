/**
 * npm run fetch-models — puts the local NLI model and the ONNX Runtime wasm
 * files where the extension loads them from (public/ → dist/ on build).
 *
 * Design decisions:
 *  - The extension never downloads a model at runtime (env.allowRemoteModels
 *    = false in src/lib/quality/nli.worker.ts), so the files ship inside dist/.
 *    They are git-ignored; run this once after a clone.
 *  - Model: Xenova/nli-deberta-v3-xsmall (ONNX conversion of
 *    cross-encoder/nli-deberta-v3-xsmall, Apache-2.0), pinned to one commit
 *    and checked against SHA-256 hashes recorded here, so a changed upstream
 *    file fails loudly instead of silently changing thesis results. Only the
 *    8-bit quantized weights (dtype 'q8' → model_quantized.onnx, 87 MB) are
 *    fetched. Files that already match their hash are skipped.
 *  - Wasm: copied from the installed onnxruntime-web, not downloaded, so the
 *    binary always matches the runtime JS that Vite bundles into the worker.
 *    Transformers.js uses the 'asyncify' build in browsers.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';
const REVISION = '2a4f614a701367a02d51389039afc998faeda637';
const MODEL_DIR = join(ROOT, 'public', 'models', ...MODEL_ID.split('/'));
const ORT_DIR = join(ROOT, 'public', 'ort');

/** Model files and their SHA-256 at REVISION. */
const MODEL_FILES = {
  'config.json':               'ec0bd14cc28640326474399cd61d38ccd52b64900228799d0f81debda8c4bc53',
  'tokenizer.json':            'a86f883318afa11c8c10466f1bf4efaeb6ded28a52cbe57217a8fa0d0a2a87df',
  'tokenizer_config.json':     'd8d3bb123b99317634d5ee3d1d2d8b2ddb01510a0654687fc2639a5347a7291f',
  'special_tokens_map.json':   '311de3f4eed9d76a43bf0d71f10e62e086ca65ccce9f15d5da0d2098bf519ecc',
  'onnx/model_quantized.onnx': '3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6',
};

/** ONNX Runtime files the worker points env.backends.onnx.wasm.wasmPaths at. */
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function hashOf(path) {
  return existsSync(path) ? sha256(await readFile(path)) : null;
}

async function fetchModelFile(name, expected) {
  const target = join(MODEL_DIR, ...name.split('/'));
  if ((await hashOf(target)) === expected) {
    console.log(`[Clarity] ok       ${name}`);
    return;
  }
  const url = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/${name}`;
  console.log(`[Clarity] download ${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new Error(`${name}: SHA-256 mismatch (expected ${expected}, got ${actual})`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.part`, buf);
  await rename(`${target}.part`, target);
  console.log(`[Clarity]          ${(buf.length / 1e6).toFixed(1)} MB`);
}

async function copyOrtFiles() {
  const require = createRequire(import.meta.url);
  // The package's exports map hides package.json; resolve a dist file instead
  const ortDist = dirname(require.resolve('onnxruntime-web/webgpu'));
  await mkdir(ORT_DIR, { recursive: true });
  for (const name of ORT_FILES) {
    await copyFile(join(ortDist, name), join(ORT_DIR, name));
    console.log(`[Clarity] copied   ort/${name}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  for (const [name, hash] of Object.entries(MODEL_FILES)) await fetchModelFile(name, hash);
  await copyOrtFiles();
  console.log('[Clarity] Models ready. Run npm run build and reload dist/ in Chrome.');
} catch (err) {
  console.error('[Clarity] fetch-models failed:', err.message);
  process.exitCode = 1;
}
