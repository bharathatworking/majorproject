# Model bake-off paragraphs: sources and licences

> **Bakeoff-only.** These 40 paragraphs exist only to choose the base model for the Prompt 10 fine-tune (Prompt 9.4). Never reuse them, or other paragraphs from the same article revisions or page sections, in the Ask Gemini benchmark test set, in the NLI calibration set, or in a fine-tuning training set. Every record in `paragraphs.jsonl` has `"bakeoffOnly": true`.

All paragraphs were retrieved on 2026-10-16. None of them appears in `eval/nli-calibration/`. `npm run bakeoff:check` verifies this: the ids differ, no Wikipedia article or government page URL is shared, and no 8-word sequence is shared with any text in that folder.

## Rules the set meets (checked by `npm run bakeoff:check`)

- **40 paragraphs:** 24 Wikipedia and 16 U.S. government.
- **Content mix:** 10 bullet lists and 20 with numbers or dates. By domain: health 9, science 6, history 4, safety 9, tech 6, money 6.
- **Difficulty, measured with the app's own metrics on the plain text:** 40–220 words, FKGL ≥ 9, and not skipped by the "already simple" rule at the Student target grade (8).
- **CPU-only timing subset:** 10 paragraphs, marked ✓ below and with `cpuSubset: true` in the data. That is 6 Wikipedia and 4 government texts, 3 of them lists, from every domain.

## Wikipedia (24 paragraphs, CC BY-SA 4.0)

Text from Wikipedia is licensed under the [Creative Commons Attribution-ShareAlike 4.0 License](https://creativecommons.org/licenses/by-sa/4.0/). The authors are the contributors in each article's history at the given revision. Each paragraph is one lead-section paragraph (the number is its position in the lead) from the API's plain-text extract (`prop=extracts`, `exintro`, `explaintext`; `node scripts/bakeoff/fetch-wiki.mjs`).

`cleanWikiText` (`scripts/bakeoff/lib.ts`) applied these cleaning steps:

- removed citation marks such as `[1]`, `[a]` and `[citation needed]`
- removed parentheses that held IPA or pronunciation, or only leftover punctuation such as `( ; )`
- collapsed doubled spaces

Nothing else was changed. The model outputs derived from these paragraphs are shared under the same licence.

| id | Article | Revision | Lead ¶ | Domain | CPU |
|---|---|---|---|---|---|
| `bo-wiki-hypertension` | [Hypertension](https://en.wikipedia.org/w/index.php?title=Hypertension&oldid=1379458003) | 1379458003 | 4 | health | ✓ |
| `bo-wiki-cholera` | [Cholera](https://en.wikipedia.org/w/index.php?title=Cholera&oldid=1379078675) | 1379078675 | 5 | health | |
| `bo-wiki-tuberculosis` | [Tuberculosis](https://en.wikipedia.org/w/index.php?title=Tuberculosis&oldid=1379729728) | 1379729728 | 2 | health | |
| `bo-wiki-asthma` | [Asthma](https://en.wikipedia.org/w/index.php?title=Asthma&oldid=1378594635) | 1378594635 | 3 | health | |
| `bo-wiki-greenhouse-effect` | [Greenhouse effect](https://en.wikipedia.org/w/index.php?title=Greenhouse_effect&oldid=1368916930) | 1368916930 | 4 | science | |
| `bo-wiki-neuron` | [Neuron](https://en.wikipedia.org/w/index.php?title=Neuron&oldid=1378644558) | 1378644558 | 3 | science | |
| `bo-wiki-enzyme` | [Enzyme](https://en.wikipedia.org/w/index.php?title=Enzyme&oldid=1376216228) | 1376216228 | 3 | science | ✓ |
| `bo-wiki-ozone-layer` | [Ozone layer](https://en.wikipedia.org/w/index.php?title=Ozone_layer&oldid=1371936690) | 1371936690 | 2 | science | |
| `bo-wiki-black-death` | [Black Death](https://en.wikipedia.org/w/index.php?title=Black_Death&oldid=1377102371) | 1377102371 | 1 | history | ✓ |
| `bo-wiki-silk-road` | [Silk Road](https://en.wikipedia.org/w/index.php?title=Silk_Road&oldid=1379074984) | 1379074984 | 1 | history | |
| `bo-wiki-byzantine-empire` | [Byzantine Empire](https://en.wikipedia.org/w/index.php?title=Byzantine_Empire&oldid=1379045389) | 1379045389 | 4 | history | |
| `bo-wiki-ottoman-empire` | [Ottoman Empire](https://en.wikipedia.org/w/index.php?title=Ottoman_Empire&oldid=1380557792) | 1380557792 | 2 | history | |
| `bo-wiki-carbon-monoxide-poisoning` | [Carbon monoxide poisoning](https://en.wikipedia.org/w/index.php?title=Carbon_monoxide_poisoning&oldid=1379546797) | 1379546797 | 1 | safety | |
| `bo-wiki-avalanche` | [Avalanche](https://en.wikipedia.org/w/index.php?title=Avalanche&oldid=1378893702) | 1378893702 | 3 | safety | |
| `bo-wiki-seat-belt` | [Seat belt](https://en.wikipedia.org/w/index.php?title=Seat_belt&oldid=1377417586) | 1377417586 | 2 | safety | ✓ |
| `bo-wiki-drowning` | [Drowning](https://en.wikipedia.org/w/index.php?title=Drowning&oldid=1379870032) | 1379870032 | 5 | safety | |
| `bo-wiki-transistor` | [Transistor](https://en.wikipedia.org/w/index.php?title=Transistor&oldid=1379214217) | 1379214217 | 2 | tech | ✓ |
| `bo-wiki-lithium-ion-battery` | [Lithium-ion battery](https://en.wikipedia.org/w/index.php?title=Lithium-ion_battery&oldid=1380093173) | 1380093173 | 3 | tech | |
| `bo-wiki-public-key-cryptography` | [Public-key cryptography](https://en.wikipedia.org/w/index.php?title=Public-key_cryptography&oldid=1379508921) | 1379508921 | 1 | tech | |
| `bo-wiki-gps` | [Global Positioning System](https://en.wikipedia.org/w/index.php?title=Global_Positioning_System&oldid=1379259603) | 1379259603 | 1 | tech | |
| `bo-wiki-hyperinflation` | [Hyperinflation](https://en.wikipedia.org/w/index.php?title=Hyperinflation&oldid=1378341019) | 1378341019 | 1 | money | |
| `bo-wiki-mortgage` | [Mortgage](https://en.wikipedia.org/w/index.php?title=Mortgage&oldid=1376822579) | 1376822579 | 3 | money | |
| `bo-wiki-credit-score` | [Credit score](https://en.wikipedia.org/w/index.php?title=Credit_score&oldid=1376951296) | 1376951296 | 2 | money | ✓ |
| `bo-wiki-bond` | [Bond (finance)](https://en.wikipedia.org/w/index.php?title=Bond_(finance)&oldid=1375412920) | 1375412920 | 2 | money | |

## U.S. government (16 texts, public domain)

Works of the U.S. federal government are in the public domain (17 U.S.C. § 105). All were accessed on 2026-10-16.

Each text is a contiguous part of one section, copied verbatim with these formatting rules:

- One list item per line, with a `- ` marker.
- Consecutive paragraphs are joined into one paragraph.
- Footnote superscripts (NIDDK) are dropped.
- Three lists have no lead-in sentence on the page, so their section heading was added as the first line with a colon: `bo-gov-ready-tsunamis-prepare` ("Prepare now:"), `bo-gov-ready-pandemic-prepare` and `bo-gov-nws-wind-shelter`.

cdc.gov was not used: it refuses scripted downloads (HTTP 403).

| id | Page and section | Publisher | Domain | Form | CPU |
|---|---|---|---|---|---|
| `bo-gov-ready-landslides-intro` | [Landslides & Debris Flow](https://www.ready.gov/landslides-debris-flow): introduction, paragraphs 1–2 | Ready.gov (DHS / FEMA) | science | prose | |
| `bo-gov-ready-landslides-before` | [Landslides & Debris Flow](https://www.ready.gov/landslides-debris-flow): Before a Landslide, lead-in and first 5 items | Ready.gov | safety | list | ✓ |
| `bo-gov-ready-tsunamis-prepare` | [Tsunamis](https://www.ready.gov/tsunamis): Prepare NOW | Ready.gov | safety | list | |
| `bo-gov-ready-cyber-attacks` | [Cybersecurity](https://www.ready.gov/cybersecurity): introduction | Ready.gov | tech | list | ✓ |
| `bo-gov-ready-cyber-protect` | [Cybersecurity](https://www.ready.gov/cybersecurity): Protect Yourself Against Cyberattacks, lead-in and first 8 items | Ready.gov | tech | list | |
| `bo-gov-ready-finance-tips` | [Financial Preparedness](https://www.ready.gov/financial-preparedness): Financial Preparedness Tips | Ready.gov | money | list | |
| `bo-gov-ready-finance-benefits` | [Financial Preparedness](https://www.ready.gov/financial-preparedness): Get Your Benefits Electronically | Ready.gov | money | list | |
| `bo-gov-ready-volcanoes-intro` | [Volcanoes](https://www.ready.gov/volcanoes): introduction, paragraphs 1–2 | Ready.gov | science | prose | |
| `bo-gov-ready-pandemic-prepare` | [Pandemics](https://www.ready.gov/pandemic): How to Prepare Yourself for a Pandemic | Ready.gov | health | list | |
| `bo-gov-nws-cold-hypothermia` | [During Extremely Cold Weather](https://www.weather.gov/safety/cold-during): Beware of Hypothermia, paragraphs 1–2 | National Weather Service (NOAA) | health | prose | ✓ |
| `bo-gov-nws-wind-shelter` | [During a High Wind Event](https://www.weather.gov/safety/wind-during): Take Shelter | National Weather Service | safety | list | |
| `bo-gov-nws-flood-incident-sign` | [Turn Around Don’t Drown](https://www.weather.gov/safety/flood-turn-around-dont-drown): Warning Signs, the incident-sign paragraph | National Weather Service | safety | prose | |
| `bo-gov-nws-tsunami-warning` | [During a Tsunami](https://www.weather.gov/safety/tsunami-during): Respond to a Tsunami Warning, official warning in a hazard zone (lead-in and 3 items) | National Weather Service | safety | list | |
| `bo-gov-nia-falls-causes` | [Falls and Fractures in Older Adults](https://www.nia.nih.gov/health/falls-and-falls-prevention/falls-and-fractures-older-adults-causes-and-prevention): What causes falls in older adults? | National Institute on Aging (NIH) | health | list | ✓ |
| `bo-gov-nia-falls-hospital` | [Falls and Fractures in Older Adults](https://www.nia.nih.gov/health/falls-and-falls-prevention/falls-and-fractures-older-adults-causes-and-prevention): Keep your bones strong, last paragraph | National Institute on Aging (NIH) | health | prose | |
| `bo-gov-niddk-ckd-intro` | [What Is Chronic Kidney Disease in Adults?](https://www.niddk.nih.gov/health-information/kidney-disease/chronic-kidney-disease-ckd/what-is-chronic-kidney-disease): introduction, paragraphs 2–3 | NIDDK (NIH) | health | prose | |
