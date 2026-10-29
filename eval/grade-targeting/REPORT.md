# Grade-targeting evaluation: report (Prompt 11)

Generated 2026-10-27 by `npm run grade:report` from `eval/grade-targeting/runs`, following `eval/grade-targeting/PREREG.md`. Items: `eval/grade-targeting/items.jsonl` (200).

## Provenance

| Arm | Records | Commit | Dirty | Model | Digest | Ollama | Temperature | Seed | Think | Quality mode | NLI model | items.jsonl sha256 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 200 | `10be0a623c1d` | no | `qwen3:4b-instruct-2507-q4_K_M` | `0edcdef34593` | 0.35.0 | 0 | 42 | false | full | `Xenova/nli-deberta-v3-xsmall` | `e2bafeabdd9e` |
| B | 200 | `7048e219cd87` | no | `qwen3:4b-instruct-2507-q4_K_M` | `0edcdef34593` | 0.35.0 | 0 | 42 | false | full | `Xenova/nli-deberta-v3-xsmall` | `e2bafeabdd9e` |
| C | 200 | `7048e219cd87` | no | `qwen3:4b-instruct-2507-q4_K_M` | `0edcdef34593` | 0.35.0 | 0 | 42 | false | full | `Xenova/nli-deberta-v3-xsmall` | `e2bafeabdd9e` |

## Verdict

**NOT ADOPTED**: the primary criterion holds but a guardrail failed; the retry loop stays off by default.

| Pre-registered criterion (C vs A, pooled) | Result | Met |
|---|---|---|
| Grade hit C − A ≥ +15 points and 95% CI lower bound > 0 | +16.5 pts [+11.0, +22.5] | yes |
| Meaning pass rate falls by ≤ 3 points | +4.0 pts | yes |
| Entities kept falls by ≤ 2 points | -0.7 pts | yes |
| Arm C near-copy rate ≤ 5% | 1.0% | yes |
| Median seconds per node rises by ≤ 60% | +94.2% (median 1.42 → 2.75 s) | **no** |

## Per arm

| Arm | n | Grade hit | Hit (sentences) | Hit (paragraphs) | Meaning pass | Fully checked | Entities kept | Near copy | Mean FKGL | Mean \|FKGL − target\| | Calls | Median s/node |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 200 | 25.5 | 25.0 | 26.3 | 81.5 | 100.0 | 97.7 | 1.0 | 5.78 | 2.44 | 1.19 | 1.42 |
| B | 200 | 27.5 | 25.0 | 31.3 | 82.5 | 100.0 | 97.5 | 1.0 | 5.87 | 2.29 | 1.19 | 1.58 |
| C | 200 | 42.0 | 42.5 | 41.3 | 85.5 | 100.0 | 96.9 | 1.0 | 6.14 | 1.69 | 1.80 | 2.75 |

Rates are percentages. Meaning pass is over fully checked items; entities kept over items whose source has an entity.

## B − A (paired)

| Measure | n | Difference | 95% CI |
|---|---|---|---|
| Grade hit (pooled, primary) | 200 | +2.0 | [-3.0, +7.0] |
| Grade hit, sentences | 120 | +0.0 | [-6.7, +6.7] |
| Grade hit, paragraphs | 80 | +5.0 | [-1.3, +11.3] |
| Grade hit, target 4 | 50 | +0.0 | [-12.0, +12.0] |
| Grade hit, target 6 | 50 | +4.0 | [-8.0, +16.0] |
| Grade hit, target 8 | 50 | +0.0 | [-8.0, +8.0] |
| Grade hit, target 10 | 50 | +4.0 | [+0.0, +10.0] |
| Meaning pass | 200 | +1.0 | [-3.0, +5.0] |
| Entities kept | 156 | -0.2 | [-1.7, +1.7] |
| Near copy | 200 | +0.0 | [-1.5, +1.5] |
| \|FKGL − target\| (grades) | 200 | -0.15 | [-0.27, -0.02] |

## C − A (paired)

| Measure | n | Difference | 95% CI |
|---|---|---|---|
| Grade hit (pooled, primary) | 200 | +16.5 | [+11.0, +22.5] |
| Grade hit, sentences | 120 | +17.5 | [+10.0, +25.8] |
| Grade hit, paragraphs | 80 | +15.0 | [+6.3, +23.8] |
| Grade hit, target 4 | 50 | +14.0 | [+4.0, +26.0] |
| Grade hit, target 6 | 50 | +22.0 | [+8.0, +36.0] |
| Grade hit, target 8 | 50 | +24.0 | [+12.0, +38.0] |
| Grade hit, target 10 | 50 | +6.0 | [+0.0, +14.0] |
| Meaning pass | 200 | +4.0 | [+0.5, +7.5] |
| Entities kept | 156 | -0.7 | [-3.0, +1.6] |
| Near copy | 200 | +0.0 | [-1.5, +1.5] |
| \|FKGL − target\| (grades) | 200 | -0.74 | [-0.91, -0.59] |

## Grade hit by target (secondary)

| Target | A | B | C |
|---|---|---|---|
| 4 | 32.0 | 32.0 | 46.0 |
| 6 | 44.0 | 48.0 | 66.0 |
| 8 | 20.0 | 20.0 | 44.0 |
| 10 | 6.0 | 10.0 | 12.0 |

Differences are arm − A over the same items; paired bootstrap, 10000 resamples, seed 42, percentile 95% interval. Pooled grade hit is the primary measure; everything else is secondary or a guardrail.

## POST-HOC: shipped as an opt-in setting (2026-10-29)

**Not part of the pre-registered analysis.** This section was added by hand after the report above was generated. Nothing above it changed, and `npm run grade:report` would not reproduce it: re-generating the report drops this section, so add it back.

- **Decision applied:** the primary criterion held (grade hit +16.5 points, 95% CI [+11.0, +22.5]) and every quality guardrail held. But the speed guardrail failed: the median seconds per node rose by +94.2%, against a limit of +60%. Under the PREREG decision rule, the grade-feedback retry is therefore **not enabled by default**. `GRADE_WORDING_ENABLED` and `GRADE_RETRY_ENABLED` in `src/lib/quality/config.ts` stay `false`.
- **What ships:** an opt-in user setting, Settings → AI Model → "Match the target reading grade more closely". It is sync `gradeTargeting`, off by default.
  - Turning it on enables exactly what arm C measured: the grade-aware prompt wording and the FKGL measure-and-retry (`src/lib/quality/grade.ts`).
  - The call budget is unchanged: at most 2 model calls per node, or 3 with "Extra quality".
  - It has no effect in Lite mode.
  - Run reports record `gradeTargetingSetting` and, when it was in effect, `gradeTargeting`.
- **Why opt-in rather than off:** the speed guardrail is the only criterion that failed. A reader who values a closer reading grade over speed can choose that trade-off. No pre-registered threshold, criterion or default was changed.
- **Not re-measured:** the app's NLI backend changed afterwards (q8 on multi-threaded wasm, `eval/checker/NLI_PERF.md`). The arm runs used onnxruntime-node on the CPU, so the per-node times above are unaffected, and no arm was re-run.
