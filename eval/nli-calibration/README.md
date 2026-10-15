# NLI calibration set

There are two levels:

- **Paragraph level** (`paragraph-items.jsonl`, `npm run calibrate-meaning`): chooses every meaning threshold: `SIM_MIN`, `ENTAILMENT_MIN` and the NLI paragraph rule. It is described first, below.
- **Sentence level** (`pairs.jsonl`, `npm run calibrate-nli`): the original set, which chose the premise strategy and `NLI_CONTRADICTION_AGG`. It is described after the paragraph-level section.

## Paragraph level: `npm run calibrate-meaning`

```powershell
npm run fetch-models                                  # the NLI model, once
ollama pull all-minilm                                # similarity is part of the rule
npm run calibrate-meaning                             # proposed labels where not reviewed
npm run calibrate-meaning -- --reviewed-only          # only items with "reviewed": true
npm run calibrate-meaning -- --verbose                # every item's scores
npm run calibrate-meaning -- --entity-recall          # also sweep a minimum entity recall (alternative rule, report only)
npm run calibrate-meaning -- --json scores.json       # write every item's scores
```

### Items

`paragraph-items.jsonl` has 40 items, one simplified paragraph each, judged against its original in `paragraphs.jsonl`:

- **20 real outputs.** One verbatim `qwen2.5:3b` simplification of each of the 20 originals. The first 15 come from the sentence-level set; 5 were added on 2026-10-15. All were made with the app's own `buildPrompt` (default adult profile, target grade 6, one attempt, no meaning retry); the 5 new ones were made with `node scripts/make-paragraph-items.mjs`, which also stores each original's glossary `hintedWords`.
- **20 copies with one injected error each,** 4 per type: `number` (a changed number or date), `negation`, `name` (a swapped name), `dropped-fact` (a key fact removed), `added-claim` (a claim the original doesn't make). Each copy is its real output with exactly one edit, shown in `note`. When the real output is itself unfaithful, the note says "base already unfaithful".
- **Dev and test halves,** by paragraph (a real output and its copy are always in the same half), 10 paragraphs each, with 2 errors of each type per half. **Thresholds are chosen on dev only;** test is only reported.

| Field | Meaning |
|---|---|
| `id` | `<paragraphId>#real` or `<paragraphId>#<errorType>` |
| `paragraphId` | The original in `paragraphs.jsonl` |
| `split` | `dev` or `test` |
| `origin` | `qwen2.5:3b` (verbatim) or `injected` |
| `injectedFrom` | For copies, the real item it was made from |
| `simplified` | The simplified paragraph (the model's raw output, bullets included) |
| `proposedLabel` | `faithful` or `unfaithful`, proposed by Claude, **not reviewed** |
| `label` | Optional: your label; it overrides `proposedLabel` |
| `errorType` | For copies, the injected error; `null` for real outputs |
| `reviewed` | `false` until you have checked the label |
| `note` | Why: `BORDERLINE` marks items worth a second look, `NATURAL` a real model error |

### How to label

A paragraph is **faithful** when every statement in it is supported by the original and nothing important is changed. **Unfaithful** means it changes, contradicts or adds a fact, or drops one that matters. Decide how strict "drops one that matters" is. The entity check fails any output that drops a name, number or date of the original (for example "Professor Henri Becquerel" in `wiki-marie-curie#real`). If such drops are acceptable to you, label those outputs faithful and look at the `--entity-recall` rows. If they are not, label them unfaithful.

1. For each line, read the original (`paragraphs.jsonl`, same `paragraphId`) and the `simplified` text.
2. If the proposed label is right, set `"reviewed": true`.
3. If it is wrong, add `"label": "faithful"` or `"label": "unfaithful"`, then set `"reviewed": true`. Leave `proposedLabel` as it is.
4. Run `npm run calibrate-meaning -- --reviewed-only`.

### How an item is judged (the extension's rule)

An item **passes** at a setting when all of these hold:

- SBERT cosine (all-minilm, original vs the plain output) ≥ `SIM_MIN`.
- No entity of the original is missing (`detectEntities` + `findMissingEntities`, value-based for numbers and dates). With `--entity-recall`, the share kept must instead be ≥ the swept minimum.
- The NLI paragraph rule passes (`nliVerdict` over the sentence scores of the app's own `checkEntailment`):
  - Rule A: every non-exempt sentence has entailment ≥ `ENTAILMENT_MIN`.
  - Rule B: the same, except that one neutral sentence is tolerated when there are 6 or more.
  - Under both rules, no sentence may have contradiction above `CONTRADICTION_MAX` (0.2).

False-fail = failed faithful / faithful. Catch = failed unfaithful / unfaithful. Paired catch is the injected copies that fail while their real output passes, which is a cleaner view of whether the injected error itself was noticed.

The grid on dev covers `SIM_MIN` 0.60–0.95 (step 0.01) × `ENTAILMENT_MIN` 0.05–0.95 (step 0.05) × rule {A, B}. It keeps the settings with false-fail ≤ 10% and catch ≥ 90%. Ties are broken by, in order:

1. lowest false-fail;
2. highest catch;
3. rule A;
4. the strictest entity recall;
5. the setting nearest the centre of the remaining plateau.

The script then prints both rates on dev and on test, with Wilson 95% intervals.

### Provisional results, 2026-10-15 (proposed labels, not reviewed; NOT applied to config.ts)

The labels split as follows: dev has 6 faithful and 14 unfaithful items; test has 5 faithful and 15 unfaithful.

| Setting | Dev false-fail | Dev catch | Test false-fail | Test catch |
|---|---|---|---|---|
| Current config (SIM 0.87, ENT 0.50, rule A, every entity) | 66.7% (4/6) | 100% (14/14) | 80.0% (4/5) | 100% (15/15) |
| Best with every entity kept (SIM 0.60, ENT 0.70, A): **does not qualify** | 50.0% (3/6) | 100% | — | — |
| `--entity-recall` choice (SIM 0.66, ENT 0.80, rule B, recall ≥ 0.8) | 0.0% (0/6) [0–39%] | 92.9% (13/14) [69–99%] | 80.0% (4/5) [38–96%] | 93.3% (14/15) [70–99%] |

- **With every entity required,** no setting qualifies on dev. The 3 remaining dev false-fails are real omissions that the proposed labels call acceptable: `Cordillera Rumi Cruz`, `Professor Henri Becquerel`, and the reef's area and "billions".
- **The only qualifying dev setting doesn't hold on test.** It needs a relaxed entity rule, and still gets 4 of 5 test faithful items wrong. Those failures are NLI false contradictions or unsupported verdicts on short referring sentences ("Anatocism is the same.", "That's called inflation.", the antibiotic definition), plus a dropped full date ("28 June 1919" → "1919").
- **The sample is small:** 5–6 faithful items per half. The Wilson intervals are wide.
- **Nothing is frozen.** Next: review the labels, run with `--reviewed-only`, and decide two things: whether dropped details count as unfaithful, and whether to add faithful real outputs (a second sample per paragraph) before choosing.

This set calibrates `ENTAILMENT_MIN` (and checks `NLI_CONTRADICTION_AGG`) in `src/lib/quality/config.ts` **before** the thesis benchmark. After calibration the value is frozen; the benchmark must not tune it again.

```powershell
npm run fetch-models          # once: the NLI model the script loads from public/models/
npm run calibrate-nli         # all items, proposed labels
npm run calibrate-nli -- --reviewed-only   # only items with "reviewed": true
npm run calibrate-nli -- --verbose         # every item's scores
```

Ollama with `all-minilm` should be running so premises are ranked the way the extension ranks them; without it the script falls back to word overlap and says so.

## Files

- `paragraphs.jsonl`: 15 originals, one per line. There are 12 Wikipedia lead paragraphs (CC BY-SA 4.0, pinned revision) and 3 U.S. government instruction or list texts (public domain). `text` is the original. `simplification` is a real `qwen2.5:3b` output for it, made through local Ollama on 2026-10-15 with the app's own `buildPrompt` (adult profile, target grade 6, no rolling context, default sampling). The script uses it only for the speed and truncation numbers. Sources and licences are in [SOURCES.md](SOURCES.md).
- `pairs.jsonl`: 60 items, 4 per paragraph. Each item is one simplified sentence to judge against its paragraph:

  | Field | Meaning |
  |---|---|
  | `id` | Unique item id |
  | `paragraphId` | The `paragraphs.jsonl` id |
  | `hypothesis` | The simplified sentence |
  | `proposedLabel` | `faithful` (supported by the paragraph) or `wrong` (it changes or adds meaning). Proposed by Claude; **not yet reviewed** |
  | `label` | Optional. Your reviewed label; it overrides `proposedLabel` |
  | `errorType` | For `wrong` items: `number` (a changed number or date), `negation`, `name` (a swapped name) or `added-fact` (a claim the paragraph doesn't make, even if it is true in the world). `null` for faithful items |
  | `origin` | `qwen2.5:3b` (verbatim model output) or `edited` (a hand edit) |
  | `editedFrom` | For edited items, the item or sentence it was made from |
  | `reviewed` | `false` until a person has checked the label |
  | `note` | Why the label is what it is; `BORDERLINE` marks items worth a second look; `NATURAL` marks real model errors |

  The set has 30 faithful items (all verbatim `qwen2.5:3b` sentences) and 30 wrong ones: 7 `number`, 7 `name`, 8 `negation` and 8 `added-fact`. Two of the wrong items are real `qwen2.5:3b` errors (`photo-w1`, `diabetes-w2`); the other 28 are hand edits.

## How to review

For each line of `pairs.jsonl`:

1. Read the paragraph (`paragraphs.jsonl`, same `paragraphId`) and the `hypothesis`.
2. If the proposed label is right, set `"reviewed": true`.
3. If it is wrong, add `"label": "faithful"` or `"label": "wrong"` (and fix `errorType`), then set `"reviewed": true`. Don't edit `proposedLabel`, so the change stays visible.
4. Run `npm run calibrate-nli -- --reviewed-only`.

## How an item is scored

These are the extension's rules (`src/lib/quality/premises.ts`, `nli.ts`):

1. The premises are the paragraph's sentences plus every window of 2 adjacent sentences. They're ranked by all-minilm cosine to the hypothesis, and the top 3 are scored.
2. Entailment is the max over those 3.
3. Contradiction is the max (`'max'`) or the best-entailing premise's (`'best-entailing'`).
4. An item **fails** when entailment < t or contradiction > `CONTRADICTION_MAX` (0.2).
5. **False-fail rate** = failed faithful / faithful. **Catch rate** = failed wrong / wrong.
6. The target is the highest t in 0.30 to 0.70 with false-fail ≤ 10% and catch ≥ 90%.

The script also prints these rows for comparison:

- "all premises": no pruning.
- "before": the old strategy, with the whole paragraph as the only premise.
- Truncated pairs (over 512 tokens) before and after.
- A one-thread CPU timing proxy per simplified paragraph.

## Results, 2026-10-15 (proposed labels, not reviewed)

| Strategy | False-fail | Catch | Note |
|---|---|---|---|
| before (paragraph premise) | 63.3% | 100% | t = 0.50 |
| top 3, `'max'` | 30.0% | 96.7% | flat for t 0.30 to 0.70 |
| top 3, `'best-entailing'` | 13.3% | 96.7% | flat for t 0.30 to 0.70; the extension's setting |
| all premises, `'max'` | 50.0% | 96.7% | flat |

- **No threshold meets both targets.** `ENTAILMENT_MIN` stays 0.5 and is **not frozen**.
- The 4 faithful items that fail with `'best-entailing'` are `antibiotic-f2`, `photo-f2`, `compound-f1` and `compound-f2` (borderline).
- The 1 wrong item that passes is `amazon-w2`, a name swap to a river the paragraph also mentions.
- Truncated pairs: 0 of 60 before and 0 of 180 after.
- Timing proxy on Node, 1 thread, per simplified paragraph:

  | Backend | Before | After |
  |---|---|---|
  | onnxruntime-node (CPU) | 363 ms | 526 ms |
  | onnxruntime-web wasm | 1,017 ms | 1,527 ms |

  "After" scores 3× the pairs (291 vs 97), each shorter.
