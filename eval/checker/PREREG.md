# Combined meaning score: pre-registration

Written by `npm run checker:fit` on 2026-10-19, before the held-out set was scored. **Tested once, no re-tuning on the test set.**

## What is frozen

One logistic regression replaces the hand-tuned AND of thresholds in `assessMeaning`:

```text
z_j   = (x_j − mean_j) / std_j            (training means and stds below)
score = sigmoid(Σ weight_j · z_j + bias)   (probability the meaning was kept)
pass  = score ≥ threshold
```

FULL is used when the NLI model scored the version; LITE (no NLI feature) in Lite quality mode or when NLI is unavailable. A missing non-NLI feature is scored at its training mean (z = 0).

### FULL

| Feature | NLI | Mean | Std | Weight |
|---|---|---|---|---|
| `sbert` | no | 0.861433 | 0.065517 | 0.075837 |
| `entity` | no | 0.826978 | 0.266737 | 0.057485 |
| `nliMin` | yes | 0.377698 | 0.423375 | 0.099032 |
| `contra` | yes | 0.210091 | 0.341966 | -0.107555 |
| `lenRatio` | no | 0.693974 | 0.173897 | 0.095553 |
| (bias) | | | | 0.00375 |

Threshold **0.569168**, λ = 1. Chosen on the out-of-fold probabilities as the cut with catch ≥ 90% and the lowest false-fail.

### LITE

| Feature | NLI | Mean | Std | Weight |
|---|---|---|---|---|
| `sbert` | no | 0.861433 | 0.065517 | 0.080126 |
| `entity` | no | 0.826978 | 0.266737 | 0.057627 |
| `lenRatio` | no | 0.693974 | 0.173897 | 0.091799 |
| (bias) | | | | 0.001869 |

Threshold **0.536117**, λ = 1. Chosen on the out-of-fold probabilities as the cut with catch ≥ 90% and the lowest false-fail.

`mainClaim` was not selected, so the app does not compute it: the score adds no NLI pairs to a paragraph, only the logistic regression (microseconds).

## Why these features (backward elimination on the 81 items)

Out-of-fold balanced accuracy at p = 0.5 after each step (5-fold, λ by inner CV). The pick is the smallest subset of ≤ 6 features within 1 point of the best subset of ≤ 6.

**FULL**

| Features | Dropped | OOF balanced accuracy |
|---|---|---|
| sbert, entity, nliMin, nliMean, contra, mainClaim, numbers, lenRatio | — | 62.8% |
| sbert, entity, nliMin, contra, mainClaim, numbers, lenRatio | nliMean | 66.4% |
| sbert, entity, nliMin, contra, numbers, lenRatio | mainClaim | 66.7% |
| sbert, entity, nliMin, contra, lenRatio | numbers | 70.2% ← chosen |
| sbert, nliMin, contra, lenRatio | entity | 65.3% |
| sbert, nliMin, contra | lenRatio | 64.1% |
| sbert, contra | nliMin | 69.0% |
| sbert | contra | 62.7% |

**LITE**

| Features | Dropped | OOF balanced accuracy |
|---|---|---|
| sbert, entity, numbers, lenRatio | — | 66.7% |
| sbert, entity, lenRatio | numbers | 69.1% ← chosen |
| sbert, lenRatio | entity | 66.7% |
| sbert | lenRatio | 62.7% |

The outer folds of the nested CV chose different subsets (FULL: sbert+contra; sbert+contra+mainClaim; sbert+nliMin+nliMean+contra+mainClaim+numbers; sbert+contra; sbert+nliMean+contra+lenRatio), so the selection is unstable at this sample size.

## Candidate features

| Feature | Definition | Needs NLI |
|---|---|---|
| `sbert` | all-minilm cosine of original and plain simplified text | no |
| `entity` | share of the original's entities kept (value-based numbers and dates) | no |
| `nliMin` | lowest entailment over the non-exempt simplified sentences (SummaC premises, top-3, glossary exemptions) | yes |
| `nliMean` | mean entailment over the same sentences | yes |
| `contra` | highest contradiction over all simplified sentences | yes |
| `mainClaim` | entailment of the original's main-claim sentence by the simplified text (reverse direction) | yes |
| `numbers` | share of the main claim's numbers, dates and time zones kept (1 if none) | no |
| `lenRatio` | simplified words / original words | no |

## Method (calibration set only)

- Data: the 81 calibration items (42 faithful / 39 unfaithful; real outputs that are near copies excluded), 62 paragraphs.
- 5-fold CV, stratified and grouped by paragraph (a real output and its injected copy share a fold), seed 42.
- Logistic regression minimising (1/Σc)·Σ c_i·logloss_i + (λ/2)·‖w‖² (Newton's method; the intercept is not penalised), λ from {0.01, 0.1, 1} by inner CV (ties → larger λ), balanced class weights c = n / (2·n_class), features standardised with the training fold's mean and std. With λ = 1 on the mean loss the weights are strongly shrunk, so scores stay near 0.5; only their order and the threshold matter.
- Feature selection: backward elimination by out-of-fold balanced accuracy at p = 0.5, down to ≤ 6 features, preferring fewer when within 1 point.
- Threshold: catch (recall on unfaithful) ≥ 90% with the lowest false-fail; if unreachable, maximum balanced accuracy.
- CV estimates are **nested**: selection, λ and threshold are re-chosen inside every outer fold. 95% CIs: cluster bootstrap over paragraphs, 2000 resamples, seed 42.

## Cross-validated results (nested, 81 calibration items)

| Model | Balanced accuracy | Catch | False-fail | AUC |
|---|---|---|---|---|
| FULL (sbert, entity, nliMin, contra, lenRatio) | 55.7% [49.0%–62.5%] | 92.3% [83.3%–100.0%] (36/39) | 81.0% [68.2%–92.1%] (34/42) | 0.693 [0.593–0.790] |
| LITE (sbert, entity, lenRatio) | 54.3% [46.3%–62.1%] | 87.2% [73.1%–97.5%] (34/39) | 78.6% [65.6%–90.0%] (33/42) | 0.661 [0.531–0.780] |
| Current rule (SBERT ≥ 0.87 AND entities AND NLI rule A) | 59.4% [52.9%–65.9%] | 97.4% [91.2%–100.0%] (38/39) | 78.6% [65.9%–90.2%] (33/42) | 0.594 [0.529–0.659] (0/1 verdict) |

Per outer fold (false-fail / catch):

| Fold | n | Current rule | FULL | LITE |
|---|---|---|---|---|
| 1 | 17 | 88.9% / 100.0% | 100.0% / 100.0% | 88.9% / 100.0% |
| 2 | 16 | 66.7% / 85.7% | 100.0% / 100.0% | 100.0% / 100.0% |
| 3 | 16 | 100.0% / 100.0% | 87.5% / 100.0% | 75.0% / 87.5% |
| 4 | 16 | 50.0% / 100.0% | 37.5% / 62.5% | 25.0% / 50.0% |
| 5 | 16 | 87.5% / 100.0% | 75.0% / 100.0% | 100.0% / 100.0% |

For reference only (optimistic: the threshold was chosen on these same out-of-fold probabilities): FULL BAcc 64.0%, catch 92.3%, false-fail 64.3%; LITE BAcc 56.9%, catch 92.3%, false-fail 78.6%.

**Reading.** On the calibration set the combined score is not better than the current rule in nested-CV balanced accuracy (FULL 55.7% vs 59.4%; the intervals overlap). Its AUC (0.693) shows some ranking signal, but at catch ≥ 90% most faithful outputs still fail: no tested feature separates faithful from unfaithful paragraphs well at this sample size. The held-out test below is therefore expected to miss the false-fail target; it is run anyway, once, as pre-registered.

## Held-out test plan (fixed now)

- Test set: the blind-labelled outputs of the base-model bake-off (3 models × 40 paragraphs, GPU outputs, near copies excluded: expected 119 items, about 85 faithful / 34 unfaithful). Never used for fitting, selection or the threshold.
- Features are extracted by the same script and app code as the calibration set; FULL is scored with the frozen values above.
- **Targets:** catch ≥ 90% AND false-fail ≤ 30%. **Headline metric:** balanced accuracy with a 95% CI (cluster bootstrap over paragraphs, 2000 resamples, seed 42).
- Also reported: confusion matrix, AUC, a per-model breakdown, LITE on the same items, the current rule vs the score on the same items (exact McNemar on correct/incorrect), and the extra NLI latency per paragraph.
- **Tested once, no re-tuning on the test set.** If the targets are missed, that is the result.

## Frozen values (machine-readable; config.ts must match)

```json
{
  "full": {
    "id": "full",
    "features": [
      "sbert",
      "entity",
      "nliMin",
      "contra",
      "lenRatio"
    ],
    "means": [
      0.861433,
      0.826978,
      0.377698,
      0.210091,
      0.693974
    ],
    "stds": [
      0.065517,
      0.266737,
      0.423375,
      0.341966,
      0.173897
    ],
    "weights": [
      0.075837,
      0.057485,
      0.099032,
      -0.107555,
      0.095553
    ],
    "bias": 0.00375,
    "threshold": 0.569168
  },
  "lite": {
    "id": "lite",
    "features": [
      "sbert",
      "entity",
      "lenRatio"
    ],
    "means": [
      0.861433,
      0.826978,
      0.693974
    ],
    "stds": [
      0.065517,
      0.266737,
      0.173897
    ],
    "weights": [
      0.080126,
      0.057627,
      0.091799
    ],
    "bias": 0.001869,
    "threshold": 0.536117
  }
}
```
