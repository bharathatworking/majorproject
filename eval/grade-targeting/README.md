# Grade-targeting evaluation (Prompt 11)

This folder evaluates whether Clarity can hit the requested reading grade at inference time:
- **arm A:** the current pipeline;
- **arm B:** grade-aware prompt wording;
- **arm C:** wording plus a grade-feedback retry.

The hypotheses, definitions, criteria and decision rule are fixed in [PREREG.md](PREREG.md), which was committed before any implementation or generation.

**Never reuse these items** in training, calibration, the checker fit, prompt development or any tuning. Develop B and C on other texts.

## Files

| File | What it is |
|---|---|
| `PREREG.md` | The pre-registration. Changes go only in its Deviations section. |
| `items.jsonl` | The 200 frozen items. Line 1 is `{"header": …}` (source, seed, provenance counts); each other line is `{id, kind, rows, target, text, sha256, fkgl, estimatedGrade}`. SHA-256 of the file (LF): `e2bafeabdd9edbe5e75e321384689b64ba36f885778d28bbddda7d3a6b446577`. `.gitattributes` keeps it LF on Windows checkouts. |
| `runs/arm-<A\|B\|C>.jsonl` | One record per item and arm, written by `npm run grade:run` (created by the real runs). Each record has a `provenance` field: HEAD commit, dirty tree (and a hash of the uncommitted changes), Ollama version, model tag and digest, temperature, seed, think, quality mode, NLI model, items.jsonl sha256 and arm. |
| `runs/arm-<X>.superseded-<time>.jsonl` | An older run file that `--new-run` moved aside. It is never read by the report. |
| `runs/smoke/` | `--limit` smoke runs; git-ignored, never results. |
| `REPORT.md` | Written by `npm run grade:report`. |

## Items and provenance

The items are 120 sentences and 80 pseudo-paragraphs (3–5 consecutive rows joined with single spaces). Each target grade gets 30 sentences and 20 pseudo-paragraphs:

| Target | Sentences | Pseudo-paragraphs |
|---|---|---|
| 4 | 30 | 20 |
| 6 | 30 | 20 |
| 8 | 30 | 20 |
| 10 | 30 | 20 |

How the 2,000 rows of ASSET validation were narrowed down:

| Step | Rows |
|---|---|
| ASSET validation rows | 2,000 |
| − Prompt 10 evaluation rows (`training/eval/items.json`) | −685 |
| − 8-gram overlap ≥ 0.5 with a reserved set (5 Prompt 10 texts, 3 ASSET test, 3 TurkCorpus test; the TurkCorpus test hits are the same 3 rows) | −8 |
| **Pool** | **1,307** (24 of them under 8 words, sentence-ineligible) |
| Rows used by the 200 items | 407 |

The overlap check covered these reserved texts: ASSET test 359, TurkCorpus test 359, NLI calibration 221, bake-off 40, dev fixtures 43, Prompt 10 item texts 400, and UK Wikipedia fixture paragraphs 8.

**Excluded as already at or below the target** (`isAlreadySimple`, the app's estimated grade with the base word list), counted while each bucket was filled. Targets were filled in the order 10, 8, 6, 4.

| Target | Sentences | Paragraph windows |
|---|---|---|
| 10 | 13 | 2 |
| 8 | 11 | 0 |
| 6 | 5 | 0 |
| 4 | 2 | 0 |
| **Total** | **31** | **2** |

No paragraph window was rejected for overlap. TurkCorpus validation (`turk_val.jsonl`) was never read: it has the same 2,000 source sentences, and it is reserved.

## Commands

```powershell
npm run grade:run -- --select-items            # done once; refuses to overwrite (--force only to confirm a byte-identical redraw)
npm run grade:run -- --arm A --limit 5         # smoke test → runs/smoke/arm-A.jsonl
npm run grade:run -- --arm A                   # the pre-registered baseline run (resumable under the same provenance)
npm run grade:run -- --arm A --new-run         # start a fresh file; the existing one is moved aside, not deleted
npm run grade:run -- --arm C --limit 5         # arm C smoke test → runs/smoke/arm-C.jsonl
npm run grade:run -- --arm B                   # arm B: arm A's path on the grade-aware prompt
npm run grade:run -- --arm C                   # arm C: grade-aware prompt + grade retry (one shared retry, at most 2 calls)
npm run grade:report                           # → REPORT.md (-- --runs eval/grade-targeting/runs/smoke for a smoke report)
```

**Resume guard.** A rerun appends only if its provenance equals that of every record already in the file. Otherwise it exits non-zero and names each differing field with both values. Use `--new-run` to start over. A dirty working tree is allowed but printed as a warning, with the changed files; the harness outputs (`runs/`, `REPORT.md`) don't count. So, between resumes of one arm:
- don't commit;
- don't edit code;
- don't update Ollama or re-pull the model.

Commit the run file once the arm is complete. `REPORT.md` states each arm's commit and model tag. If an arm's file mixes provenances, the report flags it, leaves that arm out of every table and the verdict, and exits non-zero.

To run the arms you need:
- Ollama with `qwen3:4b-instruct-2507-q4_K_M` and `all-minilm`;
- `npm run fetch-models` (the NLI model);
- `training/data/asset_val.jsonl` (`training/prepare/download.py`), needed only for `--select-items`. The runs read only `items.jsonl`.

## Licence

The item texts are original sentences of **ASSET** validation, redistributed under **CC BY-NC 4.0**, for non-commercial academic use only. See [training/DATA_LICENSES.md](../../training/DATA_LICENSES.md).

> Fernando Alva-Manchego, Louis Martin, Antoine Bordes, Carolina Scarton, Benoît Sagot and Lucia Specia. 2020. *ASSET: A Dataset for Tuning and Evaluation of Sentence Simplification Models with Multiple Rewriting Transformations.* Proceedings of ACL 2020, pages 4668–4679. https://github.com/facebookresearch/asset
