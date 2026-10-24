# Pre-registration: grade targeting at inference time (Prompt 11)

**This evaluation is pre-registered before any implementation.** Nothing in `src/` that targets grades exists yet, and no model output has been generated on the items below. The reference point is **the commit that adds this file** (`docs(eval): pre-register grade-targeting evaluation`; find it with `git log --diff-filter=A -- eval/grade-targeting/PREREG.md`). Nothing below changes after that commit. If something has to change, the change goes in the Deviations section in a new commit that says why, before the run it affects, and REPORT.md reports both versions.

## Background

The Prompt 10 LoRA fine-tune (`clarity-simplify`) failed its pre-registration (`training/eval/REPORT.md`, commit `0d640eb`):
- grade hit went from 25.4% to 25.5%;
- entities kept fell by 9.8 points;
- the near-copy rate was 19%.

It is not adopted, and the app keeps `qwen3:4b-instruct-2507-q4_K_M` as the default `llmModel`.

The defect behind it is grade targeting: the model largely ignores the requested reading grade.
- It gave the same output at grade 6 and grade 8 for 224 of 400 items.
- The bake-off grade hit for qwen3 was 17.5%.

Prompt 11 tries to fix this at inference time, not by training.

## Hypothesis

A grade-feedback retry loop raises the target-grade hit rate, without hurting meaning preservation and without over-simplifying.

## Arms

All three arms run on the **same 200 items**, with the same model, `qwen3:4b-instruct-2507-q4_K_M` (Ollama, exact tag, digest recorded). Every call uses **temperature 0 and seed 42**, and `think` follows the app's `thinkSetting` rule.

The profile is the app's `DEFAULT_PROFILE` (adult, general, novice, plain style) with `targetGradeLevel` set to the item's target. Every arm runs in Full quality mode (SBERT + entities + NLI) with "Extra quality" off.

| Arm | What it is |
|---|---|
| **A** | **The current pipeline, unchanged (baseline).** This is the app's per-node path (`simplify.ts`) for one pasted paragraph: `buildPrompt` with the `standard` variant, the app's lexical hints and no rolling context (`scripts/train-data/render.ts`, parity-tested); one call; the `<think>` strip; `flattenLists` (plain style); `assessMeaning` with the echo guard; at most one meaning retry (`shouldRetry`, `buildRetryInstruction(retryInputOf(…))`) and `pickBetterVersion`; and the echo-strip last resort. |
| **B** | **Grade-aware prompt wording only** (no retry beyond A's meaning retry). |
| **C** | **Grade-aware wording + grade-feedback retry (the proposal).** The output is measured, and if it misses the target the model is asked again with feedback about the measured grade. |

Rules for B and C:
- Their exact wording and loop are written in Prompt 11.
- Whatever they are, they never exceed `MAX_MODEL_CALLS_PER_NODE` (3) model calls per node, A's meaning retry included.
- They may read the target and the app's own readability measures. They may not read the items' FKGL from items.jsonl, or anything else from this evaluation.
- Prompt 11 may only *add* B and C to `scripts/grade/run-arm.mjs`. Changing arm A's path, the measures (`measure()` in `run-arm.mjs`) or `scripts/grade/report.mjs` after this commit is a deviation.

## Items

`eval/grade-targeting/items.jsonl`, 200 items. The file's SHA-256, LF line endings, is:

`e2bafeabdd9edbe5e75e321384689b64ba36f885778d28bbddda7d3a6b446577`

`npm run grade:run -- --select-items` drew it once, with no model involved, and it is never re-drawn. A redraw with `--force` must be byte-identical. Line 1 is a header with the provenance counts. Each other line holds the item's ASSET row index(es), its text, the SHA-256 of the text, its target, and its source FKGL and estimated grade.

| Target grade | Sentences | Pseudo-paragraphs | Total |
|---|---|---|---|
| 4 | 30 | 20 | 50 |
| 6 | 30 | 20 | 50 |
| 8 | 30 | 20 | 50 |
| 10 | 30 | 20 | 50 |
| **All** | **120** | **80** | **200** |

**Why this mix.** FKGL is noisy on single sentences, and the app works on paragraph nodes, so paragraphs are the realistic unit. Sentences are kept so the numbers can be compared with Prompt 10 and the bake-off.

### Source and exclusions

- **Source:** ASSET validation only (`facebook/asset`, config `simplification`, revision `98c452d91f4f35b48746d1a1878ea60128dc0ff1`; `training/data/asset_val.jsonl`, 2,000 rows). Only the original sentences are used, never the references.
- **TurkCorpus validation (`turk_val.jsonl`) is never read.** It has the same 2,000 source sentences (only the references differ), and CLAUDE.md reserves it.
- **ASSET test and TurkCorpus test** are reserved for the final benchmark and are used here only as dedupe targets.
- **The Prompt 10 evaluation rows are excluded:** 685 rows, which are the 300 sentences plus the 385 rows of the 100 pseudo-paragraphs in `training/eval/items.json` (SHA-256 `ccd85806b11f8785cd3168348617418f6a25371d255bf7baeeaa2006c8d5df78`). The exact rows are:

  <details><summary>685 excluded row indexes (0-based, inclusive ranges)</summary>

  2-3, 7, 9, 11, 15, 19, 22, 25, 28, 34, 39, 41, 46-50, 52, 65, 70-73, 80-83, 85, 93, 102, 113, 115-119, 122-126, 129, 135-136, 143-145, 147, 151-157, 163, 168, 170-175, 180-181, 190, 195, 197-202, 204, 208-212, 222-226, 229, 232-235, 239-243, 247, 250, 265, 274, 277, 280, 284-290, 293, 295-299, 301-303, 309-311, 315, 318-319, 321-322, 327-328, 330-334, 338, 346, 350, 353, 362, 366, 368, 371-374, 379, 387, 394, 397, 406, 414-419, 423, 439, 441-444, 452, 457, 460, 466, 468-470, 474, 480, 482, 485, 500-501, 516-519, 523, 530, 533-537, 539, 542, 546, 549, 551-553, 556, 559, 563-564, 568, 573-575, 580, 584, 587-592, 596, 601-606, 619, 625, 630-632, 635, 640, 648, 653-655, 666-668, 673, 675-678, 680-682, 684-687, 691-695, 703, 710-713, 716, 719, 721, 730-734, 737, 740-742, 745-749, 753, 756-759, 762-764, 772-774, 778, 782-785, 789, 793, 796, 798-800, 805, 814-816, 829, 833, 835, 837-841, 850, 856-860, 864-866, 871, 875, 881, 885, 899, 908, 914, 916, 919, 929, 933, 937, 940, 947, 949, 952, 954-957, 961, 963-967, 977-978, 981, 986, 989, 991-995, 998, 1002, 1005, 1014, 1022, 1032, 1035, 1038, 1041-1042, 1044-1048, 1055-1056, 1058, 1060, 1065, 1067, 1069, 1075-1077, 1090, 1094-1097, 1099, 1102, 1110-1115, 1118, 1136, 1141, 1146-1147, 1156, 1175-1179, 1182-1185, 1188-1190, 1193, 1211, 1213, 1216, 1219-1223, 1228, 1236-1237, 1259, 1268, 1270-1275, 1282, 1284, 1287-1290, 1295, 1310, 1317, 1323, 1327-1331, 1334, 1340-1342, 1344-1348, 1355-1357, 1360-1363, 1367-1371, 1373-1374, 1378, 1383, 1385, 1391, 1394, 1402, 1406-1410, 1416, 1421, 1426-1430, 1437, 1440, 1446, 1449, 1451-1454, 1458, 1461, 1473, 1475, 1478, 1486-1490, 1494-1495, 1497, 1499, 1501-1503, 1506, 1513-1515, 1518, 1520, 1522-1525, 1527, 1531-1534, 1537-1540, 1546, 1548, 1555-1558, 1563-1565, 1572-1574, 1576-1581, 1585-1590, 1601-1603, 1606-1610, 1612, 1622-1626, 1631-1632, 1640-1642, 1644-1648, 1651, 1655, 1658-1661, 1664, 1675, 1677, 1685, 1688, 1698-1699, 1701, 1704, 1707, 1711-1713, 1720-1722, 1724, 1728-1732, 1737, 1739-1742, 1746-1748, 1750-1756, 1759-1761, 1769, 1777-1781, 1796, 1800-1803, 1808, 1821-1824, 1826-1828, 1834, 1839, 1845-1849, 1853, 1856-1861, 1866, 1872-1876, 1879, 1893, 1896, 1901-1902, 1918, 1932-1933, 1938-1943, 1945, 1951-1955, 1959, 1961-1962, 1970, 1977, 1983, 1985-1988

  </details>

- **Dedupe.** The Prompt 10 matcher (`normaliseForDedupe` + `reservedHits` in `scripts/train-data/lib.ts`, twin of `training/prepare/dedupe.py`) drops a row or a joined window if, after NFKC + lowercase + punctuation removal, it exactly matches a reserved text or has **8-gram containment ≥ 0.5** with one in either direction. It is checked against:
  - ASSET test (359) and TurkCorpus test (359);
  - the NLI calibration texts (221);
  - the bake-off paragraphs (40);
  - the dev fixtures (43); these five sets come from `training/data/reserved.jsonl`;
  - the 400 Prompt 10 item texts;
  - the 8 paragraphs of the UK Wikipedia fixture (`eval/fixtures/uk-wiki-paste.txt`, read directly).

  This removed 8 more rows: 5 that overlap Prompt 10 items, 3 that overlap ASSET test, and the same 3 that overlap TurkCorpus test.
- **The remaining pool is 1,307 rows**, of which 24 are under 8 words.

### Sampling procedure

1. `rand = mulberry32(42)`. The shuffle is Fisher–Yates `shuffleWith` from `scripts/train-data/lib.ts`. `sentenceOrder = shuffle(0…1999)`, then `paragraphOrder = shuffle(0…1999)`, both with the same `rand`.
2. Targets are filled in the order **10, 8, 6, 4** (hardest first, so rows only hard enough for grade 10 aren't used up by the low targets). For each target:
   1. **30 sentences:** walk `sentenceOrder`. Skip a row that is already used, outside the pool, or under 8 words. Count a row as "already simple" and skip it when `isAlreadySimple(text, target)`. Otherwise take it.
   2. **20 pseudo-paragraphs:** walk `paragraphOrder`. At each start row, draw a size of 3–5 rows with `randomInt(3, 5, rand)`. The window is that many consecutive rows, joined with single spaces (each row trimmed). Skip it if it runs past row 1999, or if any row is used or outside the pool. Skip it if the joined text overlaps a reserved text. Count it as "already simple" and skip it when `isAlreadySimple(text, target)`. Otherwise take it and mark its rows used.
3. **No row is in two items.** ASSET has no article boundaries, so the rows of a pseudo-paragraph are unrelated sentences, as in the Prompt 10 pseudo-paragraphs.
4. **Eligibility uses the app's code:** `isAlreadySimple` (`src/lib/metrics/node-grade.ts`, estimated grade with the base common-word list ≤ target) and the 8-word floor of `shouldCheckNode`. Every item therefore reaches the model and gets the meaning check.

Candidates rejected as already at or below their target while each bucket was filled:

| Target | Sentences | Paragraph windows |
|---|---|---|
| 10 | 13 | 2 |
| 8 | 11 | 0 |
| 6 | 5 | 0 |
| 4 | 2 | 0 |

No window was rejected for overlap. The 200 items use 407 rows.

## Definitions

Every measure is taken by `scripts/grade/run-arm.mjs` with the app's own code. Nothing is re-implemented.

- **Source text:** `cleanForModel(item text)`, the text the app sends and checks.
- **Output:** the kept version after the arm's whole path, as stored by the app (raw, list markers included). Plain output is `toPlainText(output)`.
- **FKGL:** `computeReadabilityReport(plain output, base common-word list).fleschKincaidGradeLevel` (`src/lib/metrics/engine.ts`).
- **Target-grade hit:** |FKGL(output) − target grade| ≤ 1.0. An empty output is a miss.
- **Near-copy:** normalised edit distance from the source < 0.10. This is the word-level Levenshtein distance between the plain source and the plain output, divided by the longer one's word count (`wordEditRatio` in `scripts/bakeoff/lib.ts`, words = lowercase letter/digit runs). An empty output is not a near copy.
- **Entities kept:** the share of the source's entities present in the output, using the app's existing entity extractor.
  - The distinct entity texts are taken from `detectEntities(source)` (`src/lib/segmentation/ner.ts`), case-insensitive.
  - An entity counts as present unless `findMissingEntities(entities, plain output)` (`src/lib/quality/semantic.ts`) reports it missing.
  - The measure is the per-item share, averaged over items whose source has at least one entity.
- **Meaning pass:** the kept version passes the in-app checker. That is `candidatePasses`, where `assessMeaning` (`src/lib/quality/meaning.ts`) uses the frozen combined score: FULL with NLI, LITE when NLI fell back.
  - A version is **fully checked** when NLI ran (`nliChecked`) and the SBERT similarity exists.
  - The meaning pass rate is computed over items fully checked in both arms of a comparison.
- **Seconds per node:** the wall clock from the start of the item's first model call until the kept version is chosen. It includes every model call and every meaning check (NLI on CPU through onnxruntime-node, all-minilm through Ollama). Untimed warm-up and model loading come before the first item.

## Criteria (C vs A)

### Primary

**The target-grade hit rate of arm C minus arm A must be ≥ +15 percentage points, with the 95% CI lower bound above 0.** This is pooled over all 200 items. The CI is a paired bootstrap over items: 10,000 resamples with replacement, mulberry32 seed 42, percentile interval with linear interpolation.

### Guardrails

All four must hold for C vs A (point estimates, paired over the same items):

1. The meaning pass rate (in-app checker) falls by **no more than 3 points**.
2. Entities kept falls by **no more than 2 points**.
3. Arm C's near-copy rate is **≤ 5%**.
4. The median wall-clock seconds per node rises by **no more than 60%** (median C / median A − 1 ≤ 0.60).

### Secondary (reported, never change the verdict)

- Grade hit for **sentences** and for **pseudo-paragraphs** separately, and per target grade (4, 6, 8, 10), with bootstrap CIs.
- B vs A on every measure.
- Mean |FKGL − target|, mean output FKGL, model calls per node, and meaning-check coverage.

## Decision rule (stated in advance)

- **If the primary criterion fails, the retry loop is NOT enabled by default.** The result is reported as a negative result in `eval/grade-targeting/REPORT.md`, with every table.
- If the primary criterion holds but any guardrail fails, the loop is not enabled by default either. The report says which guardrail failed.
- Only if the primary criterion and all four guardrails hold may Prompt 11 turn the grade-feedback retry on by default.
- B's wording may be kept independently of the loop only if B vs A shows no guardrail violation. That is a secondary judgement, reported as such.

## Procedure

- **Run order:** A, then B, then C, on the same PC with GPU and the same Ollama version.
- **Before each arm,** every loaded model is unloaded and one untimed warm-up loads the chat model, all-minilm and the NLI model.
- **Missing checkers:** the run stops before the first item if the NLI model (`npm run fetch-models`) or all-minilm is missing. There is no Lite fallback.
- **Ollama errors** stop the run without recording the item. A rerun resumes from there, keyed by arm, item and prompt hash. A changed prompt for a done item stops the run.
- **One run per arm.** No arm is re-run to improve a result, and no item is dropped after generation.
- **Smoke tests** (`--limit N`) write to `eval/grade-targeting/runs/smoke/` (git-ignored) and are not results.
- **Commands:**
  - `npm run grade:run -- --arm A` (then `B` and `C` once Prompt 11 adds them);
  - `npm run grade:report` → `eval/grade-targeting/REPORT.md`.

## What will not be done

- No tuning of prompts, sampling, the retry loop or thresholds on these items after seeing any output. Development of B and C uses other texts.
- No reuse of these items in training, calibration, the checker fit or any other tuning.
- No change to the definitions or criteria above without a Deviations entry committed before the affected run.

## Deviations

- 2026-10-24, before any pre-registered run (only git-ignored `--limit` smoke runs existed): a bug fix to file-path resolution only. `scripts/grade/run-arm.mjs` and `scripts/grade/report.mjs` now take the runs directory and the `arm-<X>.jsonl` name from one helper in `scripts/grade/lib.ts` (`runsDir`, `runFilePath`), resolved from the repository root, never the working directory. `run-arm.mjs` prints the absolute path it wrote, and `report.mjs` lists the directory searched, the expected names and what it found when there is no run. No item, measure, criterion or decision rule changed.
- 2026-10-24, before any pre-registered run (only git-ignored `--limit` smoke runs existed): a pre-run integrity guard. Every run record carries its provenance (commit, dirty tree, Ollama version, model tag and digest, temperature, seed, quality mode, items.jsonl sha256, arm); `run-arm.mjs` refuses to append on any mismatch (`--new-run` starts a fresh file, moving the old one aside), and `report.mjs` prints each arm's provenance and does not pool an arm whose file mixes provenances. No item, measure, criterion or decision rule changed.
