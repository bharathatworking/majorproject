# Base-model bake-off (Prompt 9.4)

This picks the base model for the Prompt 10 LoRA fine-tune. Three Ollama models are compared on 40 new paragraphs, and their meaning preservation is labelled blind by a person:

- `qwen2.5:3b`, the app's current default
- `qwen3:4b-instruct-2507-q4_K_M`
- `gemma4:e2b-it-qat`

This is an evaluation only. Nothing in `src/` changes, and the app's default model stays `qwen2.5:3b`.

> The paragraphs are **bakeoff-only** (see [SOURCES.md](SOURCES.md)). Never reuse them in the benchmark, the calibration or a training set.

```powershell
npm run bakeoff:check      # validate paragraphs.jsonl (rules + no overlap with eval/nli-calibration)
npm run bakeoff:run        # generate (resumable): 3 models × 40 on GPU, × 10 CPU-only; then the flag pass
npm run bakeoff:export     # labels_bakeoff.csv (120 blind rows) + blind_key.json
npm run bakeoff:unblind    # after labelling: REPORT.md
```

`run.mjs` also takes these options:

- `--model <tag>`: one model only
- `--gpu-only` or `--cpu-only`: one mode only
- `--limit N`: only the first N paragraphs of each mode, for a smoke run
- `--flags-only`: just the flag pass

It needs Ollama on `localhost:11434` with the three exact tags pulled (a missing tag stops the run, and no other model is substituted), and `all-minilm` for the near-copy similarity.

## How the outputs are made

- **The app's exact prompt.** `scripts/bakeoff/app.mjs` loads the app's own modules through Vite: `detectEntities`, `computeReadabilityReport`, `resolveProfile`, `findDifficultWords` and `buildPrompt` (`standard`, no rolling context). Each paragraph is one `paragraph` node, with its `- ` list lines kept, as in the NLI calibration.
- **Profile.** The Student preset: teen, `targetGradeLevel: 'auto'` (which resolves to grade 8), bullet-summary.
- **Sampling, as in the app.** The app sends no temperature, so each model runs at its Modelfile default:

  | Model | Temperature | Other defaults |
  |---|---|---|
  | `qwen2.5:3b` | Ollama's built-in default | none set in the Modelfile |
  | `qwen3:4b-instruct-2507-q4_K_M` | 0.7 | top_p 0.8 |
  | `gemma4:e2b-it-qat` | 1.0 | top_p 0.95 |

  Only `options.seed = 42` is added.
- **Thinking.** `think: false` is sent to models whose `/api/show` capabilities include `thinking` (the qwen3 and gemma4 tags). Any `<think>…</think>` block is stripped, and each output records `hadThink`.
- **One attempt per pair.** There is no meaning retry, no best-of-N and no meaning check in the loop.
- **Timing.** All loaded models are unloaded before each model and mode (`keep_alive: 0`). Then one untimed warm-up call is made, and `/api/ps` gives the loaded size and VRAM. The time is wall-clock seconds per 100 input words:
  - GPU: all 40 paragraphs.
  - CPU-only: `num_gpu: 0`, on the 10 `cpuSubset` paragraphs. This simulates a PC with no GPU; RAM is not limited.

## `outputs.jsonl`

One record per model × paragraph × mode. Each record holds:

- **Identity:** `model`, `mode` (`gpu`/`cpu`), `paragraphId`, `promptHash` (sha256 of system + user prompt; the resume key)
- **Prompt settings:** `preset`, `targetGrade`, `depthTier`
- **Generation settings:** `options`, `think`, `defaultTemperature`
- **Output text:** `raw`, `thinking`, `cleaned`, `hadThink`
- **Timing:** `wallSeconds`, `totalSeconds`, `loadSeconds`, `promptTokens`, `outputTokens`, `evalSeconds`, `secPer100`
- **Size:** `memory` (`/api/ps` `size` and `sizeVram`) and `diskSize`
- **Measurements:**
  - words: `inputWords`, `outputWords`, `lengthRatio`
  - readability: `fkglBefore`/`fkglAfter` and `gradeBefore`/`gradeAfter`, both on plain text
  - change: `editRatio` and `similarity` (all-minilm)
  - lists: `originalListItems` and `outputListItems`
- **`flags`:**
  - `empty`
  - `refusal`
  - `nonEnglish`
  - `listLost`: the original's list became prose, or lost items
  - `nearCopy`: edit ratio < 10% or similarity > 0.97, the calibration rule
  - `lengthOutOfRange`: length ratio < 0.4 or > 1.6
- **Provenance:** `ollamaVersion`, `digest`, `createdAt`

## Labelling (blind)

`labels_bakeoff.csv` has 120 rows (`blind_id, original, simplified, my_label, note`), shuffled with a fixed seed. The `blind_id`s (B001…) are assigned after the shuffle, and no row names or hints at a model. The mapping is only in `blind_key.json`; don't open it before you finish.

In `my_label`, write `faithful` or `unfaithful` (`f` / `u` also work). Use the calibration standard: an output is **unfaithful** when it states a wrong fact, adds a claim, or drops a **key** fact. Numbers and dates in the main claim must stay. `unsure` (or `?`) leaves the row out of the analysis.

## Pre-registered analysis (`unblind.mjs`, written before labelling)

The report gives these figures per model:

- meaning kept % with a Wilson 95% CI, over outputs that are not near copies (the near-copy count is shown separately)
- mean FKGL drop
- target-grade hit (FKGL within ±1 of the target)
- flag counts
- GPU and CPU s/100 words (median and p90)
- size
- licence

It then runs an exact McNemar test for each pair of models. The winner rule is:

1. **Eligible:** mean FKGL drop ≥ 2 and near copies ≤ 10% of outputs.
2. **Best:** among the eligible models, the highest meaning kept % wins.
3. **Tie-break:** if the top two are within 3 percentage points, the faster CPU-only model wins.
4. **Fine-tunability:** the winner must be fine-tunable with Unsloth on a Colab T4 (evidence links go in `models.json`); otherwise the rule is applied again without it.
