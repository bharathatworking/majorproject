/**
 * npm run export-labels / npm run import-labels — blind labelling of the
 * real simplifications in eval/nli-calibration/paragraph-items.jsonl through
 * eval/nli-calibration/labels.csv.
 *
 *   node scripts/labels.mjs export [--force] [--seed N]
 *   node scripts/labels.mjs import [--dry-run] [--file path.csv]
 *   node scripts/labels.mjs --self-test
 *
 * Design decisions:
 *  - Export writes only the real model outputs (injected copies are
 *    unfaithful by construction) with columns id, original, simplified,
 *    my_label, note, in a seeded random order (the seed is printed, so the
 *    order can be reproduced), with no proposed label: the labels are blind.
 *  - RFC 4180 CSV (fields quoted, quotes doubled; list texts keep their line
 *    breaks inside quotes) with a UTF-8 BOM, so Excel and LibreOffice show
 *    accents (Skłodowska, Apurímac) correctly. Excel may save with ; as the
 *    separator in some locales; import accepts , or ; (read from the header).
 *  - Export refuses to overwrite a CSV that already has labels, unless
 *    --force: a re-export must never wipe your work.
 *  - Import accepts faithful / unfaithful (also f / u, any case). An empty
 *    my_label leaves the item unreviewed; anything else is an error naming
 *    the row, and nothing is written. Labels go to `label`, notes to
 *    `labelNote`, and `reviewed` becomes true.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const DIR = join(ROOT, 'eval', 'nli-calibration');
const ITEMS = join(DIR, 'paragraph-items.jsonl');
const PARAGRAPHS = join(DIR, 'paragraphs.jsonl');
const CSV = join(DIR, 'labels.csv');
const COLUMNS = ['id', 'original', 'simplified', 'my_label', 'note'];
const DEFAULT_SEED = 20261015;

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

// ─── CSV ──────────────────────────────────────────────────────────────────────

const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;

/** RFC 4180 rows with CRLF line ends and a BOM. */
export function toCsv(rows, separator = ',') {
  return '﻿' + rows.map(r => r.map(quote).join(separator)).join('\r\n') + '\r\n';
}

/** Parses RFC 4180 CSV (quoted fields may hold separators, quotes and line breaks). */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const separator = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === separator) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const readJsonl = async path =>
  (await readFile(path, 'utf8')).split(/\r?\n/).filter(l => l.trim() !== '').map(l => JSON.parse(l));

/** Deterministic shuffle (mulberry32). */
function shuffle(array, seed) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function normalizeLabel(value) {
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'f' || v === 'faithful') return 'faithful';
  if (v === 'u' || v === 'unfaithful') return 'unfaithful';
  return undefined;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function exportLabels() {
  if (existsSync(CSV) && !flag('--force')) {
    const rows = parseCsv(await readFile(CSV, 'utf8'));
    const labelled = rows.slice(1).filter(r => (r[3] ?? '').trim() !== '').length;
    if (labelled > 0) {
      throw new Error(`${CSV} already has ${labelled} labels; import them, or re-export with --force`);
    }
  }
  const seed = Number(option('--seed') ?? DEFAULT_SEED);
  const paragraphs = new Map((await readJsonl(PARAGRAPHS)).map(p => [p.id, p]));
  const real = (await readJsonl(ITEMS)).filter(i => i.origin !== 'injected');
  const rows = shuffle(real, seed).map(i => [i.id, paragraphs.get(i.paragraphId).text, i.simplified, '', '']);
  await writeFile(CSV, toCsv([COLUMNS, ...rows]));
  console.log(`[Clarity] ${rows.length} real simplifications written to ${CSV} (random order, seed ${seed})`);
}

async function importLabels() {
  const file = option('--file') ?? CSV;
  const rows = parseCsv(await readFile(file, 'utf8'));
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = name => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${file}: no "${name}" column`);
    return i;
  };
  const [idCol, labelCol, noteCol] = [col('id'), col('my_label'), col('note')];

  const items = await readJsonl(ITEMS);
  const byId = new Map(items.map(i => [i.id, i]));
  const errors = [];
  const updates = [];
  rows.slice(1).forEach((r, k) => {
    const rowNo = k + 2;
    const id = (r[idCol] ?? '').trim();
    const item = byId.get(id);
    if (!item || item.origin === 'injected') {
      errors.push(`row ${rowNo}: unknown real item "${id}"`);
      return;
    }
    const label = normalizeLabel(r[labelCol] ?? '');
    if (label === undefined) errors.push(`row ${rowNo} (${id}): my_label "${r[labelCol]}" is not faithful / unfaithful / f / u`);
    else if (label !== null) updates.push({ item, label, note: (r[noteCol] ?? '').trim() });
  });
  if (errors.length > 0) throw new Error(`Nothing imported:\n  ${errors.join('\n  ')}`);

  for (const { item, label, note } of updates) {
    item.label = label;
    item.reviewed = true;
    if (note) item.labelNote = note;
    else delete item.labelNote;
  }
  const real = items.filter(i => i.origin !== 'injected');
  const count = (split, l) => real.filter(i => i.split === split && i.label === l).length;
  console.log(
    `[Clarity] ${updates.length} labels read from ${file}; ` +
    `dev ${count('dev', 'faithful')} faithful / ${count('dev', 'unfaithful')} unfaithful, ` +
    `test ${count('test', 'faithful')} / ${count('test', 'unfaithful')}; ` +
    `${real.filter(i => !i.reviewed).length} real items still unlabelled`,
  );
  if (flag('--dry-run')) {
    console.log('[Clarity] Dry run: paragraph-items.jsonl not written');
    return;
  }
  await writeFile(ITEMS, items.map(i => JSON.stringify(i)).join('\n') + '\n');
}

function selfTest() {
  const rows = [COLUMNS, ['a#real', 'Line one, with comma\n- item "two"', 'Skłodowska; Apurímac', 'F', ''], ['b', '', 'x', 'unfaithful', 'n']];
  const back = parseCsv(toCsv(rows));
  if (JSON.stringify(back) !== JSON.stringify(rows)) throw new Error(`round trip failed: ${JSON.stringify(back)}`);
  const semi = parseCsv(toCsv(rows, ';'));
  if (JSON.stringify(semi) !== JSON.stringify(rows)) throw new Error('semicolon round trip failed');
  for (const [v, want] of [['F', 'faithful'], [' unfaithful ', 'unfaithful'], ['u', 'unfaithful'], ['', null], ['maybe', undefined]]) {
    if (normalizeLabel(v) !== want) throw new Error(`label "${v}"`);
  }
  console.log('[Clarity] labels.mjs self-test passed');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  if (flag('--self-test')) selfTest();
  else if (argv[0] === 'export') await exportLabels();
  else if (argv[0] === 'import') await importLabels();
  else throw new Error('usage: node scripts/labels.mjs export [--force] [--seed N] | import [--dry-run] [--file path] | --self-test');
} catch (err) {
  console.error(`[Clarity] ${err.message}`);
  process.exitCode = 1;
}
