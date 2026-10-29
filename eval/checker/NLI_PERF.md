# NLI performance: diagnosis and fix (2026-10-29)

This file records why the NLI meaning check took 22.5 s per paragraph in Chrome at commit `7048e21`, what was measured, and what changed. It contains no tuning: the scoring model, its weights and threshold, `ENTAILMENT_MIN`, `CONTRADICTION_MAX` and `QUALITY_THRESHOLD` (0.718) are unchanged.

## The report that started it

A Chrome run report at `7048e21`: a 4-paragraph Wikipedia paste (Karnataka), RTX 4050, "WebGPU" backend, Full mode.

| Field | Value |
|---|---|
| `measuredParagraphMs` | 22,492 |
| `measuredScoreMs` / `measuredRankMs` | 21,869 / 621 |
| `predictedParagraphMs` (benchmark) | 7,791 |
| `nliPairs` | 219 (5 scored versions: 4 nodes plus 1 retry) |
| `secondsPerModelNode` | 34.8 |

## What was checked, and what was found

### 1. Pair generation: as intended, not a regression

The premise strategy is `summac-sentences+pairs/top3`: every output sentence is scored against its top 3 premises (or all of them when there are 3 or fewer). On the 5 scored versions of the report, the output sentence counts were 17, 16, 13, 10 and 16. That gives 3 × 72 = 216 pairs, against 219 logged.

On all 29 scored versions of the two reports (UK fixture and Karnataka), every version gets exactly 3 pairs per output sentence. The average is 36.1 pairs per version.

**The pairs per paragraph grew because the outputs got longer, not because pair generation changed.** At the `aggressive` tier, qwen3 writes 10–17 short sentences per paragraph, against the benchmark paragraph's 6 (18 pairs). On 2026-10-15, the qwen2.5 test-plan run averaged 19.5 pairs per version.

Hypothesis context (`prev-sentence-if-<7-words-or-referring`) makes some hypotheses longer, but it adds no pairs.

A unit test now pins this (`tests/unit/nli.test.ts`, "NLI pair count"). The UK fixture's n1 output has 9 sentences and gets 27 pairs, and the whole Full run totals 564 pairs. A change that inflates pair generation fails CI.

### 2. Dtype, model reuse, batch size: as reported

- The worker loads q8 (`model_quantized.onnx`) once per worker (`loaded ??=`), not per call or per batch.
- The client sent batches of 32 on WebGPU (`batchSizeFor`). *Superseded: since the pin below, every machine uses `NLI_BATCH_SIZE` = 8.*

### 3. The cause: "WebGPU" was a single CPU thread

The q8 model contains **74 `MatMulInteger` and 50 `DynamicQuantizeLinear` nodes**, and ONNX Runtime's WebGPU execution provider has no kernel for either.

Checked with onnxruntime-node 1.30, whose native WebGPU EP is the same C++ provider that the extension's `ort-wasm-simd-threaded.asyncify` build compiles:

- **CPU fallback disabled:** a session with `session.disable_cpu_ep_fallback = 1` fails with *"This session contains graph nodes that are assigned to the default CPU EP, but fallback to CPU EP has been explicitly disabled"*.
- **Verbose placement log:** 1,225 nodes go on WebGPU (layer norms, softmax, gathers) and 979 go on the CPU EP. The CPU nodes include **all 74 `MatMulInteger` and all 50 `DynamicQuantizeLinear`**, which is essentially all the model's arithmetic.

So in Chrome, "webgpu" meant this: every quantized matmul ran on ORT's CPU EP inside the wasm, on **one thread** (the page was not cross-origin isolated), with a GPU↔CPU copy around each of them.

This is why time grew linearly with tokens, which a GPU would not show: 70 ms per pair for the old 8 short pairs, 433 ms per pair for the 18-pair benchmark, and 950 ms per pair for the 39 long pairs of n1's retry. Batches of 32 padded every pair to the longest pair in its batch, adding about 57% padding (1.57× the real tokens).

### 4. The 1256 → 7791 ms "benchmark regression" is mostly a change of yardstick

Commit `6f82ef6` replaced the old benchmark with one realistic paragraph:

- **Old:** 8 short pairs, scaled up to 18 pairs. It predicted 1256 ms.
- **New:** one realistic paragraph of 18 pairs: longer premises, 2-sentence windows, one padded batch. It measured 7791 ms.

The UK run on 2026-10-19, on the same machine with the old code, already measured 4875 ms per paragraph.

## Unexpected finding: q8 scores depend on batch composition

`DynamicQuantizeLinear` picks one int8 scale for the **whole batch tensor**, padding rows included. So a pair's probabilities depend on which other pairs share its batch. `npm run nli:perf` measured this on the 29 versions, with identical pairs and premises and only the batching changed:

| Comparison (same device) | Verdict flips | Sentence-verdict changes | max \|Δ nliMin\| | max \|Δ contra\| |
|---|---|---|---|---|
| batch 8 vs batch 32 (CPU) | 3/29 | 8 | 0.318 | 0.349 |
| length-sorted vs batch 32 (CPU) | 1/29 | 5 | 0.180 | 0.243 |
| one pair per call vs batch 32 (CPU) | 0/29 | 9 | 0.185 | 0.737 |
| batch 32 on WebGPU EP vs batch 32 on CPU | 0/29 | 6 | 0.094 | 0.680 |
| **4 threads vs 1 thread, any batching (CPU)** | **0/29** | **0** | **0** | **0** |

What this means:

- **Before this change the app already judged differently per machine.** WebGPU machines used batches of 32 and wasm machines batches of 8. The calibration and the combined-score fit (`scripts/checker/extract-features.mjs`, an `NliClient` without `load()`) also scored in batches of 8.
- **The pair cache adds more of the same.** A retry scores only the pairs it hasn't seen, so its batches differ from a cold run's.
- **Any change to batching changes verdicts**, so length-sorted batching was **not adopted** (it was also not consistently faster on the CPU).
- **Making scoring batch-invariant is a meaning change, not a speed fix.** That is one pair per call, or batches of equal-length pairs. It needs a re-calibration or at least a pre-registered decision. It is not planned; the batch size is pinned instead (see "Pinned batch size" below).

## The fix

**q8 now runs on multi-threaded wasm instead of the WebGPU EP, with the batches each machine already used.**

- **Manifest:** `cross_origin_embedder_policy: require-corp` and `cross_origin_opener_policy: same-origin`. These make the extension pages cross-origin isolated, which gives the worker SharedArrayBuffer. This is not a CSP change, and `key` is unchanged. Everything the app loads is same-origin, and Ollama answers CORS (`OLLAMA_ORIGINS`).
- **Worker:** with isolation, q8 loads on wasm with `NLI_WASM_THREADS` (4, at most the core count). Ollama runs alongside, which is why it is not more.
  - The WebGPU adapter is still requested. Its presence kept the batch size at 32, exactly as before (*superseded by the pin below*), and keeps Auto's "has WebGPU" rule.
  - Without isolation, the old path is kept: WebGPU EP, one thread.
  - The fp16 experiment stays on WebGPU.
  - `debug:nliDevice = 'webgpu'` forces the old q8 path, so one build can measure before and after.
- **`BENCH_FORMAT` 3:** stored benchmarks are re-measured on the new backend, and the record carries `threads`.
- **Verdicts:** threads are bit-identical to one thread (table above). Moving from the WebGPU EP to CPU kernels with the same batches of 32 flipped **0 of 29** verdicts. It changed 6 sentence-level scores slightly (GPU vs CPU float rounding in the non-quantized ops). The CPU kernels are the ones the calibration ran on.

## Before / after

### Node, onnxruntime-node 1.30, same q8 model, the 29 versions (`npm run nli:perf`)

Times are NLI scoring per version, with word-overlap premise ranking. Laptop CPU timings are noisy: the same 1-thread batch-32 configuration measured 2832 ms and 4628 ms in two runs. The ordering was the same both times.

| Configuration | Batching | Mean ms/version | p50 |
|---|---|---|---|
| WebGPU EP (≈ before, on a WebGPU machine) | in order, 32 | 3492 | 3396 |
| CPU, 1 thread (≈ before, on a wasm machine) | in order, 8 | 6764 | 4349 |
| **CPU, 4 threads (after, WebGPU machine)** | in order, 32 | **1943** | **1088** |
| **CPU, 4 threads (after, wasm machine)** | in order, 8 | **2195** | **1208** |

*The WebGPU-machine row is superseded: since the pin below, every machine scores in order in batches of 8.*

So the after configuration is about **1.8× faster** than the WebGPU EP on a WebGPU machine, and about **3× faster** than one thread on a machine without one.

Native code is faster than Chrome's wasm: the Node WebGPU EP took 97 ms per pair, against 430 ms per pair in Chrome. The Chrome numbers below are the ones that count.

### Chrome (to fill in: same machine, same build, same document)

Build (`npm run build`), load `dist/`, paste `eval/fixtures/uk-wiki-paste.txt`, set Quality mode to **Full**, then:

1. **Before.** In the app tab's DevTools: `chrome.storage.local.set({ 'debug:nliDevice': 'webgpu' })`. Reload the tab, run **Re-simplify all**, and download the run report.
2. **After.** `chrome.storage.local.remove('debug:nliDevice')`. Reload the tab and check that `crossOriginIsolated` is `true` in the console and that the log says `loaded on wasm 4 threads (webgpu adapter nvidia …)`. Run **Re-simplify all** and download the run report.
3. From each report, copy `runs[-1].nli.measuredParagraphMs`, `measuredScoreMs`, `benchMs` and `summary.meaning.nliPairs`.

| Run | Backend | measuredParagraphMs | measuredScoreMs | benchMs | nliPairs |
|---|---|---|---|---|---|
| Before (`debug:nliDevice = 'webgpu'`) | webgpu (q8, CPU EP fallback) | | | | |
| After (default) | wasm, 4 threads | | | | |

## Budget

`NLI_BUDGET_MS` goes from 1000 to **3000**. A paragraph is now about 36 pairs (12 sentences × 3). Even native 4-thread CPU averaged 1943 ms on the fixtures, and Chrome's wasm is slower than native, so 1000 ms was a budget that is always exceeded.

3000 ms is `AUTO_LITE_PARAGRAPH_MS`, the point at which Auto already judges NLI too slow for Full. If the Chrome "after" row is well under it, this can be lowered again.

## Pinned batch size (2026-10-29)

`NLI_BATCH_SIZE` = 8 (`src/lib/quality/config.ts`) is now the only NLI batch size: in the browser and in every Node script, on every machine, backend and quality mode. `batchSizeFor`, `batchClassOf`, the `NliClient` batch-size argument and the 32 / 8 pair of constants are gone. `scripts/lib/nli-node.mjs` `score()` reads the same constant, so the scripts that call the model directly (`calibrate-nli.mjs`) batch like the app.

**Why 8: it is the calibrated condition.** The combined score's weights (`COMBINED_SCORE_FULL` / `LITE`) and `QUALITY_THRESHOLD` (0.718) were fitted on features from `npm run checker:extract -- --set calib` (2026-10-19, commit `0c2f5de`), which scored through an `NliClient` without `load()`, so in batches of 8 on one CPU thread. Machines with a WebGPU adapter scored in batches of 32, which flips 3 of the 29 verdicts below. Pinning to 8 restores the calibrated condition on those machines. It is not a pre-registration change: no weight, threshold or scoring rule changed.

**What the pin guarantees: reproducibility, not batch invariance.** A q8 pair's score still depends on its batch-mates (one quantization scale per batch), and the last, partial batch varies with how many pairs are queued (and with cache hits on a retry). What the pin guarantees is that the same input produces the same batches, and so the same verdicts, on any machine, under the same rule the calibration used. The calibration had the same dependence: `extract-features.mjs` shares one cached client across items.

**What verifies what.**
- The unit tests (`tests/unit/nli.test.ts`, "NliClient — pinned batch size") verify the **chunking logic** with fake backends:
  - the constant is 8;
  - any queue length on any load result is sent as chunks of exactly 8 plus a remainder, in order;
  - one call and 8-aligned groups give identical scores under a batch-sensitive fake;
  - a guard: a 5 + 19 grouping gives different scores, so the previous check can't pass vacuously.
- The perf run below verifies the **model's behaviour**.

### Measured (onnxruntime-node, same q8 model, the 29 versions)

Inputs: `eval/fixtures/runs/uk-wiki-2026-10-19.json` (20 versions) and `clarity-run-report-karnataka-a-is-a-state-on-the-southweste-2026-10-27.json` (9 versions; a downloaded Chrome run report that is **not in git**).

1. **Before the change**, with the old script (the batching strategies of commit `50f401d`): `node scripts/nli-perf.mjs <both reports> --configs cpu1,cpu4 --json eval/checker/nli-perf-before.json`
2. **After the change**: `npm run nli:perf -- <both reports> --configs cpu1,cpu4 --baseline eval/checker/nli-perf-before.json --json eval/checker/nli-perf-after.json`

Both JSON files are committed.

| Run | Config | Batching | Mean ms/version | p50 | Batches | Padded/real tokens |
|---|---|---|---|---|---|---|
| before | CPU, 4 threads | in order, 32 | 1546 | 1649 | 50 | 1.57× |
| before | CPU, 4 threads | in order, 8 | 1400 | 1445 | 144 | 1.40× |
| **after (pinned)** | **CPU, 4 threads** | **8** | **1039** | **1071** | 144 | 1.40× |
| after (pinned) | CPU, 1 thread | 8 | 2158 | 2166 | 144 | 1.40× |

- **Cost of batch 8 versus 32: none.** In the same session, at 4 threads, batch 8 was 9.4% faster than batch 32 (1400 vs 1546 ms mean; 1445 vs 1649 p50). Smaller batches pad less (1.40× vs 1.57× the real tokens). The after run's 1039 ms is from another session, so it is not compared with the before numbers.
- The 1-thread timings of the before session are not usable (in order 32 took 8564 ms there, against 2832 and 4628 ms in earlier runs, and in order 8 took 10146 ms against 2158 ms after), probably because of other load on the laptop. The verdict comparisons do not depend on timing.
- **Verdicts: 0 of 29 changes against the batch-8 baseline.** After vs before in order 8 gives 0/29 verdict flips, 0 sentence-verdict changes and max |Δscore|, |ΔnliMin| and |Δcontra| all 0, on both 1 and 4 threads. The scores are bit-identical (same batches, so same numbers). 4 threads vs 1 thread is also 0 / 0 / 0.
- Against the old batch-32 path (machines with an adapter) the before run shows the expected 3/29 flips, 8 sentence-verdict changes, max |ΔnliMin| 0.318 and max |Δcontra| 0.349. Those machines now judge like the calibration.

The Chrome benchmark format is now `BENCH_FORMAT` 4, so a stored benchmark timed in batches of 32 is re-measured.

## Open items (not done here)

- ~~**Batch-invariant scoring.**~~ **Closed 2026-10-29** by pinning the calibrated rule (`NLI_BATCH_SIZE` = 8, above), not by making scoring invariant: scores still depend on batch-mates and the cache, exactly as during the calibration. True invariance (one pair per call, or equal-length batches) would change scores and need a new calibration under a new pre-registration; it is not planned.
- **The benchmark paragraph has 6 sentences, but real qwen3 outputs average about 12.** `predictedParagraphMs` therefore underestimates real paragraphs by about 2×, and Auto's Lite decision inherits that.
- **fp16 on WebGPU would actually use the GPU.** But it is different weights, so it needs its own calibration (`clarityNliExperiment()` exists for this).
