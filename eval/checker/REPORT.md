# Combined meaning score: held-out test

Generated once by `npm run checker:test` on 2026-10-19, after the pre-registration commit `624e90c` ("docs(checker): pre-register combined score"). The frozen values in `config.ts` were checked against `PREREG.md` before scoring. **No frozen value was changed after this run.**

**Test set:** the blind-labelled base-model bake-off outputs (`eval/model-bakeoff/`), GPU outputs of 3 models × 40 bakeoff-only paragraphs, near copies excluded: **119 items, 85 faithful / 34 unfaithful** (0 unsure, 0 unlabelled left out). None of these paragraphs or labels was used for fitting, feature selection or the threshold.

## Headline

FULL score (sbert, entity, nliMin, contra, lenRatio; threshold 0.569168): **balanced accuracy 64.7% [58.5%–71.0%]**, catch 100.0%, false-fail 70.6%. Targets (catch ≥ 90.0% AND false-fail ≤ 30.0%): **NOT met**.

## All three verdicts on the same items

| Verdict | Balanced accuracy | Catch | False-fail | AUC | Targets met |
|---|---|---|---|---|---|
| FULL combined score (frozen) | 64.7% [58.5%–71.0%] | 100.0% [100.0%–100.0%] (34/34) | 70.6% [58.0%–82.8%] (60/85) | 0.789 [0.696–0.878] | no |
| LITE combined score (frozen, no NLI) | 63.2% [57.2%–69.0%] | 97.1% [90.0%–100.0%] (33/34) | 70.6% [59.1%–81.2%] (60/85) | 0.758 [0.655–0.864] | no |
| Old rule (SBERT ≥ 0.87 AND entities AND NLI rule A) | 65.6% [59.3%–72.0%] | 97.1% [91.2%–100.0%] (33/34) | 65.9% [53.5%–77.8%] (56/85) | 0.656 [0.593–0.720] (0/1 verdict) | no |

95% CIs: cluster bootstrap over paragraphs, 2000 resamples, seed 42. Catch = unfaithful outputs that fail; false-fail = faithful outputs that fail.

## Confusion matrices

**FULL**

| Label \ verdict | passes | fails |
|---|---|---|
| faithful (85) | 25 | 60 |
| unfaithful (34) | 0 | 34 |

**LITE**

| Label \ verdict | passes | fails |
|---|---|---|
| faithful (85) | 25 | 60 |
| unfaithful (34) | 1 | 33 |

**Old rule**

| Label \ verdict | passes | fails |
|---|---|---|
| faithful (85) | 29 | 56 |
| unfaithful (34) | 1 | 33 |

## Old rule vs combined score (exact McNemar, correct / incorrect per item)

| Comparison | n | Both right | Only old rule right | Only score right | Both wrong | p |
|---|---|---|---|---|---|---|
| Old rule vs FULL | 119 | 55 | 7 | 4 | 53 | 0.549 |
| Old rule vs LITE | 119 | 50 | 12 | 8 | 49 | 0.503 |

## Per model (FULL score vs old rule)

| Model | n (faithful / unfaithful) | FULL BAcc | FULL catch | FULL false-fail | Old BAcc | Old catch | Old false-fail |
|---|---|---|---|---|---|---|---|
| `qwen2.5:3b` | 40 (20 / 20) | 62.5% [53.3%–72.5%] | 100.0% (20/20) | 75.0% (15/20) | 70.0% | 95.0% | 55.0% |
| `qwen3:4b-instruct-2507-q4_K_M` | 40 (34 / 6) | 64.7% [57.4%–72.2%] | 100.0% (6/6) | 70.6% (24/34) | 63.2% | 100.0% | 73.5% |
| `gemma4:e2b-it-qat` | 39 (31 / 8) | 66.1% [58.1%–75.0%] | 100.0% (8/8) | 67.7% (21/31) | 67.7% | 100.0% | 64.5% |

Per-model samples are small (a handful of unfaithful outputs each), so these rows are descriptive only.

## Extra latency per paragraph

- The frozen FULL model does **not** use `mainClaim`, so the app runs **no** extra NLI pairs per paragraph: the features come from checks the old rule already ran.
- The logistic regression itself: 0.43 µs per version (Node, 2000 repetitions over the 119 items).
- For reference (measured during extraction, Node CPU onnxruntime, one thread): the forward NLI check took median 1369 ms / p90 2135 ms per paragraph; the unused main-claim check would add median 452 ms / p90 933 ms.

## Reading

**The pre-registered targets were missed.** On the held-out set the frozen FULL score catches 100.0% of unfaithful outputs (target ≥ 90.0%) and fails 70.6% of faithful ones (target ≤ 30.0%), for a balanced accuracy of 64.7% [58.5%–71.0%]. The old rule scores 65.6% [59.3%–72.0%] on the same items (McNemar p = 0.549).

Context: paragraph-level faithfulness detection is hard even for much larger checkers. On LLM-AggreFact (Tang, Laban & Durrett, 2024, "MiniCheck", EMNLP), the best fact-checkers reach a balanced accuracy of about 77%, using models far larger than the extra-small DeBERTa-v3 NLI cross-encoder and all-minilm used here, which must run on the user's device. The calibration set (81 items) was small, λ = 1 won the inner CV and shrank the weights strongly, and the nested CV on calibration had already shown no gain over the old rule (PREREG.md), so this outcome was the expected one.

Tested once, no re-tuning on the test set.
