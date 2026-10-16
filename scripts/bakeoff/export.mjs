/**
 * npm run bakeoff:export — writes the blind labelling sheet
 * eval/model-bakeoff/labels_bakeoff.csv and its key blind_key.json.
 *
 *   node scripts/bakeoff/export.mjs [--force]
 *
 * Design decisions:
 *  - One row per GPU output (3 models × 40 paragraphs = 120), shuffled with
 *    the fixed SHUFFLE_SEED and numbered B001… after the shuffle, so neither
 *    the order nor the id hints at the model. Columns: blind_id, original,
 *    simplified (the cleaned output, list markers kept), my_label, note.
 *  - The model and paragraph of each blind id go only to blind_key.json.
 *    This script prints counts and paths, never the key or anything per
 *    model, so labelling stays blind.
 *  - Same CSV dialect as labels.csv (RFC 4180, UTF-8 BOM, CRLF), so it
 *    opens correctly in Excel and LibreOffice.
 *  - Refuses to overwrite a sheet that already holds labels unless --force,
 *    and refuses to export until every GPU pair exists and the flag pass
 *    has run.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { readJsonl } from '../lib/nli-node.mjs';
import { CSV, KEY, OUTPUTS, PARAGRAPHS, openApp } from './app.mjs';

// ─── Main ─────────────────────────────────────────────────────────────────────

const app = await openApp();
try {
  const { BAKEOFF_MODELS, SHUFFLE_SEED, makeBlind, parseCsv, toCsv } = app.lib;
  if (existsSync(CSV) && !process.argv.includes('--force')) {
    const labelled = parseCsv(await readFile(CSV, 'utf8')).slice(1).filter(r => (r[3] ?? '').trim() !== '').length;
    if (labelled > 0) throw new Error(`${CSV} already has ${labelled} labels; unblind them, or re-export with --force`);
  }

  const paragraphs = await readJsonl(PARAGRAPHS);
  const outputs = (await readJsonl(OUTPUTS)).filter(r => r.mode === 'gpu');
  const missing = BAKEOFF_MODELS.flatMap(model =>
    paragraphs.filter(p => !outputs.some(o => o.model === model && o.paragraphId === p.id)).map(p => `${model} × ${p.id}`));
  if (missing.length > 0) throw new Error(`${missing.length} GPU outputs missing (e.g. ${missing[0]}); run npm run bakeoff:run`);
  if (outputs.some(o => o.similarity === null && o.cleaned.trim() !== '')) {
    throw new Error('the flag pass has not run for every output; run node scripts/bakeoff/run.mjs --flags-only');
  }

  const byId = new Map(paragraphs.map(p => [p.id, p]));
  const sources = outputs.map(o => ({ model: o.model, paragraphId: o.paragraphId, original: byId.get(o.paragraphId).text, simplified: o.cleaned }));
  const { rows, key } = makeBlind(sources, SHUFFLE_SEED);
  await writeFile(CSV, toCsv(rows));
  await writeFile(KEY, JSON.stringify(key, null, 2) + '\n');
  console.log(`[Clarity] ${rows.length - 1} blind rows written to ${CSV} (seed ${SHUFFLE_SEED}); key in ${KEY}`);
} catch (err) {
  console.error(`[Clarity] ${err.message}`);
  process.exitCode = 1;
} finally {
  await app.close();
}
