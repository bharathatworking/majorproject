/**
 * npm run train:data — builds the Prompt 10 SFT set from the deduplicated
 * Wiki-Auto pairs: training/data/sft_train.jsonl, sft_dev.jsonl and the
 * committed training/data/STATS.md.
 *
 *   node scripts/train-data/build-sft.mjs [--n 15000] [--dev 500]
 *
 * Needs: training/prepare/download.py and dedupe.py first. Ollama with
 * all-minilm is used for the main-claim rule (the app's own rule); without
 * it the main claim falls back to the first sentence and STATS.md says how
 * often.
 *
 * Design decisions:
 *  - The app's own code, through the Vite loader (scripts/lib/nli-node.mjs):
 *    FKGL is computeReadabilityReport().fleschKincaidGradeLevel, entities are
 *    detectEntities + findMissingEntities, the main claim is mainClaimIndexes
 *    + keyEntityTexts, and the prompt is render.ts (the exact buildPrompt
 *    path of simplify.ts). So "grade", "entity" and "prompt" mean here what
 *    they mean in the app.
 *  - Pure logic (filters, grades, runs, balance, split, dedupe matcher) is in
 *    lib.ts and unit-tested. This driver only reads, measures and writes.
 *  - Grade conditioning: the target grade is the simple side's own FKGL
 *    (rounded, clamped 3–12), so the prompt asks for the grade the reference
 *    really has. Buckets are balanced by water-filling (lib.ts waterFill).
 *  - Cheap rules (length, ratio, FKGL drop) run on every candidate; the NER /
 *    embedding rules run lazily while the buckets fill, and STATS.md reports
 *    their counts over the candidates they actually ran on.
 *  - Hints are truthful (author's decision): the app's difficult words of
 *    the source, kept only when the simple side no longer has them.
 *  - The keep slice (≤ 5%): Wiki-Auto pairs whose simple side is the source
 *    unchanged, with the target = the source and a grade at or above it.
 *  - Every selected source is re-checked against data/reserved.jsonl with
 *    the TS twin of dedupe.py's matcher; one hit aborts the build.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createAppLoader, embed, readJsonl, ROOT } from '../lib/nli-node.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA = join(ROOT, 'training', 'data');
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : fallback);
const N_TRAIN = option('--n', 15000);
const N_DEV = option('--dev', 500);

const round = (x, d = 2) => Number(x.toFixed(d));
const pct = (k, n) => (n === 0 ? '—' : `${((100 * k) / n).toFixed(1)}%`);

// ─── Input ────────────────────────────────────────────────────────────────────

async function readPairs(path) {
  const pairs = [];
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) pairs.push(JSON.parse(line));
  return pairs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const vite = await createAppLoader();
try {
  const load = path => vite.ssrLoadModule(path);
  const [lib, render, engine, semantic, premises, meaning] = await Promise.all([
    load('/scripts/train-data/lib.ts'),
    load('/scripts/train-data/render.ts'),
    load('/src/lib/metrics/engine.ts'),
    load('/src/lib/quality/semantic.ts'),
    load('/src/lib/quality/premises.ts'),
    load('/src/lib/quality/meaning.ts'),
  ]);
  const ner = await load('/src/lib/segmentation/ner.ts');
  const wordSet = render.baseWordSet();
  const fkgl = text => engine.computeReadabilityReport(text, wordSet).fleschKincaidGradeLevel;
  const rand = lib.mulberry32(lib.SFT_SEED);

  for (const f of ['wikiauto_dedup.jsonl', 'reserved.jsonl', 'dedupe_report.json', 'SOURCES.json']) {
    if (!existsSync(join(DATA, f))) throw new Error(`training/data/${f} is missing: run download.py and dedupe.py first`);
  }
  const dedupeReport = JSON.parse(await readFile(join(DATA, 'dedupe_report.json'), 'utf8'));
  const sources = JSON.parse(await readFile(join(DATA, 'SOURCES.json'), 'utf8'));

  // 1. Pairs, cleaned on both sides
  const raw = await readPairs(join(DATA, 'wikiauto_dedup.jsonl'));
  const pairs = raw
    .map(p => ({ ...p, complex: lib.cleanPairText(p.complex), simple: lib.cleanPairText(p.simple) }))
    .filter(p => p.complex !== '' && p.simple !== '');
  console.log(`[Clarity] ${raw.length} deduplicated pairs, ${pairs.length} non-empty after cleaning`);

  const total = N_TRAIN + N_DEV;
  const keepWanted = Math.floor(lib.KEEP_SHARE_MAX * total);
  const counts = { pairs: pairs.length, keepCandidates: 0, keepSelected: 0 };

  // 2. Keep slice: unchanged pairs, target = source, grade at or above it
  const unchanged = lib.shuffleWith(
    pairs.filter(p => lib.normaliseForDedupe(p.complex) === lib.normaliseForDedupe(p.simple)), rand,
  );
  counts.keepCandidates = unchanged.length;
  const keep = [];
  const usedIds = new Set();
  for (const p of unchanged) {
    if (keep.length >= keepWanted) break;
    if (engine.countWords(p.complex) < lib.MIN_SOURCE_WORDS) continue;
    const fkglSrc = fkgl(p.complex);
    const g = lib.keepGradeFor(fkglSrc);
    if (g === null) continue;
    const r = render.renderPrompt(p.complex, g, []);
    const chars = r.system.length + r.user.length + r.modelText.length;
    if (lib.promptDropReason({ chars, depthTier: r.spec.depthTier, kind: 'keep' })) continue;
    keep.push({
      kind: 'keep', sourceIds: [p.id], articleId: p.articleId, source: p.complex, target: r.modelText,
      g, fkglSrc, fkglTgt: fkglSrc, prompt: r,
    });
    usedIds.add(p.id);
  }
  counts.keepSelected = keep.length;
  console.log(`[Clarity] Keep slice: ${keep.length} of ${unchanged.length} unchanged pairs`);

  // 3. Pseudo-paragraph runs and the two pools
  const runs = lib.contiguousRuns(pairs.filter(p => !usedIds.has(p.id)));
  const { paragraphs, sentences } = lib.assignPools(runs, rand);
  const candidates = [
    ...paragraphs.map(chunk => ({ kind: 'para', chunk })),
    ...sentences.map(p => ({ kind: 'sent', chunk: [p] })),
  ];
  counts.runs = runs.length;
  counts.multiRuns = runs.filter(r => r.length >= 2).length;
  counts.paraCandidates = paragraphs.length;
  counts.sentCandidates = sentences.length;
  console.log(`[Clarity] ${runs.length} runs → ${paragraphs.length} paragraph and ${sentences.length} sentence candidates`);

  // 4. Cheap rules on every candidate, then grade buckets
  const drops = Object.fromEntries(lib.DROP_REASONS.map(r => [r, { para: 0, sent: 0 }]));
  const byGrade = new Map();
  for (let g = lib.GRADE_MIN; g <= lib.GRADE_MAX; g++) byGrade.set(g, { grade: g, para: [], sent: [] });
  for (const c of candidates) {
    const { complex, simple } = lib.joinChunk(c.chunk);
    const m = {
      sourceWords: engine.countWords(complex), targetWords: engine.countWords(simple),
      fkglSource: fkgl(complex), fkglTarget: fkgl(simple),
    };
    const reason = lib.cheapDropReason(m);
    if (reason) {
      drops[reason][c.kind]++;
      continue;
    }
    const g = lib.gradeFor(m.fkglTarget);
    byGrade.get(g)[c.kind].push({ ...c, complex, simple, fkglSrc: m.fkglSource, fkglTgt: m.fkglTarget, g });
  }
  const buckets = [...byGrade.values()].map(b => ({
    grade: b.grade, para: lib.shuffleWith(b.para, rand), sent: lib.shuffleWith(b.sent, rand),
  }));
  const before = buckets.map(b => ({ grade: b.grade, para: b.para.length, sent: b.sent.length }));
  console.log('[Clarity] After the cheap rules, per grade (para/sent): ' +
    before.map(b => `${b.grade}: ${b.para}/${b.sent}`).join(', '));

  // 5. Expensive rules lazily while the buckets fill
  let embedOk = true;
  let mainClaimFallbacks = 0;
  let mainClaimEmbedded = 0;
  let evaluations = 0;
  const accept = async (c, kind) => {
    if (++evaluations % 2000 === 0) console.log(`[Clarity] ${evaluations} candidates through the NER / embedding rules`);
    const r = render.renderPrompt(c.complex, c.g, words => lib.truthfulHints(words, c.simple, render.wordFormCandidates));
    const chars = r.system.length + r.user.length + c.simple.length;
    const promptReason = lib.promptDropReason({ chars, depthTier: r.spec.depthTier, kind });
    if (promptReason) {
      drops[promptReason][kind]++;
      return false;
    }
    const added = semantic.findMissingEntities(ner.detectEntities(c.simple), r.modelText);
    let lost = [];
    if (added.length === 0) {
      const sents = premises.splitSentences(r.modelText);
      let vectors = null;
      if (sents.length >= 3) {
        const v = embedOk ? await embed([...sents, r.modelText]) : null;
        if (v) {
          vectors = { sentences: v.slice(0, sents.length), paragraph: v[sents.length] };
          mainClaimEmbedded++;
        } else {
          if (embedOk) console.warn('[Clarity] all-minilm did not answer: main claim = first sentence from here on');
          embedOk = false;
          mainClaimFallbacks++;
        }
      }
      const claim = premises.mainClaimIndexes(sents.length, vectors);
      const keyTexts = new Set(meaning.keyEntityTexts(r.modelText, r.entities, claim, sents));
      lost = semantic.findMissingEntities(r.entities.filter(e => keyTexts.has(e.text)), c.simple);
    }
    const entityReason = lib.entityDropReason(added, lost);
    if (entityReason) {
      drops[entityReason][kind]++;
      return false;
    }
    c.prompt = r;
    return true;
  };
  const filled = await lib.waterFill(buckets, total - keep.length, accept);
  const evaluated = filled.reduce((a, b) => ({ para: a.para + b.evaluated.para, sent: a.sent + b.evaluated.sent }), { para: 0, sent: 0 });

  // 6. Examples
  const examples = [
    ...keep,
    ...filled.flatMap(b => b.accepted.map(({ kind, item }) => ({
      kind, sourceIds: item.chunk.map(p => p.id), articleId: item.chunk[0].articleId,
      source: item.complex, target: item.simple, g: item.g, fkglSrc: item.fkglSrc, fkglTgt: item.fkglTgt, prompt: item.prompt,
    }))),
  ];

  // 7. Final guard: no selected source overlaps a reserved text
  const reserved = await readJsonl(join(DATA, 'reserved.jsonl'));
  const index = lib.buildReservedIndex(reserved);
  const leaks = examples.filter(e => lib.reservedHits(index, e.source).length > 0);
  if (leaks.length > 0) {
    throw new Error(`${leaks.length} selected examples overlap reserved texts (first: ${leaks[0].sourceIds.join('+')}); fix dedupe.py`);
  }
  console.log(`[Clarity] Reserved re-check: 0 of ${examples.length} examples overlap ${reserved.length} reserved texts`);

  // 8. Split by article, shuffle, write
  const split = lib.splitByArticle(examples, N_DEV, N_TRAIN, rand);
  const toLine = e => JSON.stringify({
    messages: [
      { role: 'system', content: e.prompt.system },
      { role: 'user', content: e.prompt.user },
      { role: 'assistant', content: e.target },
    ],
    meta: {
      source_id: e.sourceIds.join('+'), article_id: e.articleId, g: e.g,
      fkgl_src: round(e.fkglSrc), fkgl_tgt: round(e.fkglTgt), kind: e.kind, hints: e.prompt.hinted,
    },
  });
  const train = lib.shuffleWith(split.train, rand);
  const dev = lib.shuffleWith(split.dev, rand);
  const trainText = train.map(toLine).join('\n') + '\n';
  const devText = dev.map(toLine).join('\n') + '\n';
  await writeFile(join(DATA, 'sft_train.jsonl'), trainText);
  await writeFile(join(DATA, 'sft_dev.jsonl'), devText);
  const sha = text => createHash('sha256').update(text).digest('hex');

  // 9. STATS.md
  const all = [...train, ...dev];
  const hist = list => lib.gradeHistogram(list.map(e => e.g));
  const kindCount = (list, k) => list.filter(e => e.kind === k).length;
  const withHints = all.filter(e => e.prompt.hinted.length > 0);
  const hintsTotal = all.reduce((n, e) => n + e.prompt.hinted.length, 0);
  const fmt = d => (d ? `${round(d.min, 1)} / ${round(d.median, 1)} / ${round(d.mean, 1)} / ${round(d.p95, 1)} / ${round(d.max, 1)}` : '—');
  const lengthRow = (label, list) => `| ${label} | ${list.length} | ` +
    `${fmt(lib.describe(list.map(e => engine.countWords(e.source))))} | ` +
    `${fmt(lib.describe(list.map(e => engine.countWords(e.target))))} | ` +
    `${fmt(lib.describe(list.map(e => e.prompt.system.length + e.prompt.user.length + e.target.length)))} |`;
  const cheapTotal = r => drops[r].para + drops[r].sent;
  const removedBySource = Object.entries(dedupeReport.removedBySource);
  const wa = sources['chaojiang06/wiki_auto'];
  const stats = [
    '# SFT data statistics (Prompt 10)',
    '',
    `Generated by \`npm run train:data\` (scripts/train-data/build-sft.mjs) on ${new Date().toISOString().slice(0, 10)}; seed ${lib.SFT_SEED}. ` +
    'The JSONL files are git-ignored; their SHA-256 is below so a rebuild can be checked.',
    '',
    '## Files',
    '',
    '| File | Examples | SHA-256 |',
    '|---|---|---|',
    `| training/data/sft_train.jsonl | ${train.length} | \`${sha(trainText)}\` |`,
    `| training/data/sft_dev.jsonl | ${dev.length} | \`${sha(devText)}\` |`,
    '',
    `Train and dev are split by article: no Wikipedia article is in both. ${split.dropped} selected examples were left out by the split (an article cut at the dev boundary, or train above ${N_TRAIN}).`,
    '',
    '## Sources',
    '',
    ...Object.values(sources).map(s => `- **${s.name}** (\`${s.repo}\` @ \`${s.sha}\`, ${s.revision}). Licence: ${s.license}. ${s.citation}`),
    `- Wiki-Auto: ${wa.stats?.articles ?? '?'} article pairs, ${wa.stats?.pairs ?? '?'} aligned pairs (connected components of the sentence alignment) from ${(wa.stats?.files ?? []).join(', ')}.`,
    '',
    '## Dedupe (training/prepare/dedupe.py)',
    '',
    `Normalised (NFKC, lowercase, no punctuation or symbols, collapsed whitespace); dropped on an exact match or ${lib.DEDUPE_NGRAM}-gram containment ≥ ${lib.DEDUPE_OVERLAP_MIN} in either direction.`,
    '',
    '| Reserved source | Reserved texts | Pairs removed |',
    '|---|---|---|',
    ...removedBySource.map(([s, n]) => `| ${s} | ${dedupeReport.reservedTexts[s]} | ${n} |`),
    `| **unique total** | ${Object.values(dedupeReport.reservedTexts).reduce((a, b) => a + b, 0)} | **${dedupeReport.removedUnique}** of ${dedupeReport.input} |`,
    '',
    'A pair can match several sources (ASSET and TurkCorpus share their source sentences), so the rows add up to more than the total. ' +
    `The build re-checked every selected source with the TypeScript matcher: 0 of ${examples.length} overlap.`,
    '',
    '## Counts after each step',
    '',
    `1. Deduplicated pairs: ${raw.length}; non-empty after cleaning Wikipedia leftovers: ${pairs.length}.`,
    `2. Keep slice: ${counts.keepCandidates} unchanged pairs; ${counts.keepSelected} selected (cap ${keepWanted} = ${lib.KEEP_SHARE_MAX * 100}% of ${total}), with source ≥ ${lib.MIN_SOURCE_WORDS} words and FKGL ≤ 12.`,
    `3. Runs: ${counts.runs} (${counts.multiRuns} with 2+ pairs); ${lib.RUN_PARA_SHARE * 100}% of the multi-pair runs became paragraph chunks of ${lib.PARA_MIN_PAIRS}–${lib.PARA_MAX_PAIRS} pairs: ${counts.paraCandidates} paragraph and ${counts.sentCandidates} sentence candidates.`,
    '',
    '| Rule (in order) | Ran on | Dropped para | Dropped sent |',
    '|---|---|---|---|',
    `| Source < ${lib.MIN_SOURCE_WORDS} words | all ${candidates.length} | ${drops.short.para} | ${drops.short.sent} |`,
    `| Word ratio outside [${lib.WORD_RATIO_MIN}, ${lib.WORD_RATIO_MAX}] | survivors | ${drops.ratio.para} | ${drops.ratio.sent} |`,
    `| FKGL(simple) ≥ FKGL(source) − ${lib.MIN_FKGL_DROP} | survivors | ${drops.fkgl.para} | ${drops.fkgl.sent} |`,
    `| Over ${lib.MAX_EXAMPLE_CHARS} characters | ${evaluated.para} para / ${evaluated.sent} sent evaluated lazily | ${drops.tooLong.para} | ${drops.tooLong.sent} |`,
    `| Prompt tier 'none' ("do NOT simplify") | same | ${drops.tierNone.para} | ${drops.tierNone.sent} |`,
    `| Simple side adds an entity | same | ${drops.addedEntity.para} | ${drops.addedEntity.sent} |`,
    `| Simple side loses a main-claim number / date | same | ${drops.lostKeyNumber.para} | ${drops.lostKeyNumber.sent} |`,
    '',
    `Cheap rules: ${['short', 'ratio', 'fkgl'].map(r => `${r} ${cheapTotal(r)}`).join(', ')}. ` +
    `The last four rules ran only on the ${evaluated.para + evaluated.sent} candidates the balance pulled; ` +
    `of those, ${pct(['tooLong', 'tierNone', 'addedEntity', 'lostKeyNumber'].reduce((n, r) => n + cheapTotal(r), 0), evaluated.para + evaluated.sent)} were dropped. ` +
    `Main claim: ${mainClaimEmbedded} paragraphs of 3+ sentences ranked with all-minilm, ${mainClaimFallbacks} fell back to the first sentence.`,
    '',
    '## Grade histogram (target grade g = clamp(round(FKGL(simple)), 3, 12))',
    '',
    '| g | Candidates after the cheap rules (para / sent) | Selected (all) | Train | Dev |',
    '|---|---|---|---|---|',
    ...before.map(b => `| ${b.grade} | ${b.para} / ${b.sent} | ${hist(all).get(b.grade)} | ${hist(train).get(b.grade)} | ${hist(dev).get(b.grade)} |`),
    '',
    'Selected includes the keep slice (g = the source FKGL rounded up). ' +
    `${all.filter(e => Math.abs(e.fkglTgt - e.g) > 1).length} selected examples have a target FKGL more than 1 grade from their g ` +
    `(the clamp to ${lib.GRADE_MIN}–${lib.GRADE_MAX}: very easy targets in bucket ${lib.GRADE_MIN}, very hard ones in bucket ${lib.GRADE_MAX}). ` +
    filled.filter(b => b.exhausted).map(b => `Bucket ${b.grade} ran out of candidates.`).join(' '),
    '',
    '## Kinds',
    '',
    '| Kind | Train | Dev |',
    '|---|---|---|',
    ...['para', 'sent', 'keep'].map(k => `| ${k} | ${kindCount(train, k)} (${pct(kindCount(train, k), train.length)}) | ${kindCount(dev, k)} |`),
    '',
    '## Lengths (min / median / mean / p95 / max)',
    '',
    '| Kind | n | Source words | Target words | Example characters |',
    '|---|---|---|---|---|',
    lengthRow('para', all.filter(e => e.kind === 'para')),
    lengthRow('sent', all.filter(e => e.kind === 'sent')),
    lengthRow('keep', all.filter(e => e.kind === 'keep')),
    lengthRow('all', all),
    '',
    '## Lexical hints (truthful)',
    '',
    'The app\'s findDifficultWords on the source, kept only when no word of the target shares one of its forms (wordFormCandidates); buildPrompt drops them for tier \'none\'.',
    '',
    `- Examples with a hint: ${withHints.length} of ${all.length} (${pct(withHints.length, all.length)}).`,
    `- Mean hinted words per example: ${round(hintsTotal / all.length)} (${withHints.length ? round(hintsTotal / withHints.length) : 0} per example that has a hint).`,
    '',
  ].join('\n');
  await writeFile(join(DATA, 'STATS.md'), stats);
  console.log(`[Clarity] Wrote ${train.length} train and ${dev.length} dev examples and training/data/STATS.md`);
} catch (err) {
  console.error(`[Clarity] ${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
