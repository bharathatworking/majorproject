# PROJECT_CONTEXT.md

A self-contained guide to the Clarity codebase for an assistant that cannot see the code. All paths are relative to the repo root. Anything marked **UNSURE:** is inferred, not verified in the code.

Generated from commit `2edaf92` (2026-10-15). If the code and this file disagree, the code wins. Update this file when you change something it describes.

---

## 1. Project goal

**Clarity** is a Chrome MV3 extension that rewrites web pages, pasted text or PDFs at the user's reading level.

- It runs fully on the device. A **local Ollama** server at `http://localhost:11434` does the rewriting, using the chat model chosen in Settings (default `qwen3:4b-instruct-2507-q4_K_M`, Apache 2.0, the bake-off winner: `eval/model-bakeoff/REPORT.md`) and, optionally, the `all-minilm` embedding model for a meaning check. A bundled NLI cross-encoder (`Xenova/nli-deberta-v3-xsmall`, run with Transformers.js in a Web Worker) checks every simplified sentence.
- There is no backend, no database and no cloud API. The only network targets are Ollama and the captured page itself. The NLI model and the ONNX Runtime wasm ship inside `dist/` (`npm run fetch-models`), never downloaded at runtime.
- What the user gets: a readability dashboard (eight grade metrics), a streamed paragraph-by-paragraph rewrite with click-to-reveal of the original, reading presets, a dyslexia font, focus mode, a progress chart and a downloadable JSON run report.
- The research angle (stages 6C and 7): checking that the rewrite keeps the meaning (thesis standard since 2026-10-19: one pre-registered **combined score**, a logistic regression over SBERT similarity, entities kept, NLI entailment and contradiction, and length, fit on the calibration set and frozen; before, SBERT ≥ 0.87 AND every entity AND no unsupported or contradicted sentence), scoring candidate outputs, and A/B-testing prompt variants through the "Extra quality (slower)" toggle.
- **Academic context:** this is the author's final-year university major project.
- **Thesis goal:** Clarity must beat Chrome's "Ask Gemini" (Gemini in Chrome) at simplification while preserving meaning, proven with a fair benchmark. The two targets:
  - At least 87% of paragraphs pass the meaning check.
  - At least 5% better overall than Ask Gemini.
- **Gemini is never Clarity's engine.** Gemini (Ask Gemini, the Gemini API, Gemini Nano) appears only as a benchmark baseline in a separate offline eval folder, never inside the extension.

## 2. Tech stack

| Area | Choice |
|---|---|
| Platform | Chrome Manifest V3, `minimum_chrome_version: '138'` |
| UI | React 19 + TypeScript (strict), hash routing, plain CSS |
| Build | Vite 8 + `@crxjs/vite-plugin` 2.x + `@vitejs/plugin-react`; `build.target: 'esnext'` |
| Typecheck | `typescript` 7.x via `tsc --noEmit`; `tsconfig.json` has `"types": ["chrome", "vite/client"]` |
| Tests | Vitest 4 (`environment: 'node'`, `globals: true`), `happy-dom` for one file, `@vitest/coverage-v8` |
| LLM | Ollama HTTP API: `/api/chat` (streamed NDJSON), `/api/embed`, `/api/tags` |
| Extraction | `@mozilla/readability`, `dompurify` |
| NLP | `compromise` + `compromise-dates` + `compromise-numbers` (entity detection) |
| NLI | `@huggingface/transformers` 4.3.1 (Apache-2.0) + `onnxruntime-web` (MIT; WebGPU backend first, single-threaded wasm fallback) in a Web Worker; model `Xenova/nli-deberta-v3-xsmall`, 8-bit quantized (87 MB), ONNX conversion of `cross-encoder/nli-deberta-v3-xsmall` (Apache-2.0; base `microsoft/deberta-v3-xsmall`, MIT). Labels: 0 contradiction, 1 entailment, 2 neutral |
| PDF | `pdfjs-dist` 6.x (worker loaded through a `?url` import) |
| Charts | `chart.js` 4 |
| Font | `@fontsource/opendyslexic` (bundled, no CDN) |
| Word list | `src/lib/metrics/data/common-words.txt`, 4,950 words from OpenSubtitles 2018 (hermitdave/FrequencyWords), **CC BY-SA 4.0** |

There is no lint config.

## 3. Folder structure

```
CLAUDE.md, README.md, PROJECT_CONTEXT.md
package.json, tsconfig.json, vite.config.ts, vitest.config.ts
icons/                       icon16/32/48/128.png
scripts/fetch-models.mjs     npm run fetch-models: NLI model (pinned, SHA-256 checked) + ORT wasm into public/
scripts/calibrate-nli.mjs    npm run calibrate-nli: ENTAILMENT_MIN table on the calibration set (Node, same model and TS code)
scripts/meaning-breakdown.mjs npm run meaning-breakdown -- <report.json>: why paragraphs failed, per run
scripts/calibrate-meaning.mjs npm run calibrate-meaning: SIM_MIN / ENTAILMENT_MIN / paragraph rule on paragraph-items.jsonl (dev choice, test report)
scripts/make-paragraph-items.mjs  fills missing DEFAULT_LLM_MODEL simplifications (the existing items are qwen2.5:3b) and hintedWords in paragraphs.jsonl (app prompt, Ollama)
scripts/add-paragraph-items.mjs   adds the missing #real items (balanced dev/test per source), strips proposed labels, auto-labels injected copies
scripts/labels.mjs           npm run export-labels / import-labels: blind labels.csv (real outputs, random order) ↔ paragraph-items.jsonl
scripts/replay-meaning.mjs   node scripts/replay-meaning.mjs <pdf|txt>: a run without Chrome (app split, prompt, DEFAULT_LLM_MODEL, meaning check + retry) and its failure breakdown
scripts/lib/nli-node.mjs     shared by the Node scripts: NLI model on onnxruntime-node, all-minilm via Ollama, Vite module loader, Wilson interval
scripts/bakeoff/             Prompt 9.4 base-model bake-off (eval only; no src/ change):
  lib.ts                     pure logic (cleaning, flags, resume, blind export/unblind, Wilson, McNemar, winner rule); tested
  app.mjs                    Vite loader: the app's exact prompt (Student preset, grade 8) and metrics for a paragraph
  fetch-wiki.mjs             one-off: Wikipedia lead paragraphs (API extract + revision id), cleaned
  check-data.mjs             npm run bakeoff:check: data rules + no overlap with eval/nli-calibration
  run.mjs                    npm run bakeoff:run: 3 models x 40 paragraphs (GPU) and x 10 (CPU-only), resumable, flag pass
  export.mjs / unblind.mjs   npm run bakeoff:export (blind labels_bakeoff.csv + blind_key.json) / bakeoff:unblind (REPORT.md)
scripts/checker/             combined meaning score (Prompt 9.5): fit on calibration only, pre-registered, tested once
  lib.ts                     pure: logistic regression (Newton, L2, balanced), stratified group k-fold, λ / feature / threshold choice, nested CV, cluster bootstrap, readTrainingFile guard (TRAINING_FILES for the fit, RESCALE_FILES for the rescale), stage 7 rescale (stage7Totals, quantileMatchThreshold), post-hoc helpers (rocPoints, bestCatchAt, featureMeans, rejectionDriver(s)); tested
  extract-features.mjs       npm run checker:extract -- --set calib|bakeoff: the 8 features from the app's own code → eval/checker/features_<set>.csv (cached by hash)
  fit.mjs                    npm run checker:fit: FULL and LITE on features_calib.csv only → fit.json + PREREG.md draft
  test-heldout.mjs           npm run checker:test: the one held-out test on the bake-off labels → REPORT.md (refuses to run twice)
  rescale-quality.mjs        npm run checker:rescale: stage 7 QUALITY_THRESHOLD by quantile matching on the 81 calibration items (reads RESCALE_FILES only, writes nothing)
  discussion.mjs             npm run checker:discuss: EXPLORATORY post-hoc analysis of the held-out test (ROC, shift, false-fail drivers) → eval/checker/DISCUSSION.md only
eval/nli-calibration/        paragraphs.jsonl (67 originals), pairs.jsonl (60 labelled sentences), paragraph-items.jsonl, labels.csv, SOURCES.md, README.md
eval/model-bakeoff/          bakeoff-only paragraphs.jsonl (40), SOURCES.md, README.md, outputs.jsonl, labels_bakeoff.csv (labelled), blind_key.json, models.json (licences, Unsloth evidence), REPORT.md
eval/checker/                features_calib.csv (81), features_bakeoff.csv (119), fit.json, PREREG.md (frozen values), REPORT.md (held-out test), DISCUSSION.md (post-hoc, exploratory)
eval/fixtures/               DEV regression fixtures only, excluded from every benchmark, calibration, bake-off and training set: uk-wiki-paste.txt (8 UK Wikipedia paragraphs), runs/uk-wiki-2026-10-19.json (its run report), README.md
public/models/, public/ort/  git-ignored; copied by Vite into dist/models/ and dist/ort/
src/
  manifest.ts                MV3 manifest (defineManifest); holds the pinned `key`
  background/index.ts        service worker: toolbar click, inject extractor, store doc, open app tab
  content-scripts/extractor.ts   thin injected wrapper around lib/extraction/extractor.ts
  app/
    index.html, main.tsx, App.tsx, app.css   (app.css is the ONLY stylesheet)
    pages/        Dashboard.tsx, Reading.tsx, Progress.tsx, Settings.tsx
    components/   DocumentList.tsx, NewDocDialog.tsx, Sidebar.tsx, Toast.tsx
    hooks/        useDocuments.ts, useRunState.ts, useDisplayPrefs.ts
  lib/
    extraction/   extractor.ts (noise strip -> Readability -> text-density fallback -> DOMPurify -> SHA-256)
    input/        paste.ts, pdf.ts, text-blocks.ts
    llm/          ollama-provider.ts, ollama-stream.ts, ollama-think.ts
    metrics/      engine.ts, syllables.ts, common-words.ts, word-set.ts, node-grade.ts,
                  difficult-words.ts, data/common-words.txt
    profile/      resolver.ts, presets.ts
    prompt-builder/  builder.ts, variants.ts
    quality/      config.ts (every quality constant), similarity.ts (UI-safe stats/badge),
                  semantic.ts (SBERT + entities), glossary.ts, premises.ts (SummaC premises),
                  nli.ts, nli.worker.ts, mode.ts (Auto/Full/Lite), meaning.ts (thesis verdict), score.ts
    render/       format-output.ts
    run/          simplify.ts, run-log.ts, timing.ts
    segmentation/ segmenter.ts, ner.ts, time-zones.ts, clutter.ts (Wikipedia citation markers and hatnotes out of the model input)
    storage/      documents.ts, cache.ts, progress.ts, settings.ts, nli-bench.ts
    utils/        hash.ts, html.ts, url.ts, restricted-pages.ts, write-queue.ts, build-info.ts
  types/          index.ts (all shared types), compromise-numbers.d.ts, crxjs.d.ts
tests/
  mocks/          chrome.ts (installChromeMock), fixtures.ts (makeReport, makeDocInput,
                  makeAssessment, makeEntailment, makeRunMeaningSummary)
  unit/           30 *.test.ts files (see section 8)
```

`dist/`, `node_modules/` and `coverage/` are git-ignored.

## 4. Architecture & data flow

### Three entry points

| Entry | Runs in | Role |
|---|---|---|
| `src/background/index.ts` | MV3 service worker | Toolbar click → inject extractor → store captured page → open or focus the single app tab |
| `src/content-scripts/extractor.ts` | The web page, injected on demand | Calls `extractArticle` and sends `EXTRACTION_RESULT` or `EXTRACTION_FAILED` to the worker |
| `src/app/main.tsx` → `src/app/App.tsx` | Extension page tab | React UI with routes `#/dashboard`, `#/reading`, `#/progress`, `#/settings` |

- The app page is included in the build through `options_ui: { page: 'src/app/index.html', open_in_tab: true }`, because crxjs has trouble with `rollupOptions.input`.
- The extractor is built as a standalone IIFE via `contentScripts.standaloneFiles` in `vite.config.ts` and imported in the background as `'../content-scripts/extractor.ts?script'`. Keep the two in sync.
- **The UI and the background never message each other.** They communicate only through `chrome.storage`; the app listens with `chrome.storage.onChanged`.

### End-to-end flow

1. **Input**
   - *Toolbar click:* the worker sets session `capture:status = { state: 'extracting' }` and injects the extractor **before any other await** (the `activeTab` grant is tied to the click gesture), then calls `openOrFocusApp()`. Restricted URLs (`isRestrictedUrl`: chrome://, Web Store, other extensions) are not injected; a friendly error goes into `capture:status` and is logged with `console.log`, not `console.error`. Text shorter than 100 characters counts as "No readable article text". On success the worker calls `upsertDocument({ report: null, ... })`.
   - *Paste or PDF:* `NewDocDialog` calls `createDocumentFromPaste` (`src/lib/input/paste.ts`) or `createDocumentFromPDF` (`src/lib/input/pdf.ts`, `pdfjs-dist` imported dynamically), then the same `upsertDocument`. Both build their HTML with the pure `src/lib/input/text-blocks.ts`:
     - **Paste:** `textToBlocks` starts a block at every blank line and at every line that begins with a list marker (`1.` `2)` `a.` `b.` `i.` `ii.` `o` `•` `-` `▪` …), with Word's list levels as depth (`1.`/`•`/`-` = 0, `a.`/`o` = 1, `i.`/`▪` = 2; never more than one level below the previous item). `blocksToHtml` writes `<p>` and `<li data-depth="d">` inside `<ul>`/`<ol>`.
     - **PDF:** `pdfPagesToHtml` runs the same `textToBlocks` over pdf.js's lines (a newline at each `hasEOL`) of all pages read as one text, so list-marker lines become list items and a sentence crossing a page break stays one node. `textContent` (and the dedup hash) is still the flattened page text, so a PDF added before this keeps its stored HTML until it is deleted and added again.
     - **Hard-wrapped text** (PDF lines, or text pasted from a PDF viewer; `wrapWidth`: the 90th-percentile prose line is 30–130 characters and ≥ 50% of lines reach 60% of it): a block also ends after a short line (< 80% of its block's longest line) that ends a sentence or label, and before a label line ("Tasks:") after a short line. Unwrapped text keeps the join-until-blank-line rule.
     - **Headings:** a line that starts a block, has ≤ `MAX_TITLE_WORDS` (8) words, starts with a capital or digit, has no ending punctuation (. ! ? : ; , …) and is followed (blank lines allowed) by a longer non-list line of more than 8 words (`isHeadingLine`) becomes a `heading` block, emitted as `<h2>` (so the segmenter gives a `heading` node): "Etymology and terminology" + its section, "User Test Plan Example" + a long line. Before this rule, a lowercase section title became a 3-word paragraph that the model turned into two bullets (eval/fixtures UK run). Documents pasted before keep their stored HTML: delete and re-paste to get the headings.
     - **Titles:** a line that is not a heading, of ≤ 8 words without end punctuation, in Title Case or ending in ":" (`isTitleLine`), merges into the next paragraph when a capitalised line follows (blank lines allowed): "Situating Context: You are…". Before a list marker it stays its own paragraph ("Objectives:"). Sentence-case lines ("Meeting plan") are not titles.
     - **Inline lists:** a run of ≥ 2 markers `1.`, `2.`, … (at the start, after a sentence end or ":", before a capital) in one paragraph becomes `<ol>` items after its lead-in (`splitInlineList`), e.g. flattened "Objectives: 1. … 2. … 3. …".
     - **Both:** any block over `MAX_NODE_SENTENCES` (8) sentences or `MAX_NODE_WORDS` (150) words is split greedily at sentence boundaries (`chunkSentences`). `splitSentences` attaches a bare marker ("3.", "b.", "ii.") to the sentence after it, so no node ends in a marker.
     - The split happens when a document is created, never in the segmenter, so stored documents keep their HTML and node IDs (dedup never rewrites `html`); they are not migrated.
   - All three paths hash with `sha256` from `src/lib/utils/hash.ts`, so dedup works. Re-capturing identical content refreshes the existing document and keeps its results.
2. **Storage → UI.** `upsertDocument` sets `docs:active`. `useDocuments` sees it through `onChanged` and loads the document. It also listens for `doc:<id>` changes so `saveDocument` writes reach React state.
3. **Analysis (in the app, never in the worker).** `Dashboard` sees `report === null`, runs `computeReadabilityReport(textContent, await getCommonWordSet())` and saves the result. "Simplify now" stays disabled until a report exists.
   - `estimatedGradeLevel` is the mean of Flesch-Kincaid, Gunning Fog, SMOG, Coleman-Liau and ARI.
   - Jargon density and Dale-Chall count a word as difficult unless `isCommonWord` finds it, or a suffix-stripped base form (-s/-es/-ies, -ed/-ied, -ing, -ly/-ily, doubled consonants), in the custom words or the common-word list.
4. **Simplify.** `Reading` → `App.handleStartRun(doc, mode, startIndex)` → `useRunState` (which loads `src/lib/run/simplify.ts` with a dynamic `import()`) → `runSimplification`.
   - `RunMode`: `'remaining'` ("Simplify now" and "Simplify again") runs only nodes without a `done` result (`selectNodesToRun`). `'all'` ("Re-simplify all") runs every node and skips cache reads, but still writes to the cache.
   1. **Profile.** `getUserProfile`, `getLlmModel`, `getExtraQuality` and `getQualityMode` read sync storage. `resolveProfile(profile, currentGrade)` (`src/lib/profile/resolver.ts`) returns a `SimplificationSpec`:
      - The target grade is `targetGradeLevel`, or for `'auto'` the age group default (child 4, teen 8, adult 12).
      - The depth tier comes from current minus target: ≤0 `none`, ≤2 `light`, ≤5 `moderate`, else `aggressive`. The max sentence length per tier is 12, 16, 20 or 25 words.
      - Reader flags: `avoidIdioms` (purpose `esl`), `oneIdeaPerSentence` (purpose `dyslexia-friendly`), `explainTerms` (purpose `expert-to-lay` or familiarity `novice`) and `keepTerms` (familiarity `expert`, which wins over `explainTerms`).
      - The `esl` and `dyslexia-friendly` purposes cap sentences at 15 words, except in the `none` tier.
   2. **Segment.** `segmentHtml(html, title, hash)` (`src/lib/segmentation/segmenter.ts`, uses `DOMParser`) returns flat `ContentNode`s with **deterministic IDs `n0, n1, …`**. `<li>` items are flattened to top-level `list-item` nodes; `data-depth` becomes `depth` (clamped to 0–3, left out at 0) and `<ol>` items get `ordered: true`. No NER happens here. `simplifiableNodes` (drops tables and empty nodes) is the shared filter, so a node index means the same node in both Reading and the run.
   3. **Order.** `rotateFrom(nodes, startIndex)` starts at the first node visible in Reading and wraps around. Each node takes the first path that applies:
      - **Clutter (before every path below):** `cleanForModel` (`src/lib/segmentation/clutter.ts`, pure) removes Wikipedia citation markers `\[(\d{1,3}|[a-z]{1,2}|note \d+|citation needed)\]` (`[sic]` and other brackets stay) and hatnotes ("See also:", "Main article(s):", "Further information:", "For other uses" at a line start; a pasted hatnote that runs into its paragraph ends at the first sentence end or at the first sentence-starting capital word such as The / In / It that doesn't follow "and", "or", ",", ";" or ":"). The cleaned text is what NER, the prompt, the already-simple check, the cache key, the meaning check and the candidate score see; the stored and displayed `originalText` stays as captured (click-to-reveal shows the markers). The run log records it as the node's `modelInput` when it differs; a node that was only a hatnote is kept as is (`'skipped'`, `modelInput: ''`).
      - **Heading:** `heading` nodes (page h1–h6, pasted heading lines) are kept as written: stored as `done` with `skipped: true`, run-log source `'heading'` (`summary.counts.heading`), meaning status `'excluded'`. No NER, cache, model call or check, so they never count in the pass rate; Reading renders them as headings (no "already simple" tag). They still serve as rolling context for the next node.
      - **Already simple:** `isAlreadySimple` (`src/lib/metrics/node-grade.ts`) finds the node's grade at or below the target. The original is stored as `done` with `skipped: true`, with no model call.
      - **Cache hit:** `src/lib/storage/cache.ts` keys on `sha256(node text + sorted spec JSON + model)`, plus a quality tag for Extra-quality runs. Only outputs that passed the stage 6C checks are cached, with their verdict. Entries carry `format: CACHE_FORMAT` (4); older entries (judged by the old 0.80 standard, by the AND of thresholds before the combined score, or written with the old entity line, which could leave a copied entity list in a Lite entry) are misses. A cached verdict that was not fully checked (NLI or embedding model missing then) is a miss while both checks are available.
      - **Model:** `detectEntities` (`src/lib/segmentation/ner.ts`, dynamically imported) runs for this node only, then steps 4 to 7 below.
      - The rolling context is the last sentence of the previous node in **document** order, if that node is done.
   4. **Prompt.** `buildPrompt` (`src/lib/prompt-builder/builder.ts`) returns a system prompt plus a user prompt. Reader flags become numbered system rules 7+ via `readerRules`. The user prompt carries a node-type hint, the entity line, the rolling context and a lexical hint. The entity line names each entity once (`entityList`, case-insensitive) and says "Keep these names, numbers and dates inside your sentences; do not list them separately: …"; the old "Preserve the following entities EXACTLY as written: Roman, Roman, 43, …" was copied verbatim into a retry answer (eval/fixtures UK run). The lexical hint: `findDifficultWords` lists up to 8 (`MAX_DIFFICULT_WORDS`) uncommon, non-entity words longer than 3 letters. The hint is left out when `keepTerms` is on or the tier is `none`. The last parameter selects a prompt variant (`standard` adds nothing).
   5. **Call.** `createBaseSession` first POSTs `/api/show` for the model once per run: a 404 there is the missing-model path (one banner before any node), and its `capabilities` decide `think` through `thinkSetting` ([ollama-think.ts](src/lib/llm/ollama-think.ts), pure, shared with `scripts/bakeoff/run.mjs`): `think: false` for models listing `thinking` (qwen3, gemma4), no `think` field otherwise. No temperature is sent (each model's Modelfile default; a fixed temperature is Prompt 11). `OllamaProvider.simplifyChunk` POSTs `/api/chat` with `stream: true` and `keep_alive: '10m'`. `parseOllamaStream` (`src/lib/llm/ollama-stream.ts`) buffers lines split across chunks, skips malformed lines with a `[Clarity]` warning, throws on `{"error": ...}` lines and stops at `done: true`. Ollama is stateless, so the "session" is just a stored system prompt (`createBaseSession`).
   6. **Stage 6C: meaning preservation, thesis standard** (`assessMeaning` in `src/lib/quality/meaning.ts`; every constant in `config.ts`). It covers every node except headings and texts under 8 words (`shouldCheckNode`, `MIN_WORDS_FOR_CHECK`). Since 2026-10-19 a version **passes** when its **combined score** reaches the frozen threshold (the "Combined score" item below). SBERT, entities and NLI are the measured parts it is built from:
      - **SBERT:** `checkMeaning` (`semantic.ts`) embeds original and output in one `/api/embed` call; the cosine is the `sbert` feature (`SIMILARITY_THRESHOLD = 0.87` no longer decides; it is the old rule, kept as the evaluation baseline).
      - **Entities:** the entity rule (`entityVerdict` in `verdict.ts`) passes when the share of the original's distinct entities still present is ≥ `ENTITY_RECALL_MIN` (1 = every entity, today's value until calibration) **and** every number, date and time zone of the original's **main claim** is kept (`keyEntityTexts` in `meaning.ts`). The main claim is the original sentence whose all-minilm embedding is closest to the whole paragraph (`mainClaimIndexes` in `premises.ts`, from the node's embedding memo); every sentence of a 1–2 sentence original or of a list item; the first sentence without the embedding model. Key drops are named first in the reasons; other drops only when the share falls below the minimum. The run log records `missingKeyEntities` per candidate and `meaningThresholds.entityRecallMin`. Matching (`findMissingEntities`, case, possessive 's and thousands separators ignored). Names (person, org, place) compare on core tokens (`coreTokens`: a leading in / on / at / the is dropped; letters with diacritics count as letters); failing that, a name is kept when all its capitalised words are in the output (titles like Professor don't count), a person's surname is ("Marie Curie" by "Maria Skłodowska Curie"), or its acronym is, in capitals ("World Health Organization" by "WHO"); a dropped or replaced name ("Cordillera Rumi Cruz" → "a mountain range") still fails. Numbers, dates and time zones compare **by value** (`valueSignature` in `src/lib/quality/values.ts`, compromise-numbers only): every number, number+unit ("21 year", "30 minute", "45 percent"), month, weekday and time zone of the entity must be in the output, and modifiers (next, about, over, aged, age, during, …) don't count. Centuries match however they are named: "17th century", "seventeenth century", "17th-century" and "1600s" all give `century:17`, and the number tokens that only spell the century (`centuryParts`) are not required, so "17th century" is kept by "1600s" and the other way round, while "19th century" still keeps a plain "19th"; decades ("1920s") are unchanged. So "for the next 21 years" is kept by "for 21 years", "aged 45" by "at age 45", "three" by "3", "in PST time zone" by "during PST"; "1893" missing or "21 years" → "21 months" fails. An entity without a comparable value can't be checked and counts as kept. In a date with a number the weekday is redundant ("Sunday 2 September 1666" is kept by "Sep 2, 1666"), and NER skips a unit conversion in brackets ("2,300 kilometres (1,400 mi)" keeps 2,300 only). `detectEntities` cleans its matches (each rule removes junk seen in the test plan run): leading brackets/quotes and trailing punctuation, brackets, quotes and dashes are trimmed; a match is cut at a sentence end or an opening bracket ("Team Cal. The other" → "Team Cal"); a date loses its leading prepositions and "the" (in, on, at, during, over, throughout, through, around, about, by, since, from, until, before, after, within, for: "Over the 17th century" → "17th century"); a capitalised ordinal word (First … Twentieth) followed by a capitalised word is part of a name, not a number ("Second World War", "First Minister"); numbers and dates without a value are dropped ("an", "week", "any hours"); inline list markers ("Objectives: 1. Formative") are not numbers; names need a capital letter, and a name directly followed by ":" is a label ("Common Meeting Times:"). A date that is only a time-zone abbreviation (`TIME_ZONES` in `src/lib/segmentation/time-zones.ts`) is typed `timezone`, and a dropped one reads "You dropped the time zone PST." "9am EST" stays a date. `entityRecall` is over distinct entity texts.
      - **NLI** (`checkEntailment` in `nli.ts`): the output is split into sentences (`splitSentences`: `toPlainText`, then the `(?<=[.!?])\s+` rule and line breaks, so each bullet is a sentence); these are the hypotheses. **Premises follow SummaC zero-shot** (Laban, Schnabel, Bennett & Hearst, 2022, "SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization", *TACL* 10, 163–177), in `premises.ts`: every original sentence plus every window of 2 adjacent original sentences (`buildPremises`). Each hypothesis is scored only against its `NLI_TOP_PREMISES = 3` most similar premises: ranked by all-minilm cosine (`rankPremises`, using the run's per-node embedding memo, so the original's premise vectors are computed once per node), or by content-word overlap (`lexicalRank`) when the embedding model is missing or fails; with 3 premises or fewer all are scored (`ranking: 'all'`). Entailment of a sentence = max over its premises; contradiction = the contradiction of the best-entailing premise (`NLI_CONTRADICTION_AGG = 'best-entailing'`). The alternative `'max'` (highest contradiction over the scored premises) was tried first and dropped after calibration, because a faithful sentence was often "contradicted" by a premise about something else, such as another date. All of a node's pairs go to the worker in one call. Each sentence's scores (`sentenceScores`: entailment, contradiction, exempt) are returned, and the paragraph verdict is the pure `nliVerdict` in `verdict.ts` (shared with the calibration scripts): a sentence is unsupported when its entailment < `ENTAILMENT_MIN` (non-exempt only) and contradicted when its contradiction > `CONTRADICTION_MAX = 0.2`. **Hypothesis context** (`hypothesisFor`, `needsContext`): a simplified sentence of fewer than `NLI_CONTEXT_MAX_WORDS` (7) words, or one starting with This / That / It / These / They (`NLI_REFERRING_START`), is scored as "<previous sentence> <sentence>" (premise ranking included), because alone it has nothing to entail ("That's called inflation.", "Anatocism is the same."); the first sentence never gets context, verdicts and reasons still name the sentence alone (`sentenceScores[i].hypothesis` holds the scored text), and glossary exemptions are decided on the sentence itself. The run log records it as `meaningThresholds.hypothesisContext`. Paragraph rule `NLI_PARAGRAPH_RULE`: `'A'` = no unsupported sentence; `'B'` = one neutral (unsupported, not contradicted) sentence is tolerated when the output has `NLI_NEUTRAL_MIN_SENTENCES = 6` or more (`toleratedSentences`). A contradiction always fails, and an output with no sentences fails.
      - **Glossary exemptions** (`glossary.ts`, pure, reusable by the offline benchmark): a sentence that defines one of this node's hinted words (`hintedWords` in `builder.ts`, the exact lexical-hint list; empty with `keepTerms` or tier `none`) skips the entailment requirement, never the contradiction one. A definition is "X means …", "X refers to …", or "X is" followed by a / an / the / a kind of / when / how; "Inflation is rising." is **not** a definition. One exemption per word; the cap is `max(1, floor(0.3 × sentences))` (`GLOSSARY_EXEMPTION_MAX_RATE`) for nodes of 2+ sentences, and a 1-sentence node gets none. Parenthetical definitions of hinted words (`word (definition)`) are removed before NLI. Each exemption is logged.
      - **Runtime:** `nli.worker.ts` runs `AutoTokenizer` + `AutoModelForSequenceClassification` with the **same q8 weights on every backend** (`dtype: 'q8'`), `env.allowRemoteModels = false`, model files from `chrome.runtime.getURL('models/')` and the wasm from `ort/` (`wasmPaths` set explicitly, `useWasmCache` off — the default loads the factory from a `blob:` URL, which the CSP blocks). **WebGPU first:** the worker requests the system's adapter once per worker (no `powerPreference`: Chrome ignores it on Windows, crbug 369219127, and its warning lands on the Errors page; which GPU Chrome uses is set in Windows Settings → System → Display → Graphics), hands it to ONNX Runtime as `env.backends.onnx.webgpu.adapter`, loads with `device: 'webgpu'` and runs one warm-up pair; any failure falls back to `device: 'wasm'` (one thread). ORT's WebGPU build loads the same `ort-wasm-simd-threaded.asyncify` files, and WGSL shaders are not script, so **no CSP change** is needed. The page logs `[Clarity] NLI model … loaded on webgpu (nvidia …) in N ms` (or `wasm`, with the WebGPU error). Each pair is also tokenized untruncated; pairs over 512 tokens are flagged `truncated` and counted per node and per run. Labels come from the model's `id2label`. `NliClient` sends a node's uncached pairs in batches of `NLI_BATCH_SIZE_WEBGPU = 32` or `NLI_BATCH_SIZE_WASM = 8` (by the backend it loaded on; `batchSizeFor`) and keeps an in-memory LRU (`NLI_CACHE_MAX = 500`) keyed by `sha256(premise, hypothesis)`. The worker is created lazily, once per app tab.
      - **Benchmark switch:** `chrome.storage.local.set({ 'debug:nliDevice': 'wasm' })` in DevTools (app tab) forces wasm for the next load (reload the app tab); remove the key to go back to WebGPU first. Used to measure both backends on one machine. The page checks for a WebGPU adapter once per tab session (`hasWebGpuAdapter` memoizes its answer).
      - **fp16 experiment (debug only; the default stays q8):** `npm run fetch-models -- --fp16` adds `onnx/model_fp16.onnx` (143 MB, pinned by SHA-256). `debug:nliDevice = 'webgpu-fp16'` makes runs load the fp16 weights on WebGPU (wasm fallback stays q8); the bench record and the run log's `nli` record the `dtype`, and the summary line says `backend webgpu fp16 …`. With that flag `main.tsx` also loads `nli-experiment.ts` (a lazy chunk with the calibration set imported `?raw`) and installs `clarityNliExperiment()` in the app tab's console: it checks the 15 calibration simplifications with a q8 and an fp16 client (same premises, warmed up, one after the other) and downloads `clarity-nli-experiment-<date>.json` (ms per paragraph per dtype, paragraph and sentence decision agreement, false-fail/catch, largest probability differences). `npm run calibrate-nli -- --compare-fp16` measures decision agreement on the CPU (no WebGPU timing).
      - **Combined score** (`src/lib/quality/checker.ts`, pure; values `COMBINED_SCORE_FULL` / `COMBINED_SCORE_LITE` in `config.ts`, pre-registered in `eval/checker/PREREG.md`): `score = sigmoid(Σ w·(x − mean)/std + b)`, pass = score ≥ threshold. Candidate features (`checkerFeatures`): `sbert`, `entity` (keep ratio), `nliMin`, `nliMean`, `contra` (max contradiction), `mainClaim` (`checkMainClaim` in `nli.ts`: the original's main-claim sentence as hypothesis against the output's SummaC premises), `numbers` (share of main-claim numbers/dates kept), `lenRatio`. Frozen **FULL** = sbert, entity, nliMin, contra, lenRatio (threshold 0.569); **LITE** = sbert, entity, lenRatio (threshold 0.536). FULL is used when NLI scored the version; LITE in Lite mode or when NLI is unavailable or fails (then `nliChecked: false`). A missing SBERT value is scored at its training mean (z = 0) and the version is not fully checked. `mainClaimEntailment` runs only when FULL uses `mainClaim` (the frozen one does not), and only after NLI ran. The score, `scoreModel` and the feature values are on `MeaningAssessment`; `score`/`scoreModel` are stored on the result (`StoredMeaning`) and in the run log, whose `meaningThresholds` also record `verdict: 'combined-score'` and both models.
      - **Reasons and retry:** the features that pulled the score down (negative w·z), worst first, each named by its reason string: `entity`/`numbers` → "You dropped the number 1945." (key entities first), `contra` → "This sentence contradicts the original: "…"", `nliMin`/`nliMean` → "This sentence is not supported by the original: "…"" (sentences below `ENTAILMENT_MIN`, else the least supported one), `sbert` → "The meaning drifted from the original (similarity 0.82).", `mainClaim` → "You lost the main point of the original: "…"", `lenRatio` → "You left out too much of the original (…)". `failures` maps them to kinds (sbert and lenRatio → similarity, entity and numbers → entities, NLI and mainClaim → unsupported, contra → contradiction; plus `echo` from the echo guard). A failure triggers one retry. `buildRetryInstruction(retryInputOf(assessment))` prepends **prose, never a list**: one sentence naming at most `MAX_RETRY_REASONS = 3` missing items in quotes, key entities first ("Your last version left out "Roman" and "1801". Work them into your existing sentences; never output a list of names or numbers."), then the other reasons as "Fix this: …" / "Also fix this: …" (3 items in all), then "Output only the rewritten text." (`MEANING_RETRY_INSTRUCTION` when nothing specific is named). The old "Fix these problems:\n- You dropped …" bullets made qwen3 append the prompt's entity list.
      - **Echo guard** (`src/lib/quality/echo.ts`, pure; `assessMeaning(…, { echoGuard: true })` in the app, off in the eval scripts so their numbers don't move): a version fails with failure `'echo'` (reason "Your version has a line that only lists names or numbers: "…"" or "Your version repeats the instructions …") when a line splits at commas/semicolons into ≥ `ECHO_MIN_PARTS` (4) parts, ≥ `ECHO_MIN_SOURCE_SHARE` (0.6) of them source items (an entity text, a number or year, or a capitalised / numeric phrase found verbatim in the original; a part starting with "and"/"or" never is one) and no other part has more than `ECHO_MAX_OTHER_WORDS` (3) words, or when it contains instruction wording (`RETRY_ECHO_PHRASES`) the original doesn't have. The last list rule keeps real sentences ("It is surrounded by the Atlantic Ocean, North Sea, English Channel, Celtic Sea, and Irish Sea."). The combined score, its features and threshold are untouched: **pass = score ≥ threshold AND no echo**; `echo: true` is stored on the result. If the kept version still echoes, the run removes its echo lines (`stripEchoLines`) and re-assesses it without a model call (an extra `echoStripped` candidate in the run log). `pickBetterVersion` keeps a passing version, then the higher `meaningScore` (= the combined score); the first version wins ties. **Retry policy** (`shouldRetry` in `meaning.ts`; `RETRY_SKIP_UNSUPPORTED_ONLY`, `RETRY_SKIP_MAX_CONTRADICTION` = `CONTRADICTION_MAX`, `RETRY_SKIP_MIN_ENTITY_RECALL` = 1 in `config.ts`): a version whose only failure is `unsupported`, with max contradiction below the limit and every entity kept, is **not retried**; it stays "Not verified" (failed in the pass rate) and the node log gets `retrySkipped: 'unsupported-only'`. Entities, contradiction, similarity and echo failures are retried. With Extra quality, such a failure no longer triggers the variants (a total below `QUALITY_THRESHOLD` still does).
      - **Fallbacks never fail the run.** An embed 404 shows `EMBED_MISSING_NOTICE` once and drops SBERT for the run. An NLI model that can't load (`NliUnavailableError`: missing files, wasm blocked, worker crash, 60 s load timeout) shows `NLI_MISSING_NOTICE` once and drops NLI for the run (`nliChecked: false`). A single failed NLI request skips NLI for that node only. `passed` means the combined score reached its threshold; `fullyChecked` means SBERT and NLI both ran (entities always run).
      - **NLI timing:** each assessed version logs `[Clarity] NLI nX: S sentences, P pairs (ranking premises, C cached, T truncated, E exempt) N ms (rank R, score S)`; the run summary has the average NLI ms per paragraph, the backend and the truncated pairs. Above `NLI_BUDGET_MS = 1000` the run logs `[Clarity] NLI above budget: …` once with `console.info`, never `console.warn`, because warnings land on the chrome://extensions Errors page, which stays for real errors.
      - **Quality mode** (`mode.ts`, sync `qualityMode`: `'auto'` default, `'full'`, `'lite'`). **Full** = everything above. **Lite** = SBERT + entities only: NLI never loads, results are stored with `nliChecked: false` and `lite: true` (so the coverage rule keeps them out of the thesis pass rate), at most the one 6C retry, and "Extra quality" best-of-N is off (the run log records the effective `extraQuality: false`). **Auto** measures instead of guessing: when the NLI model first loads, `prepareNli` (`nli.ts`) times a realistic paragraph after a warm-up pass: `NLI_BENCH_PARAGRAPH` (a made-up ~150-word, 6-sentence original and a 6-sentence simplification), whose `BENCH_PAIRS` = 3 premises × `NLI_TYPICAL_SENTENCES` (6) = 18 pairs come from `entailmentPairs` (the same hypotheses and premises as `checkEntailment`, word-overlap ranking; a test checks they match), scored in the backend's batch size (`NliClient.bench`). It stores `nli:bench` (`NliBenchRecord`: backend, adapter vendor, ms, `predictedParagraphMs` = that ms, `benchFormat` 2, version, `webgpuAdapter`, device). The old benchmark (8 short pairs × a factor) predicted 1256 ms per paragraph where the UK run measured 4875 ms; records without `benchFormat` 2 are stale. The run report's `nli` puts the prediction next to what the run measured: `measuredParagraphMs` (mean NLI ms per scored version), `measuredScoreMs` (pair scoring) and `measuredRankMs` (premise ranking through Ollama's all-minilm, which competes with the chat model and which the benchmark can't predict), and the run logs `[Clarity] NLI predicted … ms vs measured … ms per paragraph (scoring …, premise ranking …)`. `chooseQualityMode` picks Lite only when there is no WebGPU **and** the prediction is above `AUTO_LITE_PARAGRAPH_MS = 3000`; otherwise Full, and Full when nothing could be measured. A stored benchmark decides without loading the model; it is stale (`isBenchStale`) after an extension update, when the page's WebGPU adapter appears or disappears, when the requested device changes or the benchmark format is older, and `prepareNli` also re-measures when the worker's actual backend differs. The run logs `[Clarity] Quality mode lite (auto: no WebGPU, benchmark … ms/18 pairs → … ms per paragraph > 3000)`.
   7. **Stage 7: candidate scoring** (`src/lib/quality/score.ts`). `total = 0.5·meaning + 0.3·readability + 0.2·length` (`WEIGHTS`), where meaning is `meaningScore(assessment)` = the combined score (1 for unchecked nodes; before 2026-10-19 it was similarity × entity recall × minimum entailment). The frozen score is strongly regularised and stays roughly in 0.35–0.7, so totals are lower than before; `QUALITY_THRESHOLD` was therefore rescaled from 0.75 to **0.718** (2026-10-19, `npm run checker:rescale`): quantile matching on the 81 calibration items only, so the share of items below the threshold is the same under the new total (67/81 = 82.7% below 0.718) as under the old one (67/81 below 0.75; under the new total 93.8% would have been below 0.75). The old value is kept as `QUALITY_THRESHOLD_OLD_SCALE`, the anchor, and a unit test checks the calibration share stays within 5 points.
      - Extra quality **off** (the default): the 6C retry, at most 2 calls.
      - Extra quality **on**: if the streamed `standard` output fails 6C or scores below `QUALITY_THRESHOLD = 0.718`, the `stepwise` and `example-guided` variants (`src/lib/prompt-builder/variants.ts`) are generated without streaming, in place of the 6C retry. `pickBestCandidate` prefers passing versions, then the highest total; ties go to `standard`.
      - Hard cap: `MAX_MODEL_CALLS_PER_NODE = 3`. Headings and texts under 8 words always get one call.
   8. **Persist.** Each finished node (`done` or `error`) is saved immediately with `saveDocument`. The kept version's verdict goes on the result (`StoredMeaning`: `similarity`, `entityRecall`, `minEntailment`, `maxContradiction`, `nliChecked`, `passed`, `reasons`). Each node logs `[Clarity] Node nX (source, meaning status) N.NN s`, and the run logs a summary line (`summarizeRun` in `src/lib/run/timing.ts`) with the meaning pass rate, coverage and NLI average. Below 90% coverage (`THESIS_COVERAGE_MIN`) it warns that the pass rate is not thesis-grade.
      - **Thesis metric** (`summarizeMeaning` / `meaningStats` in `similarity.ts`): each node is `passed`/`failed` (fully checked), `not-fully-checked` (a check fell back), `excluded` (headings, short texts, already simple) or `error`. Pass rate = passed / fully checked; coverage = fully checked / (fully checked + not fully checked). The run log's `summary.meaning` has these counts, `avgNliMs`, and the glossary `exemptedSentences` count and `exemptionRate`.
      - **Failure breakdown:** every assessment names its failed checks (`failures`: `'similarity' | 'entities' | 'unsupported' | 'contradiction'`, from `failureKinds` in `meaning.ts`; empty exactly when it passed), stored on the result, the kept version and each candidate. `summary.meaning.failureBreakdown` counts the failed kept versions per kind (one can count under several) plus `failedParagraphs`, and the run logs `[Clarity] Meaning failures: similarity 4, entities 5, unsupported 5, contradiction 0 (of 9 failed)`. `npm run meaning-breakdown -- <report.json>` prints it per run, classifying format-2 reports from their reason strings (`failuresFromReasons`).
   9. **Finish.** When the run finished any node (also when cancelled) it computes and saves `simplifiedReport`; when the run is complete (not cancelled, or cancelled only after its last node finished) it calls `recordSession(targetGrade)` and logs `[Clarity] Session recorded (N this week)`; then `addRunLog`. Each post-run write is guarded (`console.error` on failure), so one failure can't skip the session, the run log or `onComplete`; `useRunState` also catches a rejected run so it never stays "active". Week keys are local Mondays (`getWeekStart` in `progress.ts`); old UTC-shifted Sunday keys are read as the Monday after (`normalizeWeekStart`) and merged. The Progress card shows Before vs. After when `beforeAfterOf(activeDoc)` has both reports. The report and rolling context use `toPlainText`; the stored text keeps the raw output with its bullet markers.
5. **Display.** `Reading` re-segments the HTML and merges `runState.liveResults` with `doc.results`. `NodeBlock` renders `parseSimplifiedText` blocks as real `<p>`, `<ul>`/`<ol>` and `<li>` elements (never `dangerouslySetInnerHTML`). Sub-bullets nest: list-item nodes by their `depth`, and model output by `o`/`◦` (depth 1), `▪`/`■` (depth 2) or 2 spaces / a tab of indentation per level (the list `Block` carries `depths` only when nested). Both go through `nestByDepth` (`format-output.ts`).
   - Clicking a paragraph reveals the original. Focus mode dims the others. Hovering shows the meaning badge (`meaningBadge`): "meaning ✓ 0.91", "meaning ✓ 0.91 · no NLI" (NLI fell back), "meaning ✓ 0.91 · Lite" (Lite quality mode), or, when the kept version did not pass, a neutral grey "Not verified" (dashed border, not a warning: the frozen checker fails about 70% of faithful paragraphs; since 2026-10-19). Its tooltip says the on-device check could not confirm every fact and that this does not mean the text is wrong, then lists every reason and value. Beside it, `meaningChips` shows chips only for concrete problems the checker already found: "missing number", "missing date", "missing time zone" or "missing name" (from the dropped-entity reasons) and "contradiction" (a contradicted-sentence reason with `maxContradiction` > `CONTRADICTION_MAX`); low similarity, length and unsupported sentences get no chip. All of it is React text. Results from before the thesis standard show "meaning 0.82" (amber below 0.87). The thesis metric (passed / failed on Progress and in the run log) is unchanged. Skipped nodes show an "already simple" tag. Non-fatal notices (`runState.notices`, deduplicated) render as info banners.
   - "Download run report (JSON)" saves `buildRunReport(doc)` (format `clarity-run-report/4`, the last 5 runs). Format 3 added the failure kinds and, for offline replay, each candidate's `text`, each node's `originalText` and the NLI rank/score ms. Format 4 adds per node `fkglBefore` / `fkglAfter` (Flesch-Kincaid grade of the model input and of the kept plain text; null after an error) and `modelInput`; per candidate `echoStripped`; per run `appVersion` (package.json) and `gitCommit` (short hash at build time, "-dirty" with uncommitted changes, null outside git; both from Vite `define` in `vite.config.ts`, read through `src/lib/utils/build-info.ts`, 'dev' / null under vitest), `ollamaVersion` (`OllamaProvider.version()`, `GET /api/version`, fetched alongside the session start, null when it fails) and the Lite counts `liteChecked` / `liteFailed` / `liteFailureBreakdown` in `summary.meaning` (`depthTier` was already recorded); per report `fieldNotes` (`RUN_REPORT_FIELD_NOTES`: what `gradeGap` = estimated grade of the version − target grade, negative = simpler than the target, and the FKGL and `modelInput` fields mean). `parseRunReport` reads formats 3 and 4 (`scripts/meaning-breakdown.mjs` uses it).
   - `Progress` (a `React.lazy` page with Chart.js) shows the weekly trend, a before/after comparison with "Avg similarity 0.87" and "Meaning pass rate X% (passed/checked)" (`passRateLabel`), and a "Meaning Preserved" table with one row per stored document: pass rate (the thesis metric), coverage (amber below 90%), average similarity and passed / failed / not-fully-checked counts. Lite results never enter the pass rate (it stays "—" for a Lite-only document), so the card and the pass-rate cell also show "Lite check: X of Y flagged" (`liteStats` / `liteLabel`: Lite-checked done results and how many the LITE score did not pass) when a document has any; the run log has the same as `summary.meaning.liteChecked` / `liteFailed` / `liteFailureBreakdown`, and the run logs `[Clarity] Lite check: X of Y flagged (…)`. The card and the table read the same rows (`useMeaningRows`, each built by `meaningOverview` in `similarity.ts`), so they can't disagree.

### App-level state rules
- The run lives in `useRunState` at App level, with an `AbortController`, so streaming survives route changes.
- **One run at a time** (`createRunSerializer` in `src/lib/run/run-serializer.ts`, pure): a new start aborts the current run **and awaits it** (its post-run saves included) before the new run re-reads the document from storage (`getDocument`, so 'remaining' sees what the cancelled run saved) and writes anything; of three quick starts the middle one never runs. Callbacks of a run that is no longer current are dropped (`isCurrent`), so a cancelled run can't mark the new one inactive. Before this, the UK report showed a cancelled run finishing after the next run had started. A cancelled run's log counts only the nodes whose save finished.
- App keeps `readingDoc` separate from `activeDoc`. A capture during a run shows a toast instead of switching views.
- Leftover `streaming` results from a crashed run are reset to `pending` when the next run starts.
- `classifyError` in `simplify.ts` maps a 403 to "set `OLLAMA_ORIGINS`", a 404 (from `/api/show` at the start, or `/api/chat` mid-run) to "the model isn't installed" naming the model and `DEFAULT_LLM_MODEL` with no command (the `ollama pull` command goes only to the console, via `missingModelLog`), and a fetch `TypeError` to "Ollama not running".
- The sidebar status chip polls `/api/tags` every 30 s (`AVAILABILITY_POLL_MS`) and on window focus.

### Bundle splitting
The main app chunk is about 286 kB (98 kB gzip). **Never statically import** `pdfjs-dist`, `chart.js`, `@huggingface/transformers`, `pages/Progress`, `lib/run/simplify`, `lib/segmentation/ner`, `lib/quality/semantic`, `lib/quality/meaning`, `lib/quality/nli` or `lib/quality/score` from App, Reading, Dashboard, Settings, the segmenter or any hook. Type-only imports are fine. UI code reads thresholds from `lib/quality/config.ts` and stats from `lib/quality/similarity.ts`, which import nothing heavy. Never import `src/lib/metrics/` from the background or content scripts, because the word list (`?raw` import) would end up in the worker.
- The run module loads `nli.ts` with a dynamic `import()`; Transformers.js and the ONNX Runtime JS live only in the worker chunk (`assets/nli.worker-*.js`, about 490 kB), built as an ES module worker (`worker.format: 'es'`).
- `vite.config.ts` adds the `onnxruntime-web-use-extern-wasm` resolve condition, so ORT loads its wasm and factory `.mjs` only from `wasmPaths` (`dist/ort/`) instead of Vite emitting a second 27 MB copy.

## 5. Key files

| File | What it owns |
|---|---|
| `src/manifest.ts` | Permissions (`activeTab`, `scripting`, `storage`, `unlimitedStorage`), `host_permissions: ['http://localhost:11434/*']`, CSP, the pinned `key` |
| `src/background/index.ts` | `chrome.action.onClicked`, injection, `EXTRACTION_RESULT`/`EXTRACTION_FAILED` handling, `openOrFocusApp()` |
| `src/app/App.tsx` | Routing, the Ollama status poll, `handleStartRun`, `readingDoc` vs `activeDoc`, writes session `appTabId` |
| `src/app/pages/Reading.tsx` | Renders nodes and results, `NodeBlock`, run buttons, run report download |
| `src/app/pages/Settings.tsx` | Presets, profile fields, AI model dropdown (from `/api/tags`; when the saved model isn't installed it names `DEFAULT_LLM_MODEL` and suggests `LIGHT_LLM_MODEL` `qwen2.5:1.5b`, with no command; the `ollama pull` command is logged to the console), Extra quality toggle, Quality mode select (one sentence per mode, plus "Auto currently uses …" from `nli:bench`), custom words, clear data, About (shows the extension ID) |
| `src/app/hooks/useRunState.ts` | Lazily loads the run module; holds `liveResults` (with each node's `meaning`), `notices`, cancel; one run at a time through `createRunSerializer` |
| `src/lib/run/run-serializer.ts` | `createRunSerializer`: abort + await the previous run before the next starts; `isCurrent` for callbacks |
| `src/lib/run/simplify.ts` | `runSimplification`, `selectNodesToRun`, `rotateFrom`, `classifyError`, `STORED_TYPE`, `EMBED_MISSING_NOTICE`, `NLI_MISSING_NOTICE` |
| `src/lib/llm/ollama-provider.ts` | `OllamaProvider` (`createBaseSession` with the `/api/show` lookup, `simplifyChunk`, `embed`, `/api/tags` checks), `DEFAULT_LLM_MODEL`, `EMBED_MODEL`, `OllamaHttpError`, `chatModelsFromTags`, `missingModelLog` |
| `src/lib/llm/ollama-think.ts` | `thinkSetting` (pure): `think: false` for models whose `/api/show` capabilities list `thinking`, omitted otherwise; used by the app and `scripts/bakeoff/run.mjs` |
| `src/lib/prompt-builder/builder.ts` | `buildPrompt`, `readerRules`, `hintedWords` (the lexical-hint list, shared with the NLI glossary exemption) |
| `src/lib/prompt-builder/variants.ts` | `PROMPT_VARIANTS`, `EXTRA_VARIANTS`, `EXAMPLES`, `pickExample`, `stripExampleLabel` |
| `src/lib/quality/config.ts` | Every quality constant: the frozen `COMBINED_SCORE_FULL` / `COMBINED_SCORE_LITE` (must match `eval/checker/PREREG.md`; a unit test checks), `SIMILARITY_THRESHOLD` 0.87 (old rule, baseline only), `ENTAILMENT_MIN` 0.5 (calibration result in its comment; not frozen yet), `CONTRADICTION_MAX` 0.2, `NLI_TOP_PREMISES` 3, `NLI_CONTRADICTION_AGG` `'best-entailing'`, `AUTO_LITE_PARAGRAPH_MS` 3000, `MIN_WORDS_FOR_CHECK`, `GLOSSARY_EXEMPTION_MAX_RATE`, `MAX_RETRY_REASONS`, the echo guard (`ECHO_MIN_PARTS` 4, `ECHO_MIN_SOURCE_SHARE` 0.6, `ECHO_MAX_OTHER_WORDS` 3), the retry policy (`RETRY_SKIP_*`), `THESIS_COVERAGE_MIN`, the NLI model id, batch, cache, timeouts and `NLI_BUDGET_MS`, and the stage 7 `WEIGHTS`, `QUALITY_THRESHOLD` (0.718, rescaled; `QUALITY_THRESHOLD_OLD_SCALE` 0.75 is its anchor), `MAX_MODEL_CALLS_PER_NODE`, grade and length constants. Import-free |
| `src/lib/quality/meaning.ts` | `assessMeaning` (thesis verdict by the combined score, plus the optional echo guard; `SCORE_MODELS`), reasons (`mainPointReason`, `lengthReason`, `echoLineReason`, `INSTRUCTION_ECHO_REASON` and the entity / NLI / drift ones), `buildRetryInstruction` + `retryInputOf` (prose retry prompt), `meaningScore`, `pickBetterVersion`, `candidatePasses`, `toStoredMeaning`, `MEANING_RETRY_INSTRUCTION`, `RETRY_OPENING` |
| `src/lib/quality/echo.ts` | Echo guard, pure: `findEcho`, `isEchoLine`, `echoesInstruction`, `stripEchoLines`, `RETRY_ECHO_PHRASES` |
| `src/lib/quality/checker.ts` | Combined score math shared by the app and `scripts/checker/`: `FEATURES`, `NLI_FEATURES`, `LITE_FEATURES`, `checkerFeatures`, `lengthRatioOf`, `standardise`, `combinedScore`, `harmfulFeatures`, `worstFeature` (pure) |
| `src/lib/quality/nli.ts` / `nli.worker.ts` / `glossary.ts` | `checkEntailment`, `checkMainClaim`, `splitSentences`, `NliClient` (`load`, `bench`, `scorePairs`, `currentBatchSize`), `batchSizeFor`, `createWorkerBackend`, `createNliClient`, `getNliClient`, `prepareNli`, `NLI_BENCH_PARAGRAPH`, `entailmentPairs`, `benchPairs`, `NliUnavailableError` / the Transformers.js worker (WebGPU → wasm) / `isGlossarySentence`, `selectExemptions`, `stripParentheticalDefinitions` |
| `src/lib/quality/nli-experiment.ts` | Debug-only fp16 vs q8 experiment, `clarityNliExperiment()` (lazy; loaded by `main.tsx` only with `debug:nliDevice = 'webgpu-fp16'`) |
| `src/lib/quality/values.ts` | `valueSignature`, `signatureKept`: numbers, quantities, months, weekdays and time zones as comparable value tokens (entity check and NER) |
| `src/lib/quality/verdict.ts` | `nliVerdict` (paragraph rule A/B), `failureBreakdown`, `failuresFromReasons`, `MEANING_FAILURES` (pure, shared with the scripts) |
| `src/lib/quality/premises.ts` / `mode.ts` | `buildPremises`, `rankPremises`, `lexicalRank`, `aggregate`, `PREMISE_STRATEGY` (pure, also used by `npm run calibrate-nli`) / `chooseQualityMode`, `predictParagraphMs`, `isBenchStale`, `evidenceOf`, `hasWebGpuAdapter` |
| `src/lib/storage/nli-bench.ts` | `getNliBench`/`saveNliBench` (local `nli:bench`), `getNliDevice` (local `debug:nliDevice`), `extensionVersion` |
| `src/lib/quality/score.ts` | `scoreCandidate`, `pickBestCandidate`, `readabilityScore`, `lengthScore` |
| `src/lib/quality/semantic.ts` / `similarity.ts` | `checkMeaning`, `findMissingEntities`, `coreTokens`, `shouldCheckNode` / `cosineSimilarity`, `averageSimilarity`, `meaningStatusOf`, `summarizeMeaning`, `meaningStats`, `meaningBadge`, `meaningChips`, `meaningOverview`, `passRateLabel` |
| `scripts/fetch-models.mjs` | Downloads the NLI model files from a pinned commit (SHA-256 checked) and copies the ORT asyncify wasm + `.mjs` from `node_modules/onnxruntime-web/dist` |
| `src/lib/metrics/engine.ts` | `computeReadabilityReport` (eight formulas plus derived stats) |
| `src/lib/profile/presets.ts` | `PRESETS` (Beginner, Student, Dyslexic-friendly, Non-native English, Elderly reader, Technical learner), `getPreset`, `editProfile` (sets `preset: 'custom'`) |
| `src/lib/storage/documents.ts` | Document CRUD behind the `enqueue` write queue |
| `src/lib/render/format-output.ts` | `parseSimplifiedText` (→ `Block[]`), `toPlainText`, `nestByDepth` |
| `src/lib/input/text-blocks.ts` | `parseListMarker`, `splitSentences`, `chunkSentences`, `textToBlocks`, `wrapWidth`, `isTitleLine`, `splitInlineList`, `blocksToHtml`, `pdfPagesToHtml`, `proseToHtml`, `MAX_NODE_SENTENCES`, `MAX_NODE_WORDS` |
| `src/types/index.ts` | Every shared type (`ClarityDocument`, `StoredResult`, `SimplificationSpec`, `RunLog`, `NavPage`, `CaptureStatus`, `RunMode`, …) |

## 6. Data

### Storage layout

| Area | Key | Shape / owner |
|---|---|---|
| `local` | `doc:<id>` | `ClarityDocument` (`results: StoredResult[]` with optional `StoredMeaning` fields and `skipped`; `runLogs` holds the last 5) — `documents.ts`, max 10 docs, evicts the oldest non-active one |
| `local` | `docs:index` | `DocumentIndexEntry[]` plus `contentHash` for dedup |
| `local` | `docs:active` | Active document ID |
| `local` | `cache:<hash>`, `cache:index` | `{ text, meaning: StoredMeaning \| null, format: 2 }`; LRU index, 2,000 entries (`CACHE_MAX_ENTRIES`) — `cache.ts`, cleared by "Clear document history". Other formats read as misses |
| `local` | `nli:bench` | `NliBenchRecord` (NLI backend, adapter vendor, benchmark ms, predicted ms per paragraph, version, `webgpuAdapter`, device) — `nli-bench.ts`; written by `prepareNli`, read by Auto quality mode and Settings. Per machine, so local |
| `local` | `debug:nliDevice` | Optional; `'wasm'` forces the wasm NLI backend (benchmarking only) |
| `local` | `progress:weekly` | `WeeklyProgressRecord[]` (`weekStart`, `targetGradeSum`, `sessionCount`), 30-day retention, Monday-aligned — `progress.ts`; survives "Clear documents" |
| `sync` | `userProfile` | `UserProfile` (includes `preset`); default adult / auto / general / novice / plain |
| `sync` | `llmModel` | Ollama chat model name; falls back to `DEFAULT_LLM_MODEL` (`qwen3:4b-instruct-2507-q4_K_M`). A saved value always wins, so a user who saved `qwen2.5:3b` keeps it (no migration) |
| `sync` | `extraQuality` | Boolean; on only when saved as `true` |
| `sync` | `qualityMode` | `'auto' \| 'full' \| 'lite'`; `'auto'` unless a valid value is saved |
| `sync` | `customWords` | Newline- or comma-separated string |
| `sync` | `displayPrefs` | `{ dyslexiaFont, textSize: 'normal'|'large'|'xlarge', focusMode }` — `useDisplayPrefs` |
| `session` | `capture:status`, `appTabId` | `CaptureStatus`; the app tab ID (the worker and App) |

### Core shapes (from `src/types/index.ts`)
- `ContentNode { id; type: 'heading'|'paragraph'|'list'|'list-item'|'table'|'blockquote'; level?; text; depth?; ordered?; entities? }`
- `Entity { text; type: 'person'|'org'|'date'|'timezone'|'number'|'place'|'other'; start; end }`
- `StoredResult { nodeId; originalText; simplifiedText; status: 'pending'|'streaming'|'done'|'error'; type; level?; skipped? }` plus `StoredMeaning { similarity?; entityRecall?; minEntailment?; maxContradiction?; nliChecked?; passed?; reasons?; lite?; failures?; score?; scoreModel? }` (`lite: true` = checked in Lite quality mode). `passed` is set exactly when the node was checked under the thesis standard; results from before it have only `similarity`.
- `MeaningAssessment` (meaning.ts output): `similarity|null`, `entityRecall`, `missingEntities`, `minEntailment|null`, `maxContradiction|null`, `nliChecked`, `fullyChecked`, `passed`, `reasons`, `failures`, `exemptedSentences`, `exemptionRate|null`, `nliMs|null`, `nliRankMs|null`, `nliScoreMs|null`, `nliSentences`.
- `ReadabilityReport`: Flesch ease, FK grade, Fog, SMOG, Coleman-Liau, ARI, Dale-Chall, average sentence and word length, complex-word %, long-sentence %, type-token ratio, jargon density and `estimatedGradeLevel`.
- `EntailmentCheck` (nli.ts output) carries `passed` (the paragraph rule), `sentenceScores`, `toleratedSentences`, `pairs`, `truncatedPairs`, `ranking` (`'embedding' | 'lexical' | 'all'`), `rankMs` and `scoreMs`.
- `RunLog`: run metadata (mode, model, effective extraQuality, `qualitySetting`, `qualityMode`, `qualityModeReason`, `nli` = backend / adapter vendor / bench ms / predicted ms per paragraph or null, target, tier, threshold, weights, `meaningThresholds` incl. `premiseStrategy`, `contradictionAggregation` and `paragraphRule`), a summary (counts by `NodeSource`, timings, `meaning: RunMeaningSummary` incl. `nliPairs`, `truncatedPairs` and `failureBreakdown`) and per-node `NodeRunLog` (`originalText`, `meaningStatus`, the kept version's `meaning` with `exemptedSentences`/`exemptionRate`/`nliMs`) with `CandidateLog[]` (`text`, scores incl. `minEntailment`, `maxContradiction`, `passed`; `reasons`, `failures`, `nliChecked`, exemptions, `nliMs`, `nliRankMs`, `nliScoreMs`).

### Write discipline
Every mutating function in `documents.ts` goes through `enqueue` (from `createWriteQueue` in `src/lib/utils/write-queue.ts`); `cache.ts` has its own queue. `runLogs` is written only by `addRunLog`, and `saveDocument` keeps the stored logs and ignores the caller's copy.

## 7. How to run

```powershell
npm install
npm run fetch-models   # once per clone: NLI model + ORT wasm into public/ (~114 MB, git-ignored)
npm run calibrate-nli  # ENTAILMENT_MIN calibration table (needs fetch-models; Ollama all-minilm for ranking)
npm run meaning-breakdown -- <report.json>  # failure kinds per run of a downloaded run report
npm run export-labels      # eval/nli-calibration/labels.csv for blind labelling (never overwrites labels without --force)
npm run import-labels      # labels.csv → paragraph-items.jsonl (-- --dry-run)
npm run calibrate-meaning  # paragraph-level threshold choice (dev) and test report; -- --reviewed-only, --verbose
npm run bakeoff:check      # Prompt 9.4: validate eval/model-bakeoff/paragraphs.jsonl
npm run bakeoff:run        # generate the bake-off outputs (resumable; -- --model <tag>, --gpu-only, --cpu-only, --limit N, --flags-only)
npm run bakeoff:export     # blind labels_bakeoff.csv + blind_key.json (never overwrites labels without --force)
npm run bakeoff:unblind    # after labelling: eval/model-bakeoff/REPORT.md
npm run checker:extract -- --set calib|bakeoff  # combined-score features (needs fetch-models + Ollama all-minilm)
npm run checker:fit        # fit FULL / LITE on the calibration features only → eval/checker/fit.json, PREREG.md
npm run checker:test       # the one held-out test → eval/checker/REPORT.md (refuses once REPORT.md exists)
npm run checker:rescale    # stage 7 QUALITY_THRESHOLD by quantile matching on calibration only (prints; copy into config.ts)
npm run checker:discuss    # post-hoc, exploratory: eval/checker/DISCUSSION.md (reads the test labels; writes nothing else)
npm run build          # production build -> dist/
npm run dev            # crxjs watch / hot reload
npm test               # vitest run (tests/unit/**/*.test.ts)
npm run typecheck      # tsc --noEmit, must report 0 errors (vite build does not typecheck)
npm run test:coverage
npx vitest run tests/unit/metrics.test.ts      # one file
npx vitest run -t "counts syllables"           # one test by name
npx vitest run --coverage --coverage.include="src/lib/**"
```

Runtime setup for manual testing:
1. `ollama pull qwen3:4b-instruct-2507-q4_K_M` and, optionally, `ollama pull all-minilm`. Without the second, the similarity check is skipped with a one-time notice. Without `npm run fetch-models` before the build, the NLI check is skipped with a one-time notice (results `nliChecked: false`, not thesis-grade).
2. Set the user env var `OLLAMA_ORIGINS=chrome-extension://emnnfgmpahidhdpdakmblphimmamckon` and fully restart Ollama. Without it, Ollama returns 403.
3. Open `chrome://extensions`, turn on Developer mode, use "Load unpacked" on `dist/` (Chrome 138+), click the toolbar icon on an article.

No other env vars exist.

Test notes: there is no DOM and no `chrome.*` in tests by default.
- Pure modules need no mocks.
- Code that touches storage uses `installChromeMock()` from `tests/mocks/chrome.ts` (an in-memory `local`/`sync`/`session` store via `vi.stubGlobal`).
- Only `segmenter.test.ts` uses `// @vitest-environment happy-dom` as its first line.
- `simplify.test.ts` mocks the segmenter with `vi.mock`, `embed` with `vi.spyOn(OllamaProvider.prototype, 'embed')`, and `lib/quality/nli` with `vi.mock` (`checkEntailment` answers per text; `prepareNli` returns `nliBenchResult`, by default a fast WebGPU benchmark so Auto picks Full; `nliMode` 'unavailable' makes both throw `NliUnavailableError`, 'error' makes `checkEntailment` throw a plain Error), routes `/api/show` to a separate `showMock` (`showCapabilities`, `showStatus`) so `fetchMock` counts only `/api/chat` calls, and saves a grade-1 target in `beforeEach`. Quality-mode tests set sync `qualityMode` or local `nli:bench`.
- `nli.test.ts` never loads the model: `NliClient` gets a fake `NliBackend`, `createWorkerBackend` a fake `WorkerLike`, and `prepareNli` an in-memory `BenchStore`.

## 8. Current status

- **Done:** phases 1 to 4 (capture and documents, Reading, Progress and Settings, paste and PDF), reading presets, purpose-aware prompt rules and the lexical hint, the stage 6C semantic check, the performance work (skip easy nodes, result cache, start at the visible node, model setting, lazy loading), stage 7 (candidate scoring, prompt variants, run report) and Prompt 9 (the thesis meaning standard: SBERT ≥ 0.87 + entities + local NLI, glossary exemptions, pass rate and coverage).
- **Health on 2026-10-19:** `npm test` passes (30 files, 636 tests), `npm run typecheck` passes with 0 errors, and `npm run build` passes.
- **NLI premise strategy and speed (decided 2026-10-15).** The Chrome run of the whole-paragraph-premise engine (wasm) measured **13,376 ms of NLI per paragraph** (about 1 s per sentence, budget 500 ms, about 73% of run time) and 0/3 passed at average similarity 0.87. Decision: SummaC sentence premises pruned to the top 3 by all-minilm, one batch per node, WebGPU first with wasm fallback, the stricter glossary rule, and the Auto/Full/Lite quality mode. Not done (by decision): a bigger in-app NLI model, and a contradiction-only check. Multi-threaded wasm (COOP/COEP) is investigated but not applied.
- **NLI calibration (2026-10-15, `eval/nli-calibration/`, `npm run calibrate-nli`).**
  - **The set:** 15 originals:
    - 12 Wikipedia lead paragraphs (CC BY-SA 4.0, pinned revisions).
    - 3 public-domain U.S. government instruction or list texts (Ready.gov, NWS).
  - **The items:** 60 sentences.
    - 30 faithful ones, verbatim from real `qwen2.5:3b` outputs made with the app's prompt.
    - 30 wrong ones: 7 changed numbers, 7 swapped names, 8 negations and 8 added facts. 2 of them are natural model errors.
  - **Labels are proposed by Claude and not yet reviewed** (`reviewed: false`).
  - **Results** (false-fail on faithful / catch on wrong):

    | Strategy | False-fail | Catch |
    |---|---|---|
    | Whole-paragraph premise | 63.3% | 100% |
    | Top-3 premises, `'max'` contradiction | 30.0% | 96.7% |
    | Top-3 premises, `'best-entailing'` (now the setting) | 13.3% | 96.7% |

    Every rate is flat across t = 0.30 to 0.70, because entailment scores are bimodal.
  - **No `ENTAILMENT_MIN` meets false-fail ≤ 10% and catch ≥ 90%,** so it stays 0.5 and is **not frozen**. Next: review the labels, re-run with `-- --reviewed-only`, and decide.
  - **Failures:**
    - Faithful items that fail: `antibiotic-f2`, `photo-f2`, `compound-f1`, `compound-f2` (borderline).
    - Wrong item missed: `amazon-w2`.
  - **Truncated pairs (> 512 tokens):** 0/60 before, 0/180 after.
  - **Speed proxy** (Node, 1 thread, per simplified paragraph), before → after: onnxruntime-web wasm 1,017 → 1,527 ms; onnxruntime-node CPU 363 → 526 ms. The new strategy scores 3× the pairs (291 vs 97), each shorter, so on wasm it is about 1.5× slower; WebGPU is the speed lever.
  - **About the earlier 13,376 ms Chrome figure:** it most likely included the model load. The old code loaded the model lazily inside the first paragraph's NLI call, and the average was over 3 paragraphs. The new code loads in `prepareNli` before any check.
- **Paragraph-level calibration (2026-10-15, `eval/nli-calibration/paragraph-items.jsonl`, `npm run calibrate-meaning`; provisional, NOT applied).**
  - **The set:** 40 items over 20 originals (15 + 5 new: Great Fire of London, Vaccine, Mount Vesuvius, Ready.gov floods, NWS Heat Index). Each original has 1 real `qwen2.5:3b` output plus 1 copy with one injected error (4 each: number, negation, name, dropped fact, added claim). The halves are dev and test, by paragraph.
  - **Labels:** proposed by Claude and not yet reviewed. 11 of the 20 real outputs are proposed faithful.
  - **Results:**
    - **Today's rule** (SIM 0.87, ENT 0.50, rule A, every entity): false-fail 66.7% dev / 80.0% test, catch 100% / 100%.
    - **Keeping "every entity kept":** no setting meets false-fail ≤ 10% and catch ≥ 90% on dev. The best is SIM 0.60, ENT 0.70, rule A, with 50% dev false-fail; all 3 of its failures are real omissions of names or figures.
    - **With a minimum entity recall** (`--entity-recall`, report only): SIM 0.66, ENT 0.80, rule B, recall ≥ 0.8 qualifies on dev (0/6, 92.9%). On test it gives 80% false-fail (4/5) and 93.3% catch. **It doesn't generalise.** The test failures are NLI false contradictions or unsupported verdicts on short referring sentences ("Anatocism is the same.", "That's called inflation.") and a dropped full date.
  - **Decision needed from the author:**
    - Review the labels.
    - Decide whether dropped names, figures or dates make a paragraph unfaithful (today's entity rule says yes).
    - Possibly add faithful real outputs (only 5–6 per half), then rerun with `-- --reviewed-only`.
  - `SIM_MIN` (today `SIMILARITY_THRESHOLD = 0.87`), `ENTAILMENT_MIN` and `NLI_PARAGRAPH_RULE` stay unchanged until then.
- **Failure breakdown, "example user test plan" (2026-10-15):**
  - **Before** (Chrome report, old split into 10 nodes, old checker): passed 1/10. Failures: similarity 4, entities 5, unsupported 5, contradiction 0, of 9 failed. Most of the entity failures were junk entities.
  - **After** (`scripts/replay-meaning.mjs`, new split into 38 nodes, new entity rules, same thresholds, fresh qwen2.5:3b outputs, CPU NLI): passed 15/26 (12 excluded as short or already simple). Failures: similarity 8, entities 1, unsupported 4, contradiction 1, of 11 failed.
  - Similarity at the uncalibrated 0.87 is now the main cause.
- **Calibration, round 2 (2026-10-15).** The author decided the standard:
  - A paragraph is unfaithful when it changes, contradicts or adds a fact, or drops a **key** fact (one needed to answer who / what / when / where / how many about its main point). Minor names may drop.
  - This is implemented as the entity rule (minimum share kept + main-claim numbers and dates) and as hypothesis context for short and referring sentences.
  - **The set:** 67 originals (47 added: 35 Wikipedia leads at pinned revisions and 12 Ready.gov / NWS texts). Each has 1 real qwen2.5:3b output; 20 have a copy with one injected error. Dev has 34 real items and test 33.
  - **Labels:** the real outputs are labelled blind through `eval/nli-calibration/labels.csv` (random order, no proposed labels), and the injected copies are auto-labelled unfaithful.
  - **Result (labels drafted by Claude, reviewed and corrected by the author: 48 faithful, 19 unfaithful):**
    - 6 near copies were left out: word edit ratio < 10% or similarity > 0.97.
    - **No setting reaches false-fail ≤ 10% with catch ≥ 90% on dev.**
    - The nearest dev setting is SIM 0.84, ENT 0.05, rule A, recall ≥ 0.5: dev 43.5% false-fail and 94.4% catch; test 68.4% and 90.5%. It was not chosen.
    - The current config scores 78.3% / 100% on dev and 78.9% / 95.2% on test.
    - `config.ts` is unchanged. Details are in `eval/nli-calibration/README.md`.
- **fp16 vs q8** (`npm run calibrate-nli -- --compare-fp16`, CPU): sentence decisions agree on 59/60 items (only `kit-f2` flips, contradiction 0.086 → 0.210) and paragraph decisions on 15/15. WebGPU ms per paragraph comes from `clarityNliExperiment()` in Chrome.
- **Entity rules found on the dev half** (names by capitalised words, surname or acronym; diacritics; weekday redundancy; unit conversions) are fixes to wrongly reported drops, not thresholds. The test half was not used to design them.
- **Calibration rules:**
  - `ENTAILMENT_MIN` is set only from `npm run calibrate-nli` and is then frozen for the benchmark.
  - The calibration paragraphs are never reused in the Ask Gemini benchmark test set or any other test set.
- **Combined meaning score (Prompt 9.5, 2026-10-19, `eval/checker/`).** The AND of hand-set thresholds was replaced by one logistic regression, fit only on the 81 calibration items (42 faithful / 39 unfaithful) and pre-registered before the held-out test.
  - **Method:** 8 candidate features from the app's own code; 5-fold CV stratified and grouped by paragraph (seed 42); L2 with λ by inner CV; balanced class weights; backward elimination to ≤ 6 features (fewer when within 1 point); threshold for catch ≥ 90% with the lowest false-fail. CV numbers are **nested** (every choice re-made inside each outer fold) with cluster-bootstrap 95% CIs.
  - **Calibration result (nested CV):** FULL (sbert, entity, nliMin, contra, lenRatio) balanced accuracy 55.7% [49.0–62.5], catch 92.3%, false-fail 81.0%, AUC 0.693; LITE (sbert, entity, lenRatio) 54.3% [46.3–62.1], catch 87.2%, false-fail 78.6%; the old rule 59.4% [52.9–65.9], catch 97.4%, false-fail 78.6%. On calibration the score is **not better** than the old rule; λ = 1 won the inner CV, so scores stay near 0.5. The outer folds chose different feature subsets (unstable selection at n = 81). `mainClaim` was not selected, so the score adds no NLI latency.
  - **Frozen** in `config.ts` (commit "docs(checker): pre-register combined score" holds PREREG.md alone). Targets for the held-out test: catch ≥ 90% AND false-fail ≤ 30%; headline balanced accuracy with a 95% CI. Tested once, no re-tuning.
  - **Held-out test (run once, 2026-10-19, `eval/checker/REPORT.md`; 119 bake-off items, 85 faithful / 34 unfaithful): targets NOT met.** FULL balanced accuracy 64.7% [58.5–71.0], catch 100% (34/34), false-fail 70.6% (60/85), AUC 0.789; LITE 63.2%, catch 97.1%, false-fail 70.6%; the old rule 65.6% [59.3–72.0], catch 97.1%, false-fail 65.9%. Old rule vs FULL: exact McNemar p = 0.549 (no significant difference). The score ranks better (AUC 0.79 vs 0.66 for the 0/1 rule) but, at the pre-registered catch ≥ 90% threshold, fails most faithful paragraphs. No extra latency: the frozen FULL model needs no main-claim NLI; the regression takes about 0.4 µs. No frozen value was changed after the test.
  - **Consequences in the app:** cache format 3 (old verdicts miss); with a high false-fail rate most versions fail, so most nodes get the one retry (or the Extra-quality variants) and fewer results are cached. Since Prompt 9.6 the Reading badge says a neutral "Not verified" (with chips for concrete reasons only) instead of a warning, and `QUALITY_THRESHOLD` was rescaled to 0.718 for the new meaning part (stage 7 above); the verdict itself is unchanged.
  - **Post-hoc discussion (EXPLORATORY, `eval/checker/DISCUSSION.md`, `npm run checker:discuss`; written after the test, changed nothing in `config.ts`).** ROC corners of the FULL score on the 119 test items; the best catch at false-fail ≤ 30% is 76.5% (threshold 0.522, false-fail 28.2%), chosen on the test set and therefore **not a valid result**, and still below the 90% target. Faithful outputs score about the same in both sets (mean 0.526 calibration, 0.535 test, both below the 0.569 threshold), and the high false-fail was already there in calibration (76.2% in-sample at the frozen threshold). Calibration was 48% unfaithful (20 of 39 errors injected, more visible to NLI: mean contra 0.43 vs 0.19 for real errors), test 29% (all real). The 60 false-fails are driven by nliMin 17, lenRatio 15, sbert 14, entity 7, contra 7 (lowest w·z). It ends with a thesis-ready paragraph: negative result, the checker kept as a cautious safety net, final meaning judged offline by a larger model.
- **Base-model bake-off (Prompt 9.4, 2026-10-16, `eval/model-bakeoff/`; eval only; its winner became the app default on 2026-10-19).**
  - **Goal:** choose the base model for the Prompt 10 fine-tune from `qwen2.5:3b`, `qwen3:4b-instruct-2507-q4_K_M` and `gemma4:e2b-it-qat`, with blind human meaning labels.
  - **Data:** 40 new **bakeoff-only** paragraphs (24 Wikipedia, 16 ready.gov / weather.gov / nih.gov; 10 lists, 20 with numbers). `npm run bakeoff:check` checks FKGL ≥ 9, not already simple at grade 8, 40–220 words, and no overlap with the calibration set.
  - **Generation:** the app's exact prompt (Student preset, grade 8), each model's default sampling, seed 42, `think: false` where supported, one first-try output; GPU on all 40, CPU-only (`num_gpu: 0`) on 10.
  - **Labels:** 120 blind rows labelled by the author; the analysis and winner rule (`unblind.mjs`) were committed before labelling.
  - **Result (2026-10-17, `eval/model-bakeoff/REPORT.md`):** the winner is **`qwen3:4b-instruct-2507-q4_K_M`**.

    | Model | Meaning kept [Wilson 95% CI] | Near copies | Mean FKGL drop | CPU s/100 words (median) | GPU s/100 words (median) | Licence |
    |---|---|---|---|---|---|---|
    | `qwen2.5:3b` | 50.0% (20/40) [35–65%] | 0 | 6.18 | 8.53 | 1.23 | Qwen Research (non-commercial) |
    | `qwen3:4b-instruct-2507-q4_K_M` | **85.0% (34/40)** [71–93%] | 0 | 6.35 | 14.19 | 2.10 | Apache 2.0 |
    | `gemma4:e2b-it-qat` | 79.5% (31/39) [64–89%] | 1 | 6.67 | 9.66 | 1.42 | Apache 2.0 |

    - All three are eligible. qwen3 leads gemma4 by 5.5 points, more than the 3-point tie margin, so the CPU tie-break doesn't apply. qwen3 is fine-tunable with Unsloth on a Colab T4 (the Qwen3 (4B) Instruct notebook).
    - **McNemar:** both newer models beat `qwen2.5:3b` (p = 0.001 and 0.003). qwen3 vs gemma4 is not significant (5 vs 3 discordant pairs, p = 0.73).
    - **Target hit:** every model overshoots below grade 8 (mean FKGL after 5.7–6.2), so hits within ±1 are low (15–28%).
    - **Default switched (2026-10-19):** `DEFAULT_LLM_MODEL` is now `qwen3:4b-instruct-2507-q4_K_M` (Apache 2.0; `qwen2.5:3b`'s Qwen Research licence is non-commercial and blocks a public release). Saved `llmModel` settings are kept. The app now sends `think: false` to it by the bake-off's rule (`thinkSetting`). The cache key includes the model, so earlier cache entries simply miss.
  - **Rule:** the bake-off paragraphs are never reused in the benchmark, the calibration or a training set.
- **Multi-threaded wasm (investigated, not applied).**
  - **What it would take:** the manifest keys `cross_origin_opener_policy: { value: 'same-origin' }` and `cross_origin_embedder_policy: { value: 'require-corp' }`, which make the app page `crossOriginIsolated`, plus `numThreads > 1` in the worker.
  - **What already fits:**
    - ORT's threaded asyncify build is the one already shipped, and it spawns its threads as same-origin module workers (`new Worker(new URL(import.meta.url))` on `ort/…asyncify.mjs`), so `script-src 'self'` allows them. No CSP change is needed.
    - The app renders no cross-origin images or iframes (Reading renders text nodes only).
    - pdf.js, the fonts and Chart.js are all same-origin.
    - CORS-mode `fetch` to Ollama is allowed under COEP.
  - **Unverified, needs a Chrome test:**
    - Whether host-permission fetches to `localhost:11434` still pass under `require-corp`.
    - Whether nested workers inherit COEP correctly.
  - **Status:** not applied; needs the author's approval and a throwaway-build test.
- **Test files** (`tests/unit/`): metrics, node-grade, difficult-words, format-output, ner, utils, resolver, presets, prompt-builder, ollama-stream, ollama-provider, documents, cache, segmenter, semantic, similarity, glossary, premises, nli, verdict, values, progress, quality-mode, meaning, score, run-log, timing, simplify, text-blocks, bakeoff (`scripts/bakeoff/lib.ts`), checker (`src/lib/quality/checker.ts`), checker-fit (`scripts/checker/lib.ts`, including the guard that the fit and the rescale cannot read the bake-off files, and the check that `QUALITY_THRESHOLD` keeps the calibration trigger share within 5 points of the old one). `simplify.test.ts` stubs `combinedScore` with a documented threshold stub (the run loop is tested, not the weights).
- **Known issues (not yet fixed):**
  - Progress records the *target grade setting* per session, not measured reading ability.
  - Leftovers from the old Chrome built-in AI provider: the unused `_onProgress` parameter of `createBaseSession`, the `'list'` and `'table'` entries in `STORED_TYPE`, and the `'downloadable'` and `'downloading'` values in `LLMAvailability`. A built-in AI (Gemini Nano) provider is **cancelled** and will not be added.
  - Cancel doesn't abort the HTTP request: `simplifyChunk` doesn't pass the run's `AbortSignal` to `fetch`, so Ollama finishes generating the current node.
- The README now states Chrome 138+, matching the manifest.
- **Planned work after stage 7, in this order:**
  1. **Prompt 9 follow-up:** measure NLI ms per paragraph in Chrome on WebGPU and on wasm. (`ENTAILMENT_MIN` no longer decides the verdict; the frozen combined score does. G8, an external SummaC / LLM-AggreFact check, is still open.)
  2. **Prompt 10: fine-tuned model.** A LoRA fine-tune named `clarity-simplify`, built in a `training/` folder on Colab from `Qwen3-4B-Instruct-2507`, the winner of the Prompt 9.4 bake-off (`eval/model-bakeoff/REPORT.md`), and exported as GGUF for Ollama.
  3. **Prompt 11:** integrate the fine-tuned model into the hybrid engine.
  4. **Prompt 12:**
     - Web URL input
     - keyword highlighting
     - adaptive "too hard / too easy" feedback
     - a measured-grade chart
     - accessibility
  5. **Prompt 13: on-page overlay.** Simplified text is shown on the web page itself.
  6. **Prompt 14:** final hardening, then v1.0.0.
  7. **After that: an `eval/` benchmark.** It compares Clarity against Ask Gemini, the Gemini API, Gemini Nano and the base model, using SARI, BERTScore, NLI, FKGL and speed.

## 9. Conventions

### Hard rules (from CLAUDE.md, mandatory)
1. Before coding: read the files you will change, state a short plan (files + approach), then implement.
2. Never change or remove `key` in `src/manifest.ts`. It pins the extension ID `emnnfgmpahidhdpdakmblphimmamckon`, which `OLLAMA_ORIGINS` allows. The ID also appears in the README and in Settings → About.
3. No `eval`, no remote code, no CSP relaxation beyond `'wasm-unsafe-eval'`. The CSP is `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' http://localhost:11434;`. `'wasm-unsafe-eval'` only lets the NLI worker compile the bundled ONNX Runtime WebAssembly; it is the only allowed relaxation (never `'unsafe-eval'`, never a remote host). Models are bundled, never downloaded at runtime (`env.allowRemoteModels = false`). Don't re-add pdf.js's removed `isEvalSupported` option. A new network target needs both a CSP change and `host_permissions`.
4. No `default_popup` (it would stop `chrome.action.onClicked` from firing) and no side panel. The app is a full tab.
5. No module-level state in `src/background/index.ts`. MV3 kills idle workers, so state goes in `chrome.storage.session` or `chrome.storage.local`.
6. Node IDs stay deterministic (`n0, n1, …`), because stored results are matched back to nodes by ID.
7. Every write in `src/lib/storage/documents.ts` goes through `enqueue()`.
8. The UI and the background talk only via `chrome.storage`.
9. Never render model output with `dangerouslySetInnerHTML`.
10. Done means: `npm test` passes, `npm run build` passes, `npm run typecheck` passes, new logic has unit tests, and you list manual test steps for Chrome.
11. Finish every task with a list of changed files, manual test steps, an update to any outdated part of this file, and a git commit with a clear message.

### Code style
- Files open with a JSDoc block explaining design decisions; sections are separated by `// ─── Name ───` dividers.
- Console messages are prefixed with `[Clarity]`. Expected cases (such as restricted pages) use `console.log`, because every `console.error` shows up under chrome://extensions → Errors.
- Components use named exports; only `App` is a default export.
- All styling lives in `src/app/app.css`, with plain class names (no CSS modules, no Tailwind).
- Shared types live in `src/types/index.ts`; ambient module declarations sit next to it as `src/types/*.d.ts`.
- Every quality number lives in `src/lib/quality/config.ts`; no magic numbers in the other quality modules.
- Shared helpers live in `src/lib/utils/`: `sha256` (`hash.ts`), `escapeHtml` (`html.ts`), `getHostname` (`url.ts`, returns `null` instead of throwing, so use it in render code instead of `new URL()`), `isRestrictedUrl` and `isRestrictedPageError` (`restricted-pages.ts`), `createWriteQueue` (`write-queue.ts`), and `appVersion` / `gitCommit` (`build-info.ts`, from the Vite `define` constants declared in `src/types/build-info.d.ts`).
- "Phase 1–4" in comments means the original build phases; "stage 6C" and "stage 7" are the quality work.

### Typing rules
- Pass a result type to every `chrome.storage.*.get<T>()` call.
- Use narrow literal unions or `React.JSX` (never the global `JSX`) for dynamic tags.
- Type compromise plugins via `nlp<DatesMethods & NumbersMethods>(text)`. The `compromise-numbers` types come from `src/types/compromise-numbers.d.ts`.
- No `any`, and no `@ts-ignore` without a comment explaining why.
