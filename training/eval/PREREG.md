# Pre-registration: base vs `clarity-simplify` on ASSET validation (Prompt 10, Part C)

Committed on its own (`docs(training): pre-register LoRA evaluation`) **before** any evaluation output exists. Nothing below changes after that commit. If a number here turns out to be wrong in practice, the change is made in a new commit that says why, before the run, and REPORT.md reports both versions.

## Question

Does the LoRA fine-tune `clarity-simplify` land closer to the requested reading grade than its base model, without losing simplification quality or facts?

## Models

| Role | Ollama tag | Weights |
|---|---|---|
| Base | `qwen3:4b-instruct-2507-q4_K_M` | Qwen3-4B-Instruct-2507, Q4_K_M (Ollama library) |
| Fine-tuned | `clarity-simplify` | LoRA (r 16, α 16, 7 projection modules, 1 epoch) on `unsloth/Qwen3-4B-Instruct-2507` in 4-bit, merged and exported as GGUF Q4_K_M; `training/colab/train_clarity_lora.ipynb`, `training/Modelfile.template` |

Training data: `training/data/sft_train.jsonl` and `sft_dev.jsonl`, built by `npm run train:data` from commit `8978474`:

- sft_train SHA-256 `2f118cc0768a54e7933923f187d8ed2fbf85b5417bef2e1bde6a697aca521e52`
- sft_dev SHA-256 `82ae57eda415f4360fcf4edd4e30dc46ddb39507f58c1f25cf34e0c225c1b279`

The statistics are in `training/data/STATS.md`. No ASSET or TurkCorpus sentence, and no calibration, bake-off or fixture text, is in the training data (`training/prepare/dedupe.py`, re-checked by the builder).

## Items

`training/eval/items.json` (SHA-256 `ccd85806b11f8785cd3168348617418f6a25371d255bf7baeeaa2006c8d5df78` of the committed file, LF line endings), drawn once by `node scripts/train-eval/generate.mjs --select-items` with seed 42 and never re-drawn:

- **300 sentences** of ASSET validation (`facebook/asset`, config `simplification`, 2,000 sentences × 10 references).
- **100 pseudo-paragraphs** of 3–5 consecutive validation rows, sharing no row with the sentences or with each other.
- **Eligibility:** only items the app would send to the model at grade 8, meaning `isAlreadySimple(text, 8)` is false (the app's estimated grade with the base word list is above 8). Items that are already simple are skipped by the app and would make "copy the input" the right answer. The number excluded is recorded in items.json.
- **Targets:** each item is run at target grade **6** and at target grade **8**. That gives 800 prompts per model.
- **Reserved:** ASSET test and TurkCorpus validation and test are reserved for the final benchmark and are not used here.

## Generation

- **Prompt:** the app's exact prompt (`scripts/train-data/render.ts`, which is `buildPrompt` on the `simplify.ts` path). It uses the default profile (adult, plain, novice) with `targetGradeLevel` set to the target, the app's lexical hints, no rolling context, and the `standard` variant. Both models get byte-identical prompts (the prompt hash is recorded per output).
- **Sampling:** `temperature 0`, `seed 42`. `think` follows the app's rule (`thinkSetting` from `/api/show`).
- **Attempts:** one attempt per prompt. There is no meaning check, retry or best-of-N, and no output is edited. `<think>` blocks would be stripped and counted.
- **Hardware:** the author's PC with GPU. Every model is unloaded before each model starts, and one untimed warm-up call loads it.
- **One generation run.** It may only be resumed after a crash (outputs are appended and keyed by model, item and target). Outputs are never regenerated to improve a result.

## Measures (per output)

| Measure | Definition |
|---|---|
| Grade hit | \|FKGL(output) − target\| ≤ 1. FKGL is the app's `computeReadabilityReport(toPlainText(output)).fleschKincaidGradeLevel`. An empty output is a miss. |
| SARI | Hugging Face `evaluate` `sari` at Hub revision `1f05a19b3a4266ddaeb58fa506e1314d565f0c8e`, with the source and **all 10** ASSET references. For a pseudo-paragraph, reference k is the rows' k-th references joined with a space. Scored per item; the corpus score is the item mean. |
| Entities kept | Share of the source's distinct entity texts (the app's `detectEntities` on `cleanForModel(source)`) that the app's `findMissingEntities` finds in the plain output. Only items with at least one entity count; that set is the same for both models. |
| Near copy | The calibration rule (`isNearCopy`): word edit ratio < 10% or all-minilm cosine similarity > 0.97 between source and output. |
| BERTScore | F1 of output vs **source**, `roberta-large`, `rescale_with_baseline=True` (bert-score 0.3.13). Secondary. |
| Seconds per 100 words | Wall-clock time of the call × 100 / source words, GPU. Secondary. |

## Analysis

- For every measure: the mean per model, and the **difference fine-tuned − base** over the same (item, target) pairs.
- 95% interval: a paired bootstrap over pairs, 10,000 resamples, `numpy.random.default_rng(42)`, percentile interval.
- Reported **pooled** (both targets, 800 pairs), per target (6, 8) and per kind (sentences, pseudo-paragraphs).

## Decision rule (primary, pooled over both targets, point estimates)

`clarity-simplify` is called **better** only if **all four** hold:

1. **Grade hit** rises by **≥ 15 percentage points**.
2. **SARI** drops by **no more than 1.0** point.
3. **Entities kept** drops by **no more than 2 percentage points**.
4. The fine-tuned model's **near-copy rate is ≤ 5%**.

Otherwise the verdict is **not better**. The verdict, every table, the intervals and 10 random side-by-side examples (seed 42) go into `training/eval/REPORT.md` whatever they show. Per-target and per-kind results, BERTScore and speed are secondary and do not change the verdict.

## What will not be done

- No re-tuning of prompts, sampling or thresholds after seeing outputs.
- No re-training followed by a second test on these items. A new model needs a new pre-registration and new items.
- No item is dropped after generation.
