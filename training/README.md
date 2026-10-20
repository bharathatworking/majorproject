# Training `clarity-simplify` (Prompt 10)

A LoRA fine-tune of **Qwen3-4B-Instruct-2507** (the Prompt 9.4 bake-off winner) that should keep meaning **and** land at the requested reading grade. The bake-off showed every base model over-simplifies: asked for grade 8, outputs land near FKGL 6, and qwen3 hit the target only 17.5% of the time. The fix here is **grade conditioning**: every training prompt asks for exactly the grade that its reference really has.

Nothing in `src/` changes in Prompt 10. Using the model in the app is Prompt 11.

```
training/
  README.md             this file
  DATA_LICENSES.md      licences and attribution (Wiki-Auto / Wikipedia, ASSET, TurkCorpus, Qwen3)
  requirements.txt      pinned packages for the local Python 3.11 venv
  prepare/download.py   Wiki-Auto + ASSET + TurkCorpus as parquet → training/data/
  prepare/dedupe.py     removes training pairs that overlap any evaluation or reserved text
  colab/train_clarity_lora.ipynb   the Colab notebook (free T4)
  colab/check_notebook.py          validates the notebook without a GPU
  Modelfile.template    Ollama Modelfile (chat template copied from the base model)
  evaluate.py           Part C scoring: SARI, BERTScore, bootstrap CIs, REPORT.md
  eval/PREREG.md        the pre-registered evaluation (committed before any run)
  eval/items.json       the pre-registered evaluation items (ASSET validation row numbers)
  data/STATS.md         statistics of the training data (committed); the rest of data/ is git-ignored
scripts/train-data/     build-sft.mjs (npm run train:data), lib.ts, render.ts (the app's exact prompt)
scripts/train-eval/     generate.mjs (npm run train:eval:gen), lib.ts
```

All commands below are **Windows PowerShell**, run from the repository folder (`majorproject`).

---

## Step 1: one-time setup on your PC

1. Install Python 3.11 (once): `winget install --id Python.Python.3.11 -e --scope user`
2. Create the venv and install the pinned packages (a few minutes; PyTorch is large):
   ```powershell
   py -3.11 -m venv training/.venv
   training/.venv/Scripts/python.exe -m pip install -r training/requirements.txt
   ```
3. Node packages as usual: `npm install`.
4. Ollama must be running, with `all-minilm` pulled (`ollama pull all-minilm`). The data builder uses it for the main-claim rule, and the evaluation for the near-copy rule.

## Step 2: build the training data (Part A)

```powershell
training/.venv/Scripts/python.exe -I training/prepare/download.py      # ~1.1 GB of parquet, ~10 min
training/.venv/Scripts/python.exe -I training/prepare/dedupe.py --self-test
training/.venv/Scripts/python.exe -I training/prepare/dedupe.py        # ~3 min
npm run train:data                                                     # 15,000 train + 500 dev
```

What happens:

- **download.py** reads the Hugging Face parquet copies (no remote loader scripts). From Wiki-Auto `auto` it takes the full English / Simple English article pairs with their sentence alignment. One training pair is one aligned group: an English sentence and the Simple sentences aligned to it, in article order. It also downloads ASSET validation (the evaluation set, with its 10 references) and the originals of ASSET test and TurkCorpus validation and test. Those three are **reserved for the final benchmark** and are only used to remove overlapping training pairs.
- **dedupe.py** drops every pair whose English side matches any of these exactly (after lowercasing and removing punctuation) or shares at least half of its 8-word sequences with one, in either direction:
  - ASSET or TurkCorpus,
  - the calibration set (`eval/nli-calibration/`),
  - the bake-off paragraphs (`eval/model-bakeoff/`),
  - the dev fixtures (`eval/fixtures/`),
  - any future `eval/benchmark*` folder.
- **build-sft.mjs** uses the **app's own code** for FKGL, entities and the prompt:
  - **Pseudo-paragraphs:** about 60% of the examples join 2–5 consecutive aligned pairs of one English paragraph; the rest are single sentences.
  - **Filters:**
    - the source has fewer than 8 words,
    - the simple/source word ratio is outside 0.4–1.3,
    - the simple side is not at least 0.5 FKGL easier,
    - the simple side adds a name, number or date,
    - it loses a number or date from the source's main sentence,
    - the app's prompt would say "do NOT simplify".
  - **Keep slice:** up to 5% are "keep" examples, where Simple Wikipedia left the sentence unchanged and the target is the source.
  - **Target grade:** `g = clamp(round(FKGL(simple)), 3, 12)`. The prompt is the app's real `buildPrompt` output for the default profile at grade `g`, so training prompts are identical to what the app sends.
  - **Hints:** the "hard words" hint is truthful. A hint word is kept only when the reference really replaced it.
  - **Grade balance:** the grades are balanced so 3–12 are about even.
  - **Split:** train and dev never share a Wikipedia article.
- Check `training/data/STATS.md`. It has the removals per source, the counts after each filter, the grade histogram, the lengths, the hint share and the SHA-256 of both files.

## Step 3: train on Google Colab (Part B)

1. In Google Drive, create the folder **`MyDrive/clarity/data/`** and upload:
   - `training/data/sft_train.jsonl`
   - `training/data/sft_dev.jsonl`
2. Open https://colab.research.google.com, then **File → Upload notebook**, and choose `training/colab/train_clarity_lora.ipynb`.
3. **Runtime → Change runtime type → T4 GPU → Save.**
4. **Runtime → Run all.** Allow Google Drive access when asked.
   - Cell 1 installs pinned versions (Unsloth 2026.10.3, transformers 4.57.6, TRL 0.22.2) and prints them.
   - Section 4 checks that the training text is token-for-token what Ollama will send. It stops if not.
   - Section 5 checks that the loss is only on the answer.
   - Training takes roughly 2–3 hours on a T4 (about 940 steps). Dev loss is printed every 100 steps.
5. **If Colab disconnects** (the free tier does), reconnect, set the T4 again and **Run all** again. Training resumes from the last checkpoint in `MyDrive/clarity/out/checkpoints/` (saved every 100 steps).
6. At the end:
   - Section 7 prints 5 dev examples (source, target, output). Read them: they should be fluent simplifications near the asked grade.
   - Section 9 writes **`MyDrive/clarity/out/clarity-simplify-q4_k_m.gguf`** (about 2.5 GB) and prints its SHA-256.
   - Section 11 writes `run_record.json`. `log_history.json` (the loss curve) is saved after training.

**If section 9 runs out of memory:** set `RUN_FALLBACK = True` in section 10 and run it. It saves the merged 16-bit model (about 8 GB) to `MyDrive/clarity/out/merged_16bit/`. Download that folder and convert it on your PC with llama.cpp:

```powershell
git clone https://github.com/ggml-org/llama.cpp training/out/llama.cpp
training/.venv/Scripts/python.exe -m pip install -r training/out/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt
training/.venv/Scripts/python.exe training/out/llama.cpp/convert_hf_to_gguf.py training/out/merged_16bit --outtype f16 --outfile training/out/clarity-simplify-f16.gguf
# llama-quantize comes with the llama.cpp release zip for Windows (github.com/ggml-org/llama.cpp/releases)
llama-quantize training/out/clarity-simplify-f16.gguf training/out/clarity-simplify-q4_k_m.gguf Q4_K_M
```

## Step 4: put the model into Ollama

1. Download `clarity-simplify-q4_k_m.gguf` from Drive into **`training/out/`** (git-ignored).
2. Copy the Modelfile next to it and create the model:
   ```powershell
   Copy-Item training/Modelfile.template training/out/Modelfile
   cd training/out
   ollama create clarity-simplify -f Modelfile
   cd ../..
   ollama list            # clarity-simplify should be listed
   ```
   The Modelfile's chat template, stop tokens and sampling defaults are copied verbatim from `qwen3:4b-instruct-2507-q4_K_M`. The temperature line is left out (Prompt 11 sets it).
3. Quick check: `ollama run clarity-simplify "Rewrite at grade 6: Photosynthesis is the process by which green plants convert light energy into chemical energy."`

## Step 5: evaluation (Part C)

`training/eval/PREREG.md` fixes the whole analysis before any output exists. It covers the items in `training/eval/items.json`, the metrics and the decision rule:

- grade hit up by at least 15 points,
- SARI down by at most 1.0,
- entities kept down by at most 2 points,
- near copies at most 5%.

Then:

```powershell
npm run train:eval:gen        # base + clarity-simplify, 800 prompts each, temperature 0 (~1 h on a GPU; resumable)
training/.venv/Scripts/python.exe -I training/evaluate.py   # SARI, BERTScore (downloads roberta-large once), CIs, REPORT.md
```

`node scripts/train-eval/generate.mjs --dry-run` renders every prompt without calling Ollama.

`training/eval/REPORT.md` gives:
- the verdict, reported as it comes out even when it fails,
- per-target tables with 95% bootstrap intervals,
- 10 random side-by-side examples,
- the limitations.

## Known limitations of the training data

- Wiki-Auto alignments are automatic, so some simple sides still change a name or a detail the filters did not catch.
- The clamp puts very easy references in grade 3 and very hard ones in grade 12. STATS.md counts the examples more than one grade from their `g`.
- For the 'aggressive' tier, the app's prompt says "below grade g, as simple as possible" while the reference sits at about grade g. The training data teaches the model that this wording means about g. Prompt 11 may want to revisit the wording.
- The prompt's "current reading level" is each example's own estimate; in the app it is the whole document's.
