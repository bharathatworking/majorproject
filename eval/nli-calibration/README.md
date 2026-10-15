# NLI calibration set

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
