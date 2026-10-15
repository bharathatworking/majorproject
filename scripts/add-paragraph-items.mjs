/**
 * node scripts/add-paragraph-items.mjs — brings eval/nli-calibration/
 * paragraph-items.jsonl in line with paragraphs.jsonl for blind labelling.
 *
 * Design decisions:
 *  - Every paragraph with a simplification gets one `<id>#real` item (the
 *    verbatim qwen2.5:3b output). Existing items keep their split.
 *  - New paragraphs are split dev/test so the halves stay balanced per
 *    source (wikipedia, us-government): each goes to the half with fewer
 *    real items of its source, ties to dev. A real item and its injected
 *    copy always share a half (copies keep their base's split).
 *  - Blind labelling: real items lose any proposedLabel and note (Claude's
 *    opinion), so only your labels (npm run import-labels) decide. Injected
 *    copies are unfaithful by construction: label 'unfaithful', reviewed.
 *  - Idempotent: running it again adds only what is missing.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const DIR = join(ROOT, 'eval', 'nli-calibration');
const read = async name =>
  (await readFile(join(DIR, name), 'utf8')).split(/\r?\n/).filter(l => l.trim() !== '').map(l => JSON.parse(l));

// ─── Main ─────────────────────────────────────────────────────────────────────

const paragraphs = await read('paragraphs.jsonl');
const items = await read('paragraph-items.jsonl');
const byId = new Map(paragraphs.map(p => [p.id, p]));
const hasReal = new Set(items.filter(i => i.origin !== 'injected').map(i => i.paragraphId));

const realCount = (split, source) =>
  items.filter(i => i.origin !== 'injected' && i.split === split && byId.get(i.paragraphId)?.source === source).length;

let added = 0;
for (const p of paragraphs) {
  if (hasReal.has(p.id)) continue;
  if (!p.simplification) {
    console.log(`[Clarity] ${p.id} has no simplification yet (run node scripts/make-paragraph-items.mjs)`);
    continue;
  }
  const split = realCount('dev', p.source) <= realCount('test', p.source) ? 'dev' : 'test';
  items.push({
    id: `${p.id}#real`, paragraphId: p.id, split, origin: p.simplificationModel ?? 'qwen2.5:3b',
    simplified: p.simplification, errorType: null, reviewed: false,
  });
  added++;
}

for (const item of items) {
  if (item.origin === 'injected') {
    item.label = 'unfaithful';
    item.reviewed = true;
  } else {
    delete item.proposedLabel;
    delete item.note;
  }
}

items.sort((a, b) => a.split.localeCompare(b.split) || a.paragraphId.localeCompare(b.paragraphId)
  || Number(a.origin === 'injected') - Number(b.origin === 'injected'));
await writeFile(join(DIR, 'paragraph-items.jsonl'), items.map(i => JSON.stringify(i)).join('\n') + '\n');

const real = items.filter(i => i.origin !== 'injected');
console.log(
  `[Clarity] ${added} real items added; ${real.length} real ` +
  `(dev ${real.filter(i => i.split === 'dev').length}, test ${real.filter(i => i.split === 'test').length}), ` +
  `${items.length - real.length} injected (labelled unfaithful)`,
);
