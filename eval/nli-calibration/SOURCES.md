# NLI calibration paragraphs: sources and licences

> **Rule:** never reuse these paragraphs, or other paragraphs from the same article revisions, in the Ask Gemini benchmark test set (or any other test set). They tune `ENTAILMENT_MIN`, so testing on them would leak the calibration into the results.

All 67 paragraphs were retrieved on 2026-10-15. The first 15 make up the sentence-level set; all 67 are in the paragraph-level set (`paragraph-items.jsonl`): 5 were added in round 1 and 47 in round 2 (35 Wikipedia, 12 U.S. government). Each is used verbatim as the "original" (the NLI premise source). The simplified sentences in `pairs.jsonl` come from `qwen2.5:3b` (see README.md) or from hand edits of those sentences.

## Wikipedia (15 paragraphs, CC BY-SA 4.0)

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
| `wiki-great-fire-of-london` | [Great Fire of London](https://en.wikipedia.org/w/index.php?title=Great_Fire_of_London&oldid=1376270657) | 1376270657 | History (lead paragraph 1) |
| `wiki-vaccine` | [Vaccine](https://en.wikipedia.org/w/index.php?title=Vaccine&oldid=1376748103) | 1376748103 | Health (lead paragraph 3) |
| `wiki-mount-vesuvius` | [Mount Vesuvius](https://en.wikipedia.org/w/index.php?title=Mount_Vesuvius&oldid=1369586079) | 1369586079 | Geology / history (lead paragraph 2; the extract's "6×105" is the article's 6×10⁵ without the superscript) |

## U.S. government (5 texts, public domain)

Works of the U.S. federal government are in the public domain (17 U.S.C. § 105). These were chosen because they are instructions and lists, the kind of text users paste. Each is copied verbatim from the page, with one list item per line (`- ` marker). The kit list is the first 8 items of the page's list plus "Wrench or pliers" and "Cell phone with chargers and a backup battery", which appear later in the same list; the other items were left out to keep the paragraph short.

| id | Page | Publisher |
|---|---|---|
| `gov-ready-kit` | [Build A Kit](https://www.ready.gov/kit), "Basic Disaster Supplies Kit" | Ready.gov (DHS / FEMA) |
| `gov-nws-lightning` | [Lightning Safety Tips](https://www.weather.gov/safety/lightning-tips), "What You Need to Know" and "Indoor Lightning Safety" | National Weather Service (NOAA) |
| `gov-ready-fire-escape` | [Home Fires](https://www.ready.gov/home-fires), "Create and Practice a Fire Escape Plan" (intro, the first 4 tips and the 6th) | Ready.gov (DHS / FEMA) |
| `gov-ready-floods` | [Floods](https://www.ready.gov/floods), the "If you are under a flood warning" list (its heading as the first line; the two sub-items of "Depending on the type of flooding" as two items, as the page's list renders them) | Ready.gov (DHS / FEMA) |
| `gov-nws-heat-index` | [Heat Index](https://www.weather.gov/safety/heat-index), the two Heat Index paragraphs | National Weather Service (NOAA) |

### Round 2 (47 paragraphs, 2026-10-15)

Each Wikipedia paragraph is the first lead paragraph of its article with 3–9 sentences and 60–220 words (`paragraphIndex` in `paragraphs.jsonl`), as the API's plain-text extract gives it.

| id | Article | Revision |
|---|---|---|
| `wiki-apollo-11` | [Apollo 11](https://en.wikipedia.org/w/index.php?title=Apollo_11&oldid=1380193680) | 1380193680 |
| `wiki-dna` | [DNA](https://en.wikipedia.org/w/index.php?title=DNA&oldid=1379332306) | 1379332306 |
| `wiki-french-revolution` | [French Revolution](https://en.wikipedia.org/w/index.php?title=French_Revolution&oldid=1379453214) | 1379453214 |
| `wiki-isaac-newton` | [Isaac Newton](https://en.wikipedia.org/w/index.php?title=Isaac_Newton&oldid=1379624142) | 1379624142 |
| `wiki-industrial-revolution` | [Industrial Revolution](https://en.wikipedia.org/w/index.php?title=Industrial_Revolution&oldid=1379294769) | 1379294769 |
| `wiki-mitochondria` | [Mitochondria](https://en.wikipedia.org/w/index.php?title=Mitochondria&oldid=1380346321) | 1380346321 |
| `wiki-malaria` | [Malaria](https://en.wikipedia.org/w/index.php?title=Malaria&oldid=1380020573) | 1380020573 |
| `wiki-penicillin` | [Penicillin](https://en.wikipedia.org/w/index.php?title=Penicillin&oldid=1379692152) | 1379692152 |
| `wiki-plate-tectonics` | [Plate tectonics](https://en.wikipedia.org/w/index.php?title=Plate_tectonics&oldid=1376119468) | 1376119468 |
| `wiki-supply-and-demand` | [Supply and demand](https://en.wikipedia.org/w/index.php?title=Supply_and_demand&oldid=1378800284) | 1378800284 |
| `wiki-tsunami` | [Tsunami](https://en.wikipedia.org/w/index.php?title=Tsunami&oldid=1376798379) | 1376798379 |
| `wiki-mount-everest` | [Mount Everest](https://en.wikipedia.org/w/index.php?title=Mount_Everest&oldid=1376942985) | 1376942985 |
| `wiki-wright-brothers` | [Wright brothers](https://en.wikipedia.org/w/index.php?title=Wright_brothers&oldid=1380109954) | 1380109954 |
| `wiki-measles` | [Measles](https://en.wikipedia.org/w/index.php?title=Measles&oldid=1380289032) | 1380289032 |
| `wiki-taj-mahal` | [Taj Mahal](https://en.wikipedia.org/w/index.php?title=Taj_Mahal&oldid=1378868244) | 1378868244 |
| `wiki-sahara` | [Sahara](https://en.wikipedia.org/w/index.php?title=Sahara&oldid=1378658315) | 1378658315 |
| `wiki-nelson-mandela` | [Nelson Mandela](https://en.wikipedia.org/w/index.php?title=Nelson_Mandela&oldid=1380330599) | 1380330599 |
| `wiki-blockchain` | [Blockchain](https://en.wikipedia.org/w/index.php?title=Blockchain&oldid=1379281339) | 1379281339 |
| `wiki-ada-lovelace` | [Ada Lovelace](https://en.wikipedia.org/w/index.php?title=Ada_Lovelace&oldid=1379797630) | 1379797630 |
| `wiki-earthquake` | [Earthquake](https://en.wikipedia.org/w/index.php?title=Earthquake&oldid=1379800890) | 1379800890 |
| `wiki-insulin` | [Insulin](https://en.wikipedia.org/w/index.php?title=Insulin&oldid=1378048092) | 1378048092 |
| `wiki-leonardo-da-vinci` | [Leonardo da Vinci](https://en.wikipedia.org/w/index.php?title=Leonardo_da_Vinci&oldid=1377616629) | 1377616629 |
| `wiki-magna-carta` | [Magna Carta](https://en.wikipedia.org/w/index.php?title=Magna_Carta&oldid=1379714334) | 1379714334 |
| `wiki-olympic-games` | [Olympic Games](https://en.wikipedia.org/w/index.php?title=Olympic_Games&oldid=1379072110) | 1379072110 |
| `wiki-pacific-ocean` | [Pacific Ocean](https://en.wikipedia.org/w/index.php?title=Pacific_Ocean&oldid=1379062720) | 1379062720 |
| `wiki-roman-empire` | [Roman Empire](https://en.wikipedia.org/w/index.php?title=Roman_Empire&oldid=1380363985) | 1380363985 |
| `wiki-solar-system` | [Solar System](https://en.wikipedia.org/w/index.php?title=Solar_System&oldid=1379807231) | 1379807231 |
| `wiki-heart` | [Heart](https://en.wikipedia.org/w/index.php?title=Heart&oldid=1378398002) | 1378398002 |
| `wiki-hubble-space-telescope` | [Hubble Space Telescope](https://en.wikipedia.org/w/index.php?title=Hubble_Space_Telescope&oldid=1378228161) | 1378228161 |
| `wiki-coral-reef` | [Coral reef](https://en.wikipedia.org/w/index.php?title=Coral_reef&oldid=1380369380) | 1380369380 |
| `wiki-electric-vehicle` | [Electric vehicle](https://en.wikipedia.org/w/index.php?title=Electric_vehicle&oldid=1379957884) | 1379957884 |
| `wiki-great-wall-of-china` | [Great Wall of China](https://en.wikipedia.org/w/index.php?title=Great_Wall_of_China&oldid=1374512030) | 1374512030 |
| `wiki-antarctica` | [Antarctica](https://en.wikipedia.org/w/index.php?title=Antarctica&oldid=1380299432) | 1380299432 |
| `wiki-influenza` | [Influenza](https://en.wikipedia.org/w/index.php?title=Influenza&oldid=1369108661) | 1369108661 |
| `wiki-bitcoin` | [Bitcoin](https://en.wikipedia.org/w/index.php?title=Bitcoin&oldid=1379427049) | 1379427049 |

U.S. government texts (public domain, 17 U.S.C. § 105), copied verbatim; a section's list items are written one per line with `- `. In `gov-ready-tornado-warning`, the heading is the first line, with a colon added.

| id | Page and section |
|---|---|
| `gov-ready-tornado-warning` | [Tornadoes: If You Are Under A Tornado or Severe Weather Warning](https://www.ready.gov/tornadoes) |
| `gov-ready-tornado-car` | [Tornadoes: in a car or truck](https://www.ready.gov/tornadoes) |
| `gov-ready-hurricanes` | [Hurricanes (introduction)](https://www.ready.gov/hurricanes) |
| `gov-ready-earthquake-drop-cover` | [Earthquakes: Protect Yourself During Earthquakes](https://www.ready.gov/earthquakes) |
| `gov-ready-earthquake-during` | [Earthquakes: if an earthquake happens](https://www.ready.gov/earthquakes) |
| `gov-ready-power-food` | [Power Outages: Using Appliances During Power Outages](https://www.ready.gov/power-outages) |
| `gov-ready-power-prepare` | [Power Outages: Preparing for a Power Outage](https://www.ready.gov/power-outages) |
| `gov-ready-generators` | [Power Outages: generators](https://www.ready.gov/power-outages) |
| `gov-nws-rip-currents` | [Rip Currents: How to Avoid Getting Caught in a Rip Current](https://www.weather.gov/safety/ripcurrent) |
| `gov-ready-winter-prepare` | [Winter Weather: Preparing for Winter Weather](https://www.ready.gov/winter-weather) |
| `gov-ready-winter-safe` | [Winter Weather: Stay Safe During Winter Weather](https://www.ready.gov/winter-weather) |
| `gov-ready-extreme-heat` | [Extreme Heat (introduction)](https://www.ready.gov/heat) |
