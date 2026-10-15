# NLI calibration paragraphs: sources and licences

> **Rule:** never reuse these paragraphs, or other paragraphs from the same article revisions, in the Ask Gemini benchmark test set (or any other test set). They tune `ENTAILMENT_MIN`, so testing on them would leak the calibration into the results.

All 15 paragraphs were retrieved on 2026-10-15. Each is used verbatim as the "original" (the NLI premise source). The simplified sentences in `pairs.jsonl` come from `qwen2.5:3b` (see README.md) or from hand edits of those sentences.

## Wikipedia (12 paragraphs, CC BY-SA 4.0)

Text from Wikipedia, licensed under the [Creative Commons Attribution-ShareAlike 4.0 License](https://creativecommons.org/licenses/by-sa/4.0/). The authors are the contributors listed in each article's history at the revision given. Each paragraph is one paragraph of the article's lead section, unmodified. The derived simplified and edited sentences in `pairs.jsonl` are shared under the same licence.

| id | Article | Revision | Domain |
|---|---|---|---|
| `wiki-amazon-river` | [Amazon River](https://en.wikipedia.org/w/index.php?title=Amazon_River&oldid=1379247795) | 1379247795 | Geography |
| `wiki-antibiotic` | [Antibiotic](https://en.wikipedia.org/w/index.php?title=Antibiotic&oldid=1379880384) | 1379880384 | Health |
| `wiki-black-hole` | [Black hole](https://en.wikipedia.org/w/index.php?title=Black_hole&oldid=1379111441) | 1379111441 | Physics |
| `wiki-marie-curie` | [Marie Curie](https://en.wikipedia.org/w/index.php?title=Marie_Curie&oldid=1379969707) | 1379969707 | Biography |
| `wiki-printing-press` | [Printing press](https://en.wikipedia.org/w/index.php?title=Printing_press&oldid=1379445153) | 1379445153 | Technology / history |
| `wiki-photosynthesis` | [Photosynthesis](https://en.wikipedia.org/w/index.php?title=Photosynthesis&oldid=1379238357) | 1379238357 | Biology |
| `wiki-treaty-of-versailles` | [Treaty of Versailles](https://en.wikipedia.org/w/index.php?title=Treaty_of_Versailles&oldid=1378834026) | 1378834026 | History |
| `wiki-transmission-control-protocol` | [Transmission Control Protocol](https://en.wikipedia.org/w/index.php?title=Transmission_Control_Protocol&oldid=1379364197) | 1379364197 | Computing |
| `wiki-inflation` | [Inflation](https://en.wikipedia.org/w/index.php?title=Inflation&oldid=1380085884) | 1380085884 | Economics |
| `wiki-great-barrier-reef` | [Great Barrier Reef](https://en.wikipedia.org/w/index.php?title=Great_Barrier_Reef&oldid=1375964325) | 1375964325 | Geography / ecology |
| `wiki-type-2-diabetes` | [Type 2 diabetes](https://en.wikipedia.org/w/index.php?title=Type_2_diabetes&oldid=1375527475) | 1375527475 | Health |
| `wiki-compound-interest` | [Compound interest](https://en.wikipedia.org/w/index.php?title=Compound_interest&oldid=1377563152) | 1377563152 | Finance |

## U.S. government (3 texts, public domain)

Works of the U.S. federal government are in the public domain (17 U.S.C. § 105). These were chosen because they are instructions and lists, the kind of text users paste. Each is copied verbatim from the page, with one list item per line (`- ` marker). The kit list is the first 8 items of the page's list plus "Wrench or pliers" and "Cell phone with chargers and a backup battery", which appear later in the same list; the other items were left out to keep the paragraph short.

| id | Page | Publisher |
|---|---|---|
| `gov-ready-kit` | [Build A Kit](https://www.ready.gov/kit), "Basic Disaster Supplies Kit" | Ready.gov (DHS / FEMA) |
| `gov-nws-lightning` | [Lightning Safety Tips](https://www.weather.gov/safety/lightning-tips), "What You Need to Know" and "Indoor Lightning Safety" | National Weather Service (NOAA) |
| `gov-ready-fire-escape` | [Home Fires](https://www.ready.gov/home-fires), "Create and Practice a Fire Escape Plan" (intro, the first 4 tips and the 6th) | Ready.gov (DHS / FEMA) |
