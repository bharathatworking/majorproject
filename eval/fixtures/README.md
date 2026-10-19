# Dev regression fixtures

**Excluded from every benchmark.** Nothing in this folder may be used in the Ask Gemini benchmark test set, the NLI or checker calibration (`eval/nli-calibration/`, `eval/checker/`), the model bake-off (`eval/model-bakeoff/`), or any training or fitting set. These files are for development only: they reproduce bugs seen in real runs, and unit tests read them to keep those bugs fixed.

## Files

| File | What it is |
|---|---|
| `uk-wiki-paste.txt` | The 8 pasted paragraphs of the 2026-10-19 run: the opening and "Etymology and terminology" section of the English Wikipedia article "United Kingdom", including the citation markers (`[l]`, `[19]`, …), the "See also:" hatnote and the section heading. |
| `runs/uk-wiki-2026-10-19.json` | The run report exported from that document (`clarity-run-report/3`; qwen3:4b-instruct-2507-q4_K_M, target grade 8, Student preset; one Lite run, then Full runs with "Extra quality" on). |

### How `uk-wiki-paste.txt` was made

The text was **rebuilt from the run report**: it is each node's `originalText`, in node order, with one blank line between nodes. `originalText` has its whitespace collapsed, so the line breaks of the original clipboard text are lost. In particular, n5's "See also: …" hatnote runs straight into its paragraph with no line break, which is how it was segmented and is the harder case for clutter removal. If the exact clipboard text turns up, replace this file with it and re-run the tests.

### Bugs this fixture covers

- The entity list from the prompt was copied into the output ("- Roman, Roman, 43, 383, …").
- "Etymology and terminology" was simplified into two bullets instead of being kept as a heading.
- Citation markers and the "See also:" hatnote reached the model.
- Entity junk: "Second" (from "Second World War") was read as a number, "Over the 17th century" was read as a date, and "1600s" did not count as the 17th century.

## Licence

The text is from Wikipedia, "United Kingdom" (https://en.wikipedia.org/wiki/United_Kingdom), retrieved 2026-10-19. It is licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). The model outputs in the run report are derived from it under the same licence.
