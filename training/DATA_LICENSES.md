# Data and model licences (Prompt 10)

Everything here is used for a university major project. The files themselves (`training/data/`, the GGUF and the adapter) are git-ignored and not redistributed by this repository; the exact revisions are pinned in `training/data/SOURCES.json` when `download.py` runs.

## Training data

### Wiki-Auto (English Wikipedia → Simple English Wikipedia)

- **Source:** Hugging Face `chaojiang06/wiki_auto`, config `auto`, read as parquet from the Hub's `refs/convert/parquet` branch (no loader script runs).
- **Licence:** the alignments are not licensed separately; the sentences are Wikipedia and Simple English Wikipedia text under **CC BY-SA 3.0** (current Wikipedia text is CC BY-SA 4.0).
- **Attribution:** the text was written by Wikipedia contributors; see each article's history on en.wikipedia.org and simple.wikipedia.org (the article ids are kept in every training example's `meta.article_id` / `meta.source_id`).
- **Citation:** Chao Jiang, Mounica Maddela, Wuwei Lan, Yang Zhong and Wei Xu. 2020. *Neural CRF Model for Sentence Alignment in Text Simplification.* Proceedings of ACL 2020, pages 7943–7960.
- **Share-alike:** the SFT files (`sft_train.jsonl`, `sft_dev.jsonl`) are adaptations of CC BY-SA text, so if they are ever shared they must be shared under CC BY-SA with this attribution. Whether model weights trained on CC BY-SA text are themselves an adaptation is legally unsettled; the fine-tuned model is not distributed by this project.

## Evaluation data (never trained on)

### ASSET

- **Source:** Hugging Face `facebook/asset`, config `simplification` (parquet).
- **Licence:** the dataset card's text says **CC BY-NC 4.0**; its metadata tag says CC BY-SA 4.0. We follow the stricter one: non-commercial, evaluation only.
- **Use:** the validation split (2,000 sentences × 10 references) is the Part C evaluation set. The **test split (359 sentences) is reserved for the final benchmark**: it is stored without references and used only to remove overlapping training pairs.
- **Committed text:** `eval/grade-targeting/items.jsonl` (Prompt 11) includes the original sentences of 407 ASSET **validation** rows (no references, none of the test split), so the frozen evaluation set works on its own. The text is redistributed under CC BY-NC 4.0 with the citation below, for **non-commercial academic use only**. Everything else from ASSET stays in the git-ignored `training/data/`.
- **Citation:** Fernando Alva-Manchego, Louis Martin, Antoine Bordes, Carolina Scarton, Benoît Sagot and Lucia Specia. 2020. *ASSET: A Dataset for Tuning and Evaluation of Sentence Simplification Models with Multiple Rewriting Transformations.* Proceedings of ACL 2020, pages 4668–4679.

### TurkCorpus

- **Source:** Hugging Face `community-datasets/turk`, config `simplification` (parquet).
- **Licence:** **GPL-3.0** (the original TurkCorpus release).
- **Use:** validation and test originals only, to remove overlapping training pairs. **Both splits are reserved for the final benchmark**; nothing is generated on them in Prompt 10.
- **Citation:** Wei Xu, Courtney Napoles, Ellie Pavlick, Quanze Chen and Chris Callison-Burch. 2016. *Optimizing Statistical Machine Translation for Text Simplification.* TACL 4, pages 401–415.

### Project evaluation sets (excluded from training)

The calibration set (`eval/nli-calibration/`), the bake-off paragraphs (`eval/model-bakeoff/`) and the dev fixtures (`eval/fixtures/`) are Wikipedia (CC BY-SA 4.0) and U.S. government (public domain) texts; their sources are listed in each folder's `SOURCES.md` or `README.md`. `dedupe.py` removes every Wiki-Auto pair that overlaps them.

## Models

- **Base model:** Qwen3-4B-Instruct-2507 (Alibaba Cloud, Qwen team), **Apache License 2.0**. The 4-bit training copy is `unsloth/Qwen3-4B-Instruct-2507`; the Ollama comparison model is `qwen3:4b-instruct-2507-q4_K_M`.
- **Fine-tuned model `clarity-simplify`:** a LoRA adapter on the Apache-2.0 base. It keeps the base model's Apache 2.0 licence text in its Modelfile (`LICENSE`, copied verbatim from the base model), subject to the CC BY-SA caveat above.
- **Tools:** Unsloth (Apache 2.0), Hugging Face Transformers / TRL / PEFT (Apache 2.0), llama.cpp (MIT), Ollama (MIT).
- **Evaluation models:** `roberta-large` for BERTScore (MIT); `all-minilm` via Ollama (Apache 2.0) for the near-copy similarity and the main-claim rule.
