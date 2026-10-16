/**
 * node scripts/bakeoff/fetch-wiki.mjs --out candidates.jsonl "Title one" "Title two" …
 *
 * One-off data helper for eval/model-bakeoff/paragraphs.jsonl: reads the lead
 * section of each article from the Wikipedia API as plain text, with the
 * current revision id, cleans every lead paragraph and writes one candidate
 * per paragraph with the bake-off checks already measured. Paragraphs are
 * then chosen by hand and checked with npm run bakeoff:check.
 *
 * Design decisions:
 *  - prop=extracts (exintro, explaintext) is the plain-text extract the NLI
 *    calibration used; the revision id pins the text (CC BY-SA 4.0 needs the
 *    article and revision for attribution).
 *  - cleanWikiText (scripts/bakeoff/lib.ts) removes citation marks, IPA and
 *    empty pronunciation parentheses such as "( ; )".
 *  - Metrics come from the app (openApp): FKGL of the plain text, and
 *    whether the run would skip the paragraph as already simple at the
 *    Student target grade.
 */

import { writeFile } from 'node:fs/promises';
import { openApp } from './app.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const API = 'https://en.wikipedia.org/w/api.php';
const HEADERS = { 'User-Agent': 'ClarityBakeoff/1.0 (offline research evaluation)' };
const MIN_WORDS = 40;
const MAX_WORDS = 220;
const MIN_FKGL = 9;

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const out = outIndex >= 0 ? argv[outIndex + 1] : null;
const titles = argv.filter((_, i) => i !== outIndex && i !== outIndex + 1);

// ─── Fetch ────────────────────────────────────────────────────────────────────

/** Lead extracts and revisions of up to 20 titles in one request (fewer requests, as the API asks). */
async function leads(batch) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1', exlimit: 'max',
    prop: 'extracts|revisions', exintro: '1', explaintext: '1', rvprop: 'ids|timestamp', titles: batch.join('|'),
  });
  let res;
  // A 429 (rate limit) waits for retry-after and tries again
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(`${API}?${params}`, { headers: HEADERS });
    if (res.status !== 429) break;
    const wait = Number(res.headers.get('retry-after') ?? 10) + 1;
    console.log(`[Clarity] Rate limited; waiting ${wait} s`);
    await new Promise(r => setTimeout(r, wait * 1000));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const pages = (await res.json()).query.pages;
  for (const page of pages.filter(p => p.missing)) console.warn(`[Clarity] ${page.title}: no such article`);
  return pages.filter(p => !p.missing).map(page => ({
    title: page.title, extract: page.extract, revid: page.revisions[0].revid, timestamp: page.revisions[0].timestamp,
  }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (!out || titles.length === 0) {
  console.error('[Clarity] usage: node scripts/bakeoff/fetch-wiki.mjs --out candidates.jsonl "Title" …');
  process.exit(1);
}

const app = await openApp();
try {
  const lines = [];
  const pages = [];
  for (let i = 0; i < titles.length; i += 20) pages.push(...await leads(titles.slice(i, i + 20)));
  for (const page of pages) {
    const paragraphs = page.extract.split(/\n+/).map(p => app.lib.cleanWikiText(p)).filter(p => p !== '');
    for (const [index, text] of paragraphs.entries()) {
      const m = app.metrics(text);
      const { alreadySimple } = await app.prepare(text);
      const passes = m.words >= MIN_WORDS && m.words <= MAX_WORDS && m.fkgl >= MIN_FKGL && !alreadySimple;
      lines.push({
        title: page.title,
        url: `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(page.title.replace(/ /g, '_'))}&oldid=${page.revid}`,
        revid: page.revid,
        revisionTimestamp: page.timestamp,
        paragraphIndex: index,
        text,
        words: m.words,
        fkgl: Number(m.fkgl.toFixed(2)),
        alreadySimple,
        passes,
      });
      console.log(`[Clarity] ${page.title} #${index}: ${m.words} words, FKGL ${m.fkgl.toFixed(1)}${passes ? ' ✓' : ''}`);
    }
  }
  await writeFile(out, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  console.log(`[Clarity] ${lines.length} candidates written to ${out}`);
} finally {
  await app.close();
}
