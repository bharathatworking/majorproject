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
- The client sends batches of 32 on WebGPU (`batchSizeFor`).

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
- **Making scoring batch-invariant is a meaning change, not a speed fix.** That is one pair per call, or batches of equal-length pairs. It needs a re-calibration or at least a pre-registered decision, so it is left as an open item.

## The fix

**q8 now runs on multi-threaded wasm instead of the WebGPU EP, with the batches each machine already used.**

- **Manifest:** `cross_origin_embedder_policy: require-corp` and `cross_origin_opener_policy: same-origin`. These make the extension pages cross-origin isolated, which gives the worker SharedArrayBuffer. This is not a CSP change, and `key` is unchanged. Everything the app loads is same-origin, and Ollama answers CORS (`OLLAMA_ORIGINS`).
- **Worker:** with isolation, q8 loads on wasm with `NLI_WASM_THREADS` (4, at most the core count). Ollama runs alongside, which is why it is not more.
  - The WebGPU adapter is still requested. Its presence keeps the batch size at 32, exactly as before, and keeps Auto's "has WebGPU" rule.
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

## Open items (not done here)

- **Batch-invariant scoring.** Use one pair per call, or equal-length batches, so a verdict no longer depends on batch neighbours, the cache, or the machine. This changes scores, so it needs a decision and probably a re-run of `npm run checker:extract` and `checker:fit` under a new pre-registration.
- **The benchmark paragraph has 6 sentences, but real qwen3 outputs average about 12.** `predictedParagraphMs` therefore underestimates real paragraphs by about 2×, and Auto's Lite decision inherits that.
- **fp16 on WebGPU would actually use the GPU.** But it is different weights, so it needs its own calibration (`clarityNliExperiment()` exists for this).
