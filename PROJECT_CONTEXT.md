# PROJECT_CONTEXT.md

A self-contained guide to the Clarity codebase for an assistant that cannot see the code. All paths are relative to the repo root. Anything marked **UNSURE:** is inferred, not verified in the code.

Generated from commit `2edaf92` (2026-10-15). If the code and this file disagree, the code wins. Update this file when you change something it describes.

---

## 1. Project goal

**Clarity** is a Chrome MV3 extension that rewrites web pages, pasted text or PDFs at the user's reading level.

- It runs fully on the device. A **local Ollama** server at `http://localhost:11434` does the rewriting, using the chat model chosen in Settings (default `qwen2.5:3b`) and, optionally, the `all-minilm` embedding model for a meaning check. A bundled NLI cross-encoder (`Xenova/nli-deberta-v3-xsmall`, run with Transformers.js in a Web Worker) checks every simplified sentence.
- There is no backend, no database and no cloud API. The only network targets are Ollama and the captured page itself. The NLI model and the ONNX Runtime wasm ship inside `dist/` (`npm run fetch-models`), never downloaded at runtime.
- What the user gets: a readability dashboard (eight grade metrics), a streamed paragraph-by-paragraph rewrite with click-to-reveal of the original, reading presets, a dyslexia font, focus mode, a progress chart and a downloadable JSON run report.
- The research angle (stages 6C and 7): checking that the rewrite keeps the meaning (thesis standard: SBERT similarity ≥ 0.87, every entity kept, and no simplified sentence contradicted or unsupported per NLI), scoring candidate outputs, and A/B-testing prompt variants through the "Extra quality (slower)" toggle.
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
scripts/make-paragraph-items.mjs  fills missing qwen2.5:3b simplifications and hintedWords in paragraphs.jsonl (app prompt, Ollama)
scripts/replay-meaning.mjs   node scripts/replay-meaning.mjs <pdf|txt>: a run without Chrome (app split, prompt, qwen2.5:3b, meaning check + retry) and its failure breakdown
scripts/lib/nli-node.mjs     shared by the Node scripts: NLI model on onnxruntime-node, all-minilm via Ollama, Vite module loader, Wilson interval
eval/nli-calibration/        paragraphs.jsonl (15 originals), pairs.jsonl (60 labelled sentences), SOURCES.md, README.md
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
    llm/          ollama-provider.ts, ollama-stream.ts
    metrics/      engine.ts, syllables.ts, common-words.ts, word-set.ts, node-grade.ts,
                  difficult-words.ts, data/common-words.txt
    profile/      resolver.ts, presets.ts
    prompt-builder/  builder.ts, variants.ts
    quality/      config.ts (every quality constant), similarity.ts (UI-safe stats/badge),
                  semantic.ts (SBERT + entities), glossary.ts, premises.ts (SummaC premises),
                  nli.ts, nli.worker.ts, mode.ts (Auto/Full/Lite), meaning.ts (thesis verdict), score.ts
    render/       format-output.ts
    run/          simplify.ts, run-log.ts, timing.ts
    segmentation/ segmenter.ts, ner.ts, time-zones.ts
    storage/      documents.ts, cache.ts, progress.ts, settings.ts, nli-bench.ts
    utils/        hash.ts, html.ts, url.ts, restricted-pages.ts, write-queue.ts
  types/          index.ts (all shared types), compromise-numbers.d.ts, crxjs.d.ts
tests/
  mocks/          chrome.ts (installChromeMock), fixtures.ts (makeReport, makeDocInput,
                  makeAssessment, makeEntailment, makeRunMeaningSummary)
  unit/           26 *.test.ts files (see section 8)
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
     - **Titles:** a line of ≤ `MAX_TITLE_WORDS` (8) words without end punctuation, in Title Case or ending in ":" (`isTitleLine`), merges into the next paragraph when a capitalised line follows (blank lines allowed): "User Test Plan Example. Situating Context: You are…". Before a list marker it stays its own paragraph ("Objectives:"). Sentence-case lines ("Meeting plan") are not titles.
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
      - **Already simple:** `isAlreadySimple` (`src/lib/metrics/node-grade.ts`) finds the node's grade at or below the target. The original is stored as `done` with `skipped: true`, with no model call.
      - **Cache hit:** `src/lib/storage/cache.ts` keys on `sha256(node text + sorted spec JSON + model)`, plus a quality tag for Extra-quality runs. Only outputs that passed the stage 6C checks are cached, with their verdict. Entries carry `format: CACHE_FORMAT` (2); older entries (judged by the old 0.80 standard) are misses. A cached verdict that was not fully checked (NLI or embedding model missing then) is a miss while both checks are available.
      - **Model:** `detectEntities` (`src/lib/segmentation/ner.ts`, dynamically imported) runs for this node only, then steps 4 to 7 below.
      - The rolling context is the last sentence of the previous node in **document** order, if that node is done.
   4. **Prompt.** `buildPrompt` (`src/lib/prompt-builder/builder.ts`) returns a system prompt plus a user prompt. Reader flags become numbered system rules 7+ via `readerRules`. The user prompt carries a node-type hint, the entities to preserve, the rolling context and a lexical hint: `findDifficultWords` lists up to 8 (`MAX_DIFFICULT_WORDS`) uncommon, non-entity words longer than 3 letters. The hint is left out when `keepTerms` is on or the tier is `none`. The last parameter selects a prompt variant (`standard` adds nothing).
   5. **Call.** `OllamaProvider.simplifyChunk` POSTs `/api/chat` with `stream: true` and `keep_alive: '10m'`. `parseOllamaStream` (`src/lib/llm/ollama-stream.ts`) buffers lines split across chunks, skips malformed lines with a `[Clarity]` warning, throws on `{"error": ...}` lines and stops at `done: true`. Ollama is stateless, so the "session" is just a stored system prompt (`createBaseSession`).
   6. **Stage 6C: meaning preservation, thesis standard** (`assessMeaning` in `src/lib/quality/meaning.ts`; every constant in `config.ts`). It covers every node except headings and texts under 8 words (`shouldCheckNode`, `MIN_WORDS_FOR_CHECK`). A version **passes** only if all three hold:
      - **SBERT:** `checkMeaning` (`semantic.ts`) embeds original and output in one `/api/embed` call; cosine ≥ `SIMILARITY_THRESHOLD = 0.87`.
      - **Entities:** `findMissingEntities` finds none missing (case, possessive 's and thousands separators ignored). Names (person, org, place) compare on core tokens (`coreTokens`: a leading in / on / at / the is dropped; letters with diacritics count as letters); failing that, a name is kept when all its capitalised words are in the output (titles like Professor don't count), a person's surname is ("Marie Curie" by "Maria Skłodowska Curie"), or its acronym is, in capitals ("World Health Organization" by "WHO"); a dropped or replaced name ("Cordillera Rumi Cruz" → "a mountain range") still fails. Numbers, dates and time zones compare **by value** (`valueSignature` in `src/lib/quality/values.ts`, compromise-numbers only): every number, number+unit ("21 year", "30 minute", "45 percent"), month, weekday and time zone of the entity must be in the output, and modifiers (next, about, over, aged, age, during, …) don't count. So "for the next 21 years" is kept by "for 21 years", "aged 45" by "at age 45", "three" by "3", "in PST time zone" by "during PST"; "1893" missing or "21 years" → "21 months" fails. An entity without a comparable value can't be checked and counts as kept. In a date with a number the weekday is redundant ("Sunday 2 September 1666" is kept by "Sep 2, 1666"), and NER skips a unit conversion in brackets ("2,300 kilometres (1,400 mi)" keeps 2,300 only). `detectEntities` cleans its matches (each rule removes junk seen in the test plan run): leading brackets/quotes and trailing punctuation, brackets, quotes and dashes are trimmed; a match is cut at a sentence end or an opening bracket ("Team Cal. The other" → "Team Cal"); a date loses a leading in / on / at / the / during; numbers and dates without a value are dropped ("an", "week", "any hours"); inline list markers ("Objectives: 1. Formative") are not numbers; names need a capital letter, and a name directly followed by ":" is a label ("Common Meeting Times:"). A date that is only a time-zone abbreviation (`TIME_ZONES` in `src/lib/segmentation/time-zones.ts`) is typed `timezone`, and a dropped one reads "You dropped the time zone PST." "9am EST" stays a date. `entityRecall` is over distinct entity texts.
      - **NLI** (`checkEntailment` in `nli.ts`): the output is split into sentences (`splitSentences`: `toPlainText`, then the `(?<=[.!?])\s+` rule and line breaks, so each bullet is a sentence); these are the hypotheses. **Premises follow SummaC zero-shot** (Laban, Schnabel, Bennett & Hearst, 2022, "SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization", *TACL* 10, 163–177), in `premises.ts`: every original sentence plus every window of 2 adjacent original sentences (`buildPremises`). Each hypothesis is scored only against its `NLI_TOP_PREMISES = 3` most similar premises: ranked by all-minilm cosine (`rankPremises`, using the run's per-node embedding memo, so the original's premise vectors are computed once per node), or by content-word overlap (`lexicalRank`) when the embedding model is missing or fails; with 3 premises or fewer all are scored (`ranking: 'all'`). Entailment of a sentence = max over its premises; contradiction = the contradiction of the best-entailing premise (`NLI_CONTRADICTION_AGG = 'best-entailing'`). The alternative `'max'` (highest contradiction over the scored premises) was tried first and dropped after calibration, because a faithful sentence was often "contradicted" by a premise about something else, such as another date. All of a node's pairs go to the worker in one call. Each sentence's scores (`sentenceScores`: entailment, contradiction, exempt) are returned, and the paragraph verdict is the pure `nliVerdict` in `verdict.ts` (shared with the calibration scripts): a sentence is unsupported when its entailment < `ENTAILMENT_MIN` (non-exempt only) and contradicted when its contradiction > `CONTRADICTION_MAX = 0.2`. Paragraph rule `NLI_PARAGRAPH_RULE`: `'A'` = no unsupported sentence; `'B'` = one neutral (unsupported, not contradicted) sentence is tolerated when the output has `NLI_NEUTRAL_MIN_SENTENCES = 6` or more (`toleratedSentences`). A contradiction always fails, and an output with no sentences fails.
      - **Glossary exemptions** (`glossary.ts`, pure, reusable by the offline benchmark): a sentence that defines one of this node's hinted words (`hintedWords` in `builder.ts`, the exact lexical-hint list; empty with `keepTerms` or tier `none`) skips the entailment requirement, never the contradiction one. A definition is "X means …", "X refers to …", or "X is" followed by a / an / the / a kind of / when / how; "Inflation is rising." is **not** a definition. One exemption per word; the cap is `max(1, floor(0.3 × sentences))` (`GLOSSARY_EXEMPTION_MAX_RATE`) for nodes of 2+ sentences, and a 1-sentence node gets none. Parenthetical definitions of hinted words (`word (definition)`) are removed before NLI. Each exemption is logged.
      - **Runtime:** `nli.worker.ts` runs `AutoTokenizer` + `AutoModelForSequenceClassification` with the **same q8 weights on every backend** (`dtype: 'q8'`), `env.allowRemoteModels = false`, model files from `chrome.runtime.getURL('models/')` and the wasm from `ort/` (`wasmPaths` set explicitly, `useWasmCache` off — the default loads the factory from a `blob:` URL, which the CSP blocks). **WebGPU first:** the worker requests the system's adapter once per worker (no `powerPreference`: Chrome ignores it on Windows, crbug 369219127, and its warning lands on the Errors page; which GPU Chrome uses is set in Windows Settings → System → Display → Graphics), hands it to ONNX Runtime as `env.backends.onnx.webgpu.adapter`, loads with `device: 'webgpu'` and runs one warm-up pair; any failure falls back to `device: 'wasm'` (one thread). ORT's WebGPU build loads the same `ort-wasm-simd-threaded.asyncify` files, and WGSL shaders are not script, so **no CSP change** is needed. The page logs `[Clarity] NLI model … loaded on webgpu (nvidia …) in N ms` (or `wasm`, with the WebGPU error). Each pair is also tokenized untruncated; pairs over 512 tokens are flagged `truncated` and counted per node and per run. Labels come from the model's `id2label`. `NliClient` sends a node's uncached pairs in batches of `NLI_BATCH_SIZE_WEBGPU = 32` or `NLI_BATCH_SIZE_WASM = 8` (by the backend it loaded on; `batchSizeFor`) and keeps an in-memory LRU (`NLI_CACHE_MAX = 500`) keyed by `sha256(premise, hypothesis)`. The worker is created lazily, once per app tab.
      - **Benchmark switch:** `chrome.storage.local.set({ 'debug:nliDevice': 'wasm' })` in DevTools (app tab) forces wasm for the next load (reload the app tab); remove the key to go back to WebGPU first. Used to measure both backends on one machine. The page checks for a WebGPU adapter once per tab session (`hasWebGpuAdapter` memoizes its answer).
      - **fp16 experiment (debug only; the default stays q8):** `npm run fetch-models -- --fp16` adds `onnx/model_fp16.onnx` (143 MB, pinned by SHA-256). `debug:nliDevice = 'webgpu-fp16'` makes runs load the fp16 weights on WebGPU (wasm fallback stays q8); the bench record and the run log's `nli` record the `dtype`, and the summary line says `backend webgpu fp16 …`. With that flag `main.tsx` also loads `nli-experiment.ts` (a lazy chunk with the calibration set imported `?raw`) and installs `clarityNliExperiment()` in the app tab's console: it checks the 15 calibration simplifications with a q8 and an fp16 client (same premises, warmed up, one after the other) and downloads `clarity-nli-experiment-<date>.json` (ms per paragraph per dtype, paragraph and sentence decision agreement, false-fail/catch, largest probability differences). `npm run calibrate-nli -- --compare-fp16` measures decision agreement on the CPU (no WebGPU timing).
      - **Reasons and retry:** reasons are ordered dropped entities ("You dropped the number 1945."), contradicted sentences, unsupported sentences ("This sentence is not supported by the original: "…""), then drift ("…similarity 0.82, needs 0.87"). A failure triggers one retry; `buildRetryInstruction` prepends `MEANING_RETRY_INSTRUCTION` plus the first `MAX_RETRY_REASONS = 3` reasons. `pickBetterVersion` keeps a passing version, then the higher `meaningScore`; the first version wins ties.
      - **Fallbacks never fail the run.** An embed 404 shows `EMBED_MISSING_NOTICE` once and drops SBERT for the run. An NLI model that can't load (`NliUnavailableError`: missing files, wasm blocked, worker crash, 60 s load timeout) shows `NLI_MISSING_NOTICE` once and drops NLI for the run (`nliChecked: false`). A single failed NLI request skips NLI for that node only. `passed` means every check that ran passed; `fullyChecked` means all three ran.
      - **NLI timing:** each assessed version logs `[Clarity] NLI nX: S sentences, P pairs (ranking premises, C cached, T truncated, E exempt) N ms (rank R, score S)`; the run summary has the average NLI ms per paragraph, the backend and the truncated pairs. Above `NLI_BUDGET_MS = 1000` the run logs `[Clarity] NLI above budget: …` once with `console.info`, never `console.warn`, because warnings land on the chrome://extensions Errors page, which stays for real errors.
      - **Quality mode** (`mode.ts`, sync `qualityMode`: `'auto'` default, `'full'`, `'lite'`). **Full** = everything above. **Lite** = SBERT + entities only: NLI never loads, results are stored with `nliChecked: false` and `lite: true` (so the coverage rule keeps them out of the thesis pass rate), at most the one 6C retry, and "Extra quality" best-of-N is off (the run log records the effective `extraQuality: false`). **Auto** measures instead of guessing: when the NLI model first loads, `prepareNli` (`nli.ts`) times `NLI_BENCH_PAIRS` (8 fixed pairs) after a warm-up batch and stores `nli:bench` (`NliBenchRecord`: backend, adapter vendor, ms, `predictedParagraphMs` = ms / 8 × 3 premises × `NLI_TYPICAL_SENTENCES` (6), version, `webgpuAdapter`, device). `chooseQualityMode` picks Lite only when there is no WebGPU **and** the prediction is above `AUTO_LITE_PARAGRAPH_MS = 3000`; otherwise Full, and Full when nothing could be measured. A stored benchmark decides without loading the model; it is stale (`isBenchStale`) after an extension update, when the page's WebGPU adapter appears or disappears, or when the requested device changes, and `prepareNli` also re-measures when the worker's actual backend differs. The run logs `[Clarity] Quality mode lite (auto: no WebGPU, benchmark … ms/8 pairs → … ms per paragraph > 3000)`.
   7. **Stage 7: candidate scoring** (`src/lib/quality/score.ts`). `total = 0.5·meaning + 0.3·readability + 0.2·length` (`WEIGHTS`), where meaning is `meaningScore(assessment)` = similarity × entity recall × minimum entailment (each part only when measured; 1 for unchecked nodes).
      - Extra quality **off** (the default): the 6C retry, at most 2 calls.
      - Extra quality **on**: if the streamed `standard` output fails 6C or scores below `QUALITY_THRESHOLD = 0.75`, the `stepwise` and `example-guided` variants (`src/lib/prompt-builder/variants.ts`) are generated without streaming, in place of the 6C retry. `pickBestCandidate` prefers passing versions, then the highest total; ties go to `standard`.
      - Hard cap: `MAX_MODEL_CALLS_PER_NODE = 3`. Headings and texts under 8 words always get one call.
   8. **Persist.** Each finished node (`done` or `error`) is saved immediately with `saveDocument`. The kept version's verdict goes on the result (`StoredMeaning`: `similarity`, `entityRecall`, `minEntailment`, `maxContradiction`, `nliChecked`, `passed`, `reasons`). Each node logs `[Clarity] Node nX (source, meaning status) N.NN s`, and the run logs a summary line (`summarizeRun` in `src/lib/run/timing.ts`) with the meaning pass rate, coverage and NLI average. Below 90% coverage (`THESIS_COVERAGE_MIN`) it warns that the pass rate is not thesis-grade.
      - **Thesis metric** (`summarizeMeaning` / `meaningStats` in `similarity.ts`): each node is `passed`/`failed` (fully checked), `not-fully-checked` (a check fell back), `excluded` (headings, short texts, already simple) or `error`. Pass rate = passed / fully checked; coverage = fully checked / (fully checked + not fully checked). The run log's `summary.meaning` has these counts, `avgNliMs`, and the glossary `exemptedSentences` count and `exemptionRate`.
      - **Failure breakdown:** every assessment names its failed checks (`failures`: `'similarity' | 'entities' | 'unsupported' | 'contradiction'`, from `failureKinds` in `meaning.ts`; empty exactly when it passed), stored on the result, the kept version and each candidate. `summary.meaning.failureBreakdown` counts the failed kept versions per kind (one can count under several) plus `failedParagraphs`, and the run logs `[Clarity] Meaning failures: similarity 4, entities 5, unsupported 5, contradiction 0 (of 9 failed)`. `npm run meaning-breakdown -- <report.json>` prints it per run, classifying format-2 reports from their reason strings (`failuresFromReasons`).
   9. **Finish.** When the run finished any node (also when cancelled) it computes and saves `simplifiedReport`; when the run is complete (not cancelled, or cancelled only after its last node finished) it calls `recordSession(targetGrade)` and logs `[Clarity] Session recorded (N this week)`; then `addRunLog`. Each post-run write is guarded (`console.error` on failure), so one failure can't skip the session, the run log or `onComplete`; `useRunState` also catches a rejected run so it never stays "active". Week keys are local Mondays (`getWeekStart` in `progress.ts`); old UTC-shifted Sunday keys are read as the Monday after (`normalizeWeekStart`) and merged. The Progress card shows Before vs. After when `beforeAfterOf(activeDoc)` has both reports. The report and rolling context use `toPlainText`; the stored text keeps the raw output with its bullet markers.
5. **Display.** `Reading` re-segments the HTML and merges `runState.liveResults` with `doc.results`. `NodeBlock` renders `parseSimplifiedText` blocks as real `<p>`, `<ul>`/`<ol>` and `<li>` elements (never `dangerouslySetInnerHTML`). Sub-bullets nest: list-item nodes by their `depth`, and model output by `o`/`◦` (depth 1), `▪`/`■` (depth 2) or 2 spaces / a tab of indentation per level (the list `Block` carries `depths` only when nested). Both go through `nestByDepth` (`format-output.ts`).
   - Clicking a paragraph reveals the original. Focus mode dims the others. Hovering shows the meaning badge (`meaningBadge`): "meaning ✓ 0.91", "meaning ✓ 0.91 · no NLI" (NLI fell back), "meaning ✓ 0.91 · Lite" (Lite quality mode), or amber "meaning ⚠ <first reason>" with every reason and value in the tooltip; results from before the thesis standard show "meaning 0.82". Skipped nodes show an "already simple" tag. Non-fatal notices (`runState.notices`, deduplicated) render as info banners.
   - "Download run report (JSON)" saves `buildRunReport(doc)` (format `clarity-run-report/3`, the last 5 runs; format 3 added the failure kinds and, for offline replay, each candidate's `text`, each node's `originalText` and the NLI rank/score ms).
   - `Progress` (a `React.lazy` page with Chart.js) shows the weekly trend, a before/after comparison with "Avg similarity 0.87" and "Meaning pass rate X% (passed/checked)" (`passRateLabel`), and a "Meaning Preserved" table with one row per stored document: pass rate (the thesis metric), coverage (amber below 90%), average similarity and passed / failed / not-fully-checked counts. The card and the table read the same rows (`useMeaningRows`, each built by `meaningOverview` in `similarity.ts`), so they can't disagree.

### App-level state rules
- The run lives in `useRunState` at App level, with an `AbortController`, so streaming survives route changes.
- App keeps `readingDoc` separate from `activeDoc`. A capture during a run shows a toast instead of switching views.
- Leftover `streaming` results from a crashed run are reset to `pending` when the next run starts.
- `classifyError` in `simplify.ts` maps a 403 to "set `OLLAMA_ORIGINS`", a 404 to "pull the model", and a fetch `TypeError` to "Ollama not running".
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
| `src/app/pages/Settings.tsx` | Presets, profile fields, AI model dropdown (from `/api/tags`; suggests `LIGHT_LLM_MODEL` `qwen2.5:1.5b` when the saved model isn't installed), Extra quality toggle, Quality mode select (one sentence per mode, plus "Auto currently uses …" from `nli:bench`), custom words, clear data, About (shows the extension ID) |
| `src/app/hooks/useRunState.ts` | Lazily loads the run module; holds `liveResults` (with each node's `meaning`), `notices`, cancel |
| `src/lib/run/simplify.ts` | `runSimplification`, `selectNodesToRun`, `rotateFrom`, `classifyError`, `STORED_TYPE`, `EMBED_MISSING_NOTICE`, `NLI_MISSING_NOTICE` |
| `src/lib/llm/ollama-provider.ts` | `OllamaProvider` (`simplifyChunk`, `embed`, `/api/tags` checks), `DEFAULT_LLM_MODEL`, `EMBED_MODEL`, `OllamaHttpError`, `chatModelsFromTags` |
| `src/lib/prompt-builder/builder.ts` | `buildPrompt`, `readerRules`, `hintedWords` (the lexical-hint list, shared with the NLI glossary exemption) |
| `src/lib/prompt-builder/variants.ts` | `PROMPT_VARIANTS`, `EXTRA_VARIANTS`, `EXAMPLES`, `pickExample`, `stripExampleLabel` |
| `src/lib/quality/config.ts` | Every quality constant: `SIMILARITY_THRESHOLD` 0.87, `ENTAILMENT_MIN` 0.5 (calibration result in its comment; not frozen yet), `CONTRADICTION_MAX` 0.2, `NLI_TOP_PREMISES` 3, `NLI_CONTRADICTION_AGG` `'best-entailing'`, `AUTO_LITE_PARAGRAPH_MS` 3000, `MIN_WORDS_FOR_CHECK`, `GLOSSARY_EXEMPTION_MAX_RATE`, `MAX_RETRY_REASONS`, `THESIS_COVERAGE_MIN`, the NLI model id, batch, cache, timeouts and `NLI_BUDGET_MS`, and the stage 7 `WEIGHTS`, `QUALITY_THRESHOLD`, `MAX_MODEL_CALLS_PER_NODE`, grade and length constants. Import-free |
| `src/lib/quality/meaning.ts` | `assessMeaning` (thesis verdict), reasons, `buildRetryInstruction`, `meaningScore`, `pickBetterVersion`, `candidatePasses`, `toStoredMeaning`, `MEANING_RETRY_INSTRUCTION` |
| `src/lib/quality/nli.ts` / `nli.worker.ts` / `glossary.ts` | `checkEntailment`, `splitSentences`, `NliClient` (`load`, `bench`, `scorePairs`, `currentBatchSize`), `batchSizeFor`, `createWorkerBackend`, `createNliClient`, `getNliClient`, `prepareNli`, `NLI_BENCH_PAIRS`, `NliUnavailableError` / the Transformers.js worker (WebGPU → wasm) / `isGlossarySentence`, `selectExemptions`, `stripParentheticalDefinitions` |
| `src/lib/quality/nli-experiment.ts` | Debug-only fp16 vs q8 experiment, `clarityNliExperiment()` (lazy; loaded by `main.tsx` only with `debug:nliDevice = 'webgpu-fp16'`) |
| `src/lib/quality/values.ts` | `valueSignature`, `signatureKept`: numbers, quantities, months, weekdays and time zones as comparable value tokens (entity check and NER) |
| `src/lib/quality/verdict.ts` | `nliVerdict` (paragraph rule A/B), `failureBreakdown`, `failuresFromReasons`, `MEANING_FAILURES` (pure, shared with the scripts) |
| `src/lib/quality/premises.ts` / `mode.ts` | `buildPremises`, `rankPremises`, `lexicalRank`, `aggregate`, `PREMISE_STRATEGY` (pure, also used by `npm run calibrate-nli`) / `chooseQualityMode`, `predictParagraphMs`, `isBenchStale`, `evidenceOf`, `hasWebGpuAdapter` |
| `src/lib/storage/nli-bench.ts` | `getNliBench`/`saveNliBench` (local `nli:bench`), `getNliDevice` (local `debug:nliDevice`), `extensionVersion` |
| `src/lib/quality/score.ts` | `scoreCandidate`, `pickBestCandidate`, `readabilityScore`, `lengthScore` |
| `src/lib/quality/semantic.ts` / `similarity.ts` | `checkMeaning`, `findMissingEntities`, `coreTokens`, `shouldCheckNode` / `cosineSimilarity`, `averageSimilarity`, `meaningStatusOf`, `summarizeMeaning`, `meaningStats`, `meaningBadge`, `meaningOverview`, `passRateLabel` |
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
| `sync` | `llmModel` | Ollama chat model name; falls back to `qwen2.5:3b` |
| `sync` | `extraQuality` | Boolean; on only when saved as `true` |
| `sync` | `qualityMode` | `'auto' \| 'full' \| 'lite'`; `'auto'` unless a valid value is saved |
| `sync` | `customWords` | Newline- or comma-separated string |
| `sync` | `displayPrefs` | `{ dyslexiaFont, textSize: 'normal'|'large'|'xlarge', focusMode }` — `useDisplayPrefs` |
| `session` | `capture:status`, `appTabId` | `CaptureStatus`; the app tab ID (the worker and App) |

### Core shapes (from `src/types/index.ts`)
- `ContentNode { id; type: 'heading'|'paragraph'|'list'|'list-item'|'table'|'blockquote'; level?; text; depth?; ordered?; entities? }`
- `Entity { text; type: 'person'|'org'|'date'|'timezone'|'number'|'place'|'other'; start; end }`
- `StoredResult { nodeId; originalText; simplifiedText; status: 'pending'|'streaming'|'done'|'error'; type; level?; skipped? }` plus `StoredMeaning { similarity?; entityRecall?; minEntailment?; maxContradiction?; nliChecked?; passed?; reasons?; lite?; failures? }` (`lite: true` = checked in Lite quality mode). `passed` is set exactly when the node was checked under the thesis standard; results from before it have only `similarity`.
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
npm run calibrate-meaning  # paragraph-level threshold choice (dev) and test report; -- --reviewed-only, --entity-recall, --verbose
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
1. `ollama pull qwen2.5:3b` and, optionally, `ollama pull all-minilm`. Without the second, the similarity check is skipped with a one-time notice. Without `npm run fetch-models` before the build, the NLI check is skipped with a one-time notice (results `nliChecked: false`, not thesis-grade).
2. Set the user env var `OLLAMA_ORIGINS=chrome-extension://emnnfgmpahidhdpdakmblphimmamckon` and fully restart Ollama. Without it, Ollama returns 403.
3. Open `chrome://extensions`, turn on Developer mode, use "Load unpacked" on `dist/` (Chrome 138+), click the toolbar icon on an article.

No other env vars exist.

Test notes: there is no DOM and no `chrome.*` in tests by default.
- Pure modules need no mocks.
- Code that touches storage uses `installChromeMock()` from `tests/mocks/chrome.ts` (an in-memory `local`/`sync`/`session` store via `vi.stubGlobal`).
- Only `segmenter.test.ts` uses `// @vitest-environment happy-dom` as its first line.
- `simplify.test.ts` mocks the segmenter with `vi.mock`, `embed` with `vi.spyOn(OllamaProvider.prototype, 'embed')`, and `lib/quality/nli` with `vi.mock` (`checkEntailment` answers per text; `prepareNli` returns `nliBenchResult`, by default a fast WebGPU benchmark so Auto picks Full; `nliMode` 'unavailable' makes both throw `NliUnavailableError`, 'error' makes `checkEntailment` throw a plain Error), and saves a grade-1 target in `beforeEach`. Quality-mode tests set sync `qualityMode` or local `nli:bench`.
- `nli.test.ts` never loads the model: `NliClient` gets a fake `NliBackend`, `createWorkerBackend` a fake `WorkerLike`, and `prepareNli` an in-memory `BenchStore`.

## 8. Current status

- **Done:** phases 1 to 4 (capture and documents, Reading, Progress and Settings, paste and PDF), reading presets, purpose-aware prompt rules and the lexical hint, the stage 6C semantic check, the performance work (skip easy nodes, result cache, start at the visible node, model setting, lazy loading), stage 7 (candidate scoring, prompt variants, run report) and Prompt 9 (the thesis meaning standard: SBERT ≥ 0.87 + entities + local NLI, glossary exemptions, pass rate and coverage).
- **Health on 2026-10-15:** `npm test` passes (29 files, 575 tests), `npm run typecheck` passes with 0 errors, and `npm run build` passes.
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
- **fp16 vs q8** (`npm run calibrate-nli -- --compare-fp16`, CPU): sentence decisions agree on 59/60 items (only `kit-f2` flips, contradiction 0.086 → 0.210) and paragraph decisions on 15/15. WebGPU ms per paragraph comes from `clarityNliExperiment()` in Chrome.
- **Entity rules found on the dev half** (names by capitalised words, surname or acronym; diacritics; weekday redundancy; unit conversions) are fixes to wrongly reported drops, not thresholds. The test half was not used to design them.
- **Calibration rules:**
  - `ENTAILMENT_MIN` is set only from `npm run calibrate-nli` and is then frozen for the benchmark.
  - The calibration paragraphs are never reused in the Ask Gemini benchmark test set or any other test set.
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
- **Test files** (`tests/unit/`): metrics, node-grade, difficult-words, format-output, ner, utils, resolver, presets, prompt-builder, ollama-stream, ollama-provider, documents, cache, segmenter, semantic, similarity, glossary, premises, nli, verdict, values, progress, quality-mode, meaning, score, run-log, timing, simplify, text-blocks.
- **Known issues (not yet fixed):**
  - Progress records the *target grade setting* per session, not measured reading ability.
  - Leftovers from the old Chrome built-in AI provider: the unused `_onProgress` parameter of `createBaseSession`, the `'list'` and `'table'` entries in `STORED_TYPE`, and the `'downloadable'` and `'downloading'` values in `LLMAvailability`. A built-in AI (Gemini Nano) provider is **cancelled** and will not be added.
  - Cancel doesn't abort the HTTP request: `simplifyChunk` doesn't pass the run's `AbortSignal` to `fetch`, so Ollama finishes generating the current node.
- The README now states Chrome 138+, matching the manifest.
- **Planned work after stage 7, in this order:**
  1. **Prompt 9 follow-up:** measure NLI ms per paragraph in Chrome on WebGPU and on wasm, and freeze `ENTAILMENT_MIN` from the calibration set before the benchmark.
  2. **Prompt 10: fine-tuned model.** A LoRA fine-tune named `clarity-simplify`, built in a `training/` folder on Colab from Qwen2.5-3B-Instruct and exported as GGUF for Ollama.
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
- Shared helpers live in `src/lib/utils/`: `sha256` (`hash.ts`), `escapeHtml` (`html.ts`), `getHostname` (`url.ts`, returns `null` instead of throwing, so use it in render code instead of `new URL()`), `isRestrictedUrl` and `isRestrictedPageError` (`restricted-pages.ts`), and `createWriteQueue` (`write-queue.ts`).
- "Phase 1–4" in comments means the original build phases; "stage 6C" and "stage 7" are the quality work.

### Typing rules
- Pass a result type to every `chrome.storage.*.get<T>()` call.
- Use narrow literal unions or `React.JSX` (never the global `JSX`) for dynamic tags.
- Type compromise plugins via `nlp<DatesMethods & NumbersMethods>(text)`. The `compromise-numbers` types come from `src/types/compromise-numbers.d.ts`.
- No `any`, and no `@ts-ignore` without a comment explaining why.
