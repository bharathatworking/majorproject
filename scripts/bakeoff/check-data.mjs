/**
 * npm run bakeoff:check — validates eval/model-bakeoff/paragraphs.jsonl
 * against the Prompt 9.4 data rules before any model is run.
 *
 * Design decisions:
 *  - Every rule is checked from the text itself with the app's own metrics
 *    (openApp): word count 40–220, FKGL of the plain text ≥ 9, and not
 *    skipped by isAlreadySimple at the Student target grade. The stored
 *    `words` and `fkgl` must match the recomputed values, so they can't go
 *    stale.
 *  - Leakage check against eval/nli-calibration/: ids, Wikipedia article
 *    titles, government page URLs, and any shared 8-word shingle with any
 *    text in that folder's JSONL files (originals and simplifications).
 *  - Exits 1 with every failure listed; prints only counts on success.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonl } from '../lib/nli-node.mjs';
import { CALIBRATION_DIR, PARAGRAPHS, openApp } from './app.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const COUNTS = { total: 40, wiki: 24, gov: 16 };
const MIN_LISTS = 8;
const MIN_NUMBERS = 12;
const CPU_SUBSET = 10;
const DOMAINS = ['health', 'science', 'history', 'safety', 'tech', 'money'];
const GOV_HOSTS = ['ready.gov', 'weather.gov', 'cdc.gov', 'nih.gov'];
const WORDS = [40, 220];
const MIN_FKGL = 9;
const SHINGLE = 8;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const hostOk = url => {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return GOV_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
};
/** Wikipedia article title, or a government URL without query and trailing slash. */
const sourceKey = url => {
  const u = new URL(url);
  const title = u.searchParams.get('title');
  if (u.hostname.endsWith('wikipedia.org') && title) return `wiki:${title.toLowerCase()}`;
  return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
};

function shingles(words, n = SHINGLE) {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** Every string value of a JSON record (recursively). */
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const app = await openApp();
const errors = [];
try {
  const items = await readJsonl(PARAGRAPHS);
  const fail = (id, msg) => errors.push(`${id}: ${msg}`);

  // ── Calibration material (leakage check)
  const calFiles = (await readdir(CALIBRATION_DIR)).filter(f => f.endsWith('.jsonl'));
  const calRecords = (await Promise.all(calFiles.map(f => readJsonl(join(CALIBRATION_DIR, f))))).flat();
  const calIds = new Set(calRecords.map(r => r.id).filter(Boolean));
  const calSources = new Set(calRecords.map(r => r.url).filter(Boolean).map(sourceKey));
  const calShingles = new Set();
  for (const r of calRecords) for (const s of strings(r)) for (const sh of shingles(app.lib.wordsOf(s))) calShingles.add(sh);

  // ── Per item
  const ids = new Set();
  for (const p of items) {
    const id = p.id ?? '(no id)';
    if (ids.has(id)) fail(id, 'duplicate id');
    ids.add(id);
    if (calIds.has(id)) fail(id, 'id is used in eval/nli-calibration');
    if (!['wiki', 'gov'].includes(p.source)) fail(id, `source "${p.source}" is not wiki / gov`);
    if (!DOMAINS.includes(p.domain)) fail(id, `domain "${p.domain}" is not one of ${DOMAINS.join(', ')}`);
    if (!p.url) fail(id, 'no url');
    else {
      if (calSources.has(sourceKey(p.url))) fail(id, `source ${sourceKey(p.url)} is used in eval/nli-calibration`);
      if (p.source === 'wiki' && !(p.revid && p.url.includes(`oldid=${p.revid}`))) fail(id, 'wiki item needs revid matching the url');
      if (p.source === 'gov' && !hostOk(p.url)) fail(id, `host of ${p.url} is not ${GOV_HOSTS.join(' / ')}`);
      if (p.source === 'gov' && !/^\d{4}-\d{2}-\d{2}$/.test(p.accessed ?? '')) fail(id, 'gov item needs accessed (YYYY-MM-DD)');
    }
    if (p.bakeoffOnly !== true) fail(id, 'bakeoffOnly must be true');

    const text = p.text ?? '';
    const m = app.metrics(text);
    const { alreadySimple } = await app.prepare(text);
    if (m.words < WORDS[0] || m.words > WORDS[1]) fail(id, `${m.words} words (needs ${WORDS[0]}–${WORDS[1]})`);
    if (m.fkgl < MIN_FKGL) fail(id, `FKGL ${m.fkgl.toFixed(2)} < ${MIN_FKGL}`);
    if (alreadySimple) fail(id, `skipped as already simple at grade ${app.targetGrade}`);
    if (p.words !== m.words) fail(id, `stored words ${p.words} ≠ ${m.words}`);
    if (Math.abs((p.fkgl ?? NaN) - m.fkgl) > 0.01) fail(id, `stored fkgl ${p.fkgl} ≠ ${m.fkgl.toFixed(2)}`);
    if (app.lib.hasCitationMarks(text)) fail(id, 'citation marks left');
    if (app.lib.hasIpa(text)) fail(id, 'IPA left');
    if (/\(\s*[;,]?\s*\)/.test(text)) fail(id, 'empty parentheses left');
    const lists = app.listItems(text);
    if (p.isList !== lists > 0) fail(id, `isList ${p.isList} but ${lists} list items`);
    if (p.hasNumbers !== /\d/.test(text)) fail(id, `hasNumbers ${p.hasNumbers} disagrees with the text`);
    const shared = [...shingles(app.lib.wordsOf(text))].filter(s => calShingles.has(s));
    if (shared.length > 0) fail(id, `${shared.length} 8-word shingle(s) shared with eval/nli-calibration, e.g. "${shared[0]}"`);
  }

  // ── Set-level rules
  const count = f => items.filter(f).length;
  if (items.length !== COUNTS.total) errors.push(`set: ${items.length} paragraphs (needs ${COUNTS.total})`);
  if (count(p => p.source === 'wiki') !== COUNTS.wiki) errors.push(`set: ${count(p => p.source === 'wiki')} wiki (needs ${COUNTS.wiki})`);
  if (count(p => p.source === 'gov') !== COUNTS.gov) errors.push(`set: ${count(p => p.source === 'gov')} gov (needs ${COUNTS.gov})`);
  if (count(p => p.isList) < MIN_LISTS) errors.push(`set: ${count(p => p.isList)} lists (needs ≥ ${MIN_LISTS})`);
  if (count(p => p.hasNumbers) < MIN_NUMBERS) errors.push(`set: ${count(p => p.hasNumbers)} with numbers (needs ≥ ${MIN_NUMBERS})`);
  if (count(p => p.cpuSubset === true) !== CPU_SUBSET) errors.push(`set: ${count(p => p.cpuSubset === true)} cpuSubset (needs ${CPU_SUBSET})`);
  for (const d of DOMAINS) if (count(p => p.domain === d) === 0) errors.push(`set: no ${d} paragraph`);
  const texts = new Set(items.map(p => p.text));
  if (texts.size !== items.length) errors.push('set: duplicate texts');

  if (errors.length > 0) {
    console.error(`[Clarity] ${errors.length} problem(s) in ${PARAGRAPHS}:\n  ${errors.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    const byDomain = DOMAINS.map(d => `${d} ${count(p => p.domain === d)}`).join(', ');
    console.log(
      `[Clarity] ${items.length} paragraphs OK: ${count(p => p.source === 'wiki')} wiki / ${count(p => p.source === 'gov')} gov, ` +
      `${count(p => p.isList)} lists, ${count(p => p.hasNumbers)} with numbers, ${count(p => p.cpuSubset)} in the CPU subset; ${byDomain}; ` +
      `no overlap with eval/nli-calibration (${calRecords.length} records)`,
    );
  }
} finally {
  await app.close();
}
