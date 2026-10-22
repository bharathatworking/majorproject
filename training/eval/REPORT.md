# Base vs clarity-simplify on ASSET validation (Prompt 10, Part C)

Run on 2026-10-22 by `training/evaluate.py`, following `training/eval/PREREG.md` (committed before any generation). Items: `training/eval/items.json` (300 sentences + 100 pseudo-paragraphs of ASSET validation, each at target grades 6 and 8: 800 prompts per model). Generations: `training/out/eval_generations.jsonl`.

Models: `qwen3:4b-instruct-2507-q4_K_M` and `clarity-simplify` in Ollama 0.35.0, the app's own prompt (default profile, app hints), temperature 0, seed 42, GPU.

## Verdict: **NOT BETTER (at least one pre-registered criterion failed)**

| Pre-registered criterion (pooled, point estimate) | Result | Met |
|---|---|---|
| Grade hit rises by ≥ 15 points | +0.1 points | **no** |
| SARI drops by ≤ 1.0 | +2.79 | yes |
| Entities kept drops by ≤ 2 points | -9.8 points | **no** |
| Fine-tuned near-copy rate ≤ 5% | 19.0% | **no** |

## Pooled (both targets)

| Metric | n | Base | clarity-simplify | Difference [95% CI] |
|---|---|---|---|---|
| Grade hit (|FKGL − target| ≤ 1) | 800 | 25.37 | 25.50 | +0.12 pts [-4.00, +4.38] |
| SARI (10 references) | 800 | 38.63 | 41.42 | +2.79 [+2.07, +3.52] |
| BERTScore F1 vs source (rescaled) | 800 | 0.46 | 0.70 | +0.24 [+0.22, +0.25] |
| Entities kept | 628 | 96.29 | 86.50 | -9.79 pts [-11.86, -7.73] |
| Near copies | 800 | 2.62 | 19.00 | +16.38 pts [+13.63, +19.12] |
| Output FKGL | 800 | 5.61 | 7.67 | +2.06 [+1.85, +2.27] |
| |FKGL − target| | 800 | 2.18 | 2.50 | +0.31 [+0.15, +0.48] |
| s per 100 words (GPU) | 800 | 4.13 | 2.31 | -1.83 [-1.97, -1.70] |

## Target grade 6

| Metric | n | Base | clarity-simplify | Difference [95% CI] |
|---|---|---|---|---|
| Grade hit (|FKGL − target| ≤ 1) | 400 | 30.25 | 24.50 | -5.75 pts [-12.00, +0.25] |
| SARI (10 references) | 400 | 38.33 | 40.78 | +2.46 [+1.43, +3.46] |
| BERTScore F1 vs source (rescaled) | 400 | 0.44 | 0.68 | +0.23 [+0.21, +0.25] |
| Entities kept | 314 | 96.22 | 84.72 | -11.49 pts [-14.61, -8.45] |
| Near copies | 400 | 2.00 | 15.25 | +13.25 pts [+9.75, +17.00] |
| Output FKGL | 400 | 5.39 | 7.29 | +1.89 [+1.60, +2.19] |
| |FKGL − target| | 400 | 1.76 | 2.65 | +0.89 [+0.68, +1.10] |
| s per 100 words (GPU) | 400 | 4.21 | 2.25 | -1.96 [-2.17, -1.77] |

## Target grade 8

| Metric | n | Base | clarity-simplify | Difference [95% CI] |
|---|---|---|---|---|
| Grade hit (|FKGL − target| ≤ 1) | 400 | 20.50 | 26.50 | +6.00 pts [+0.50, +11.75] |
| SARI (10 references) | 400 | 38.93 | 42.06 | +3.12 [+2.08, +4.10] |
| BERTScore F1 vs source (rescaled) | 400 | 0.48 | 0.72 | +0.24 [+0.22, +0.26] |
| Entities kept | 314 | 96.37 | 88.29 | -8.08 pts [-10.89, -5.41] |
| Near copies | 400 | 3.25 | 22.75 | +19.50 pts [+15.25, +24.00] |
| Output FKGL | 400 | 5.83 | 8.05 | +2.23 [+1.91, +2.54] |
| |FKGL − target| | 400 | 2.61 | 2.35 | -0.26 [-0.49, -0.03] |
| s per 100 words (GPU) | 400 | 4.06 | 2.36 | -1.69 [-1.88, -1.51] |

## Sentences (both targets)

| Metric | n | Base | clarity-simplify | Difference [95% CI] |
|---|---|---|---|---|
| Grade hit (|FKGL − target| ≤ 1) | 600 | 22.17 | 23.00 | +0.83 pts [-3.67, +5.50] |
| SARI (10 references) | 600 | 38.65 | 41.36 | +2.72 [+1.83, +3.61] |
| BERTScore F1 vs source (rescaled) | 600 | 0.47 | 0.68 | +0.22 [+0.20, +0.24] |
| Entities kept | 430 | 96.02 | 85.85 | -10.17 pts [-12.89, -7.56] |
| Near copies | 600 | 3.50 | 18.83 | +15.33 pts [+12.00, +18.67] |
| Output FKGL | 600 | 5.52 | 7.41 | +1.89 [+1.63, +2.16] |
| |FKGL − target| | 600 | 2.37 | 2.65 | +0.27 [+0.07, +0.47] |
| s per 100 words (GPU) | 600 | 4.58 | 2.37 | -2.21 [-2.37, -2.05] |

## Pseudo-paragraphs (both targets)

| Metric | n | Base | clarity-simplify | Difference [95% CI] |
|---|---|---|---|---|
| Grade hit (|FKGL − target| ≤ 1) | 200 | 35.00 | 33.00 | -2.00 pts [-11.50, +7.50] |
| SARI (10 references) | 200 | 38.58 | 41.59 | +3.01 [+2.03, +4.02] |
| BERTScore F1 vs source (rescaled) | 200 | 0.46 | 0.74 | +0.29 [+0.26, +0.31] |
| Entities kept | 198 | 96.88 | 87.93 | -8.96 pts [-11.95, -6.07] |
| Near copies | 200 | 0.00 | 19.50 | +19.50 pts [+14.00, +25.00] |
| Output FKGL | 200 | 5.88 | 8.44 | +2.57 [+2.29, +2.85] |
| |FKGL − target| | 200 | 1.61 | 2.05 | +0.44 [+0.17, +0.72] |
| s per 100 words (GPU) | 200 | 2.80 | 2.11 | -0.69 [-0.89, -0.55] |

Rates are in percentage points. Differences are clarity-simplify minus base, with a paired bootstrap 95% interval (10000 resamples, seed 42). Entities kept counts only items whose source has an entity. BERTScore compares the output with the source (meaning kept), not with the references.

## 10 random examples (seed 42)

### 1. p-587-590 (para), target grade 6

- **Source** (FKGL 12.17): Guangxi (or Guangxi Zhuang Autonomous Region;) is a Zhuang autonomous region of the People's Republic of China. Functions may variously include sensing touch, air motion, heat, vibration (sound), and especially olfaction (smell) or gustation (taste). The Sutlej River (alternatively spelled as Satluj River) (,,,, and) is the longest of the five rivers that flow through the historic crossroad region of Punjab in northern India and Pakistan. She later attended the Fiorello H. LaGuardia High School of Music & Art and Performing Arts (the high school featured in the movie Fame) before she entered the theater program at Juilliard.
- **Base** (FKGL 4.14, SARI 38.0): Guangxi is a part of China where the Zhuang people have their own rights.  
Our bodies can feel touch, wind, heat, and sound.  
We can also smell and taste things.  
The Sutlej River, also called Satluj River, is the longest of five rivers.  
These rivers flow through Punjab, a place that has been important for many years.  
Punjab is in both northern India and Pakistan.  
She went to Fiorello H. LaGuardia High School, which has music and art classes.  
That school was shown in the movie Fame.  
She then joined a theater program at Juilliard.
- **clarity-simplify** (FKGL 10.34, SARI 46.6): Guangxi (or Guangxi Zhuang Autonomous Region) is a Zhuang autonomous region of the People's Republic of China. Functions may include sensing touch, air motion, heat, sound, and smell. The Sutlej River (alternatively spelled as Satluj River) is the longest of the five rivers that flow through the Punjab in northern India and Pakistan. She later attended the Fiorello H. LaGuardia High School of Music & Art and Performing Arts (the high school featured in the movie Fame) before she entered the theater program at Juilliard.
- **ASSET reference 1:** Guangxi is a Zhuang autonomous part of the People's Republic of China. Functions may variously include sensing touch, air motion, heat, vibration, and especially smell or taste. The Sutlej River is the longest of the five rivers that flow through the historic crossroad region of Punjab in northern India and Pakistan. She later attended the Fiorello H. LaGuardia High School of Music & Art and Performing Arts before she entered the theater program at Juilliard.

### 2. s-350 (sent), target grade 6

- **Source** (FKGL 10.1): The most prominent among the latter were Marcus Junius Brutus and Gaius Cassius Longinus.
- **Base** (FKGL 5.62, SARI 53.5): Marcus Junius Brutus and Gaius Cassius Longinus were two of the most important men in the group.  
The group came after a time when other leaders had already been in power.  
Gaius was a man with a strong voice and a clear opinion.  
Cassius Longinus was a man who had a strong mind and a good sense of justice.  
Brutus and Cassius were both part of a group that wanted to change Rome.
- **clarity-simplify** (FKGL 5.81, SARI 41.1): The most famous of these were Marcus Junius Brutus and Caius Cassius.
- **ASSET reference 1:** The most known were Marcus Junius Brutus and Gaius Cassius Longinus.

### 3. s-41 (sent), target grade 8

- **Source** (FKGL 9.08): The main town is Abingdon, other places include Faringdon and Wantage.
- **Base** (FKGL 5.43, SARI 48.4): Abingdon is the main town. Faringdon and Wantage are other towns nearby.
- **clarity-simplify** (FKGL 2.88, SARI 35.5): The main town is Abingdon.
- **ASSET reference 1:** The main town is Abingdon.  Other towns include Faringdon and Wantage.

### 4. p-1587-1590 (para), target grade 8

- **Source** (FKGL 9.43): Bruno Mora (29 March 1937 - 10 December 1986) was an Italian footballer. 1849 A battle between German and Danish forces took place near the town on April 23 1849 during the First War of Schleswig. Skeletal remains around 2,000 years old unearthed in Switzerland indicate that Spitz-type dogs have inhabited Central Europe for millennia. He is one of the founding members of Global Elders.
- **Base** (FKGL 6.94, SARI 40.4): Bruno Mora was an Italian footballer who lived from 29 March 1937 to 10 December 1986. In 1849, a fight happened between German and Danish soldiers near a town on April 23. In Switzerland, people found bones about 2,000 years old. These bones show that dogs like Spitz lived in Central Europe for many years. The area was once inhabited by people. Bruno Mora is one of the first people in Global Elders.
- **clarity-simplify** (FKGL 7.57, SARI 45.8): Bruno Mora (29 March 1937 - 10 December 1986) was an Italian football player. 1849 A battle between German and Danish forces took place near the town on April 23 1849 during the First War of Schleswig. Bones around 2,000 years old found in Switzerland show that dogs have lived in Central Europe for millennia. He is one of the founding members of Global Elders.
- **ASSET reference 1:** Bruno Mora was an Italian footballer. A battle between German and Danish forces took place near the town on April 23 1849 during the First War of Schleswig. Skeletal remains around 2,000 years old found in Switzerland indicate that Spitz-type dogs have inhabited Central Europe for millennia. He is one of the original members of Global Elders.

### 5. s-937 (sent), target grade 8

- **Source** (FKGL 19.34): The Twelve-wired Bird of Paradise, Seleucidis melanoleucus or Seleucidis melanoleuca, is a medium-sized, approximately 33cm-long, velvet black and yellow bird of paradise.
- **Base** (FKGL 3.83, SARI 43.0): This bird is called the Twelve-wired Bird of Paradise.  
It is medium in size.  
It is about 33 centimeters long.  
Its feathers are black and yellow.  
The feathers feel like velvet.  
It is from a group of birds called Seleucidis.
- **clarity-simplify** (FKGL 8.39, SARI 42.6): The Twelve-wired Bird of Paradise is a medium-sized, 33cm-long, black and yellow bird of paradise.
- **ASSET reference 1:** The Seleucidis melanoleucus or Seleucidis melanoleuca is a medium-sized, about 33cm-long, velvet black and yellow bird of paradise.

### 6. s-835 (sent), target grade 6

- **Source** (FKGL 13.98): Very large corporations such as GE, Toyota and Sharp, and investment firms such as Goldman Sachs are making multi-billion dollar investments in clean technology.
- **Base** (FKGL 9.45, SARI 29.9): Big companies like Toyota and Goldman Sachs are spending billions on clean technology.
- **clarity-simplify** (FKGL 11.96, SARI 37.8): Very large companies such as GE, Toyota and Sharp, and investment firms such as Goldman Sachs are making billions of dollars in clean technology.
- **ASSET reference 1:** Very large corporations such as GE, Toyota and Sharp, Goldman Sachs are investing billions in clean technology.

### 7. s-721 (sent), target grade 6

- **Source** (FKGL 15.1): For example, a shop might give away its stock in its promotion, but producing these goods would still have required the use of scarce resources, so this would not be a free good in an economic sense.
- **Base** (FKGL 5.77, SARI 31.1): A shop might give away items during a sale. Making those items needed raw materials. Raw materials are not always easy to get. So the items are not truly free, even if given away.
- **clarity-simplify** (FKGL 6.3, SARI 32.4): For example, a shop might give away its stock in its promotion. But producing these goods would still have required the use of resources.
- **ASSET reference 1:** If i shop gives away it's goods for an advertisement, but making them uses rare resources, it would not be a free good according to economics.

### 8. s-452 (sent), target grade 6

- **Source** (FKGL 16.47): PackageKit is an open source and free suite of software applications designed to provide a consistent and high-level front end for a number of different package management systems.
- **Base** (FKGL 8.45, SARI 24.1): PackageKit is free software that helps users easily install and update programs.  
It works with many different systems to make things simple and the same every time.  
This means users get a smooth, reliable experience no matter which program they use.
- **clarity-simplify** (FKGL 8.41, SARI 41.6): It is an open source and free suite of applications. It is designed to provide a high-level front end for a number of different package management systems.
- **ASSET reference 1:** PackageKit is an open source and free suite of software applications made to provide a consistent and high-level front end for many package management systems.

### 9. p-1576-1578 (para), target grade 6

- **Source** (FKGL 7.36): Also, please do your best to always fill in the edit summary field. Rhys ap Gruffydd agrees to negotiate with Henry II of England. Styles There are many different apron forms depending on the purpose of the apron.
- **Base** (FKGL 4.82, SARI 41.2): Henry II of England asks Rhys ap Gruffydd to talk things over.  
Rhys ap Gruffydd agrees to talk with Henry II.  
An apron can have many different styles.  
The style of an apron depends on what it is used for.  
Please always write a short note in the edit summary field.
- **clarity-simplify** (FKGL 5.23, SARI 32.0): He agrees to talk with Henry II of England. There are many different styles of aprons.
- **ASSET reference 1:** Also, please always try to use the part for summary editing. Rhys ap Gruffydd will have a discussion with Henry II of England. There are many apron forms for various purposes.

### 10. s-327 (sent), target grade 6

- **Source** (FKGL 14.18): Davis was responsible for character design for both the Pirates of the Caribbean and Haunted Mansion attractions at Disneyland.
- **Base** (FKGL 12.56, SARI 48.6): Davis designed the characters for two fun places at Disneyland: Pirates of the Caribbean and Haunted Mansion.
- **clarity-simplify** (FKGL 10.1, SARI 34.2): He was responsible for the character design for the Pirates of the Caribbean ride.
- **ASSET reference 1:** Davis was the creator of the character design for both the Pirates of the Caribbean and Haunted Mansion rides at Disneyland.

## Limitations

- **Sentence-level evaluation set.** ASSET is single sentences; the 100 pseudo-paragraphs join consecutive validation rows, which are not real paragraphs. Clarity simplifies paragraphs of web pages.
- **Wikipedia domain.** Both the training data (Wiki-Auto) and ASSET come from English Wikipedia; government, health and instruction texts are not tested here.
- **Noisy training data.** Wiki-Auto alignments are automatic (a CRF aligner); some simple sides change or add facts the filters did not catch.
- **Single seed.** One LoRA run and one greedy generation per prompt; run-to-run variance of the fine-tune is not measured.
- **GPU-only timing.** Seconds per 100 words were measured on this PC's GPU with temperature 0; CPU-only speed is not measured.
- **Prompt context.** The prompt's "current reading level" is the item's own estimate; in the app it is the whole document's.
- **Training-only choices.** The keep slice (target = source) is never exercised by the app, which skips already-simple paragraphs. Training hints were filtered to words the reference really replaced; the evaluation uses the app's unfiltered hints.
- **Metrics.** FKGL is a proxy for reading grade; SARI rewards overlap with crowd references; BERTScore and entity recall check meaning only partly. No human judgement is part of this evaluation.
## Discussion (written after seeing the results; exploratory, changes nothing above)

**The pre-registered verdict is "not better".** Grade hit did not move (25.4% → 25.5%, CI −4.0 to +4.4 points); entities kept fell by 9.8 points and near copies rose to 19%. SARI (+2.8) and BERTScore against the source (+0.24) improved, and generation was 44% faster per 100 words, but none of these can outweigh the three failed criteria, and the rule was fixed in advance.

What the outputs show (counts from `training/out/eval_generations.jsonl`, computed after the verdict):

- **The two models fail in opposite directions.** The base model over-simplifies (481 of 800 outputs more than one grade below the target) and expands the text (output/source words 1.49), sometimes inventing sentences (example 2 above). clarity-simplify under-simplifies (363 of 800 more than one grade above the target) and shortens (0.76).
- **Grade conditioning did not take.** clarity-simplify gave the identical output at grades 6 and 8 for 224 of 400 items (base: 79). Its mean FKGL moved 0.77 between the two targets (base 0.44), so it reacts to the target a little more, but not enough to land on it.
- **It learned Simple Wikipedia's editing style:** keep most wording, delete clauses, names and parentheticals (examples 3 and 6). That raises SARI, which rewards ASSET's reference style, and BERTScore against the source, which rewards conservative output, while it costs entities: 192 of 800 outputs dropped at least one source entity (base 65), and 73 of the 281 dropped entities contain a number or date. The A4 filter only protected the numbers of each example's main claim, so references that drop other names and figures stayed in the training data.

Likely causes, for the next attempt (each would need a new pre-registration and new evaluation items):

1. **Deletion-heavy references.** Wiki-Auto's simple sides mostly delete rather than rewrite. A stricter rule (every source entity kept, or a minimum share) would remove the deletion signal, at the cost of data size.
2. **The keep slice and near-copies in the data.** Keep examples (5%) plus references that are light edits of the source (the only edit floor was a 0.5 FKGL drop) teach copying; 19% near copies is the result. A minimum word edit ratio per example would counter it.
3. **A weak grade signal.** The target grade appears once in a long system prompt, and the depth tier's wording ("below grade g, as simple as possible") contradicts it for big gaps. One epoch on 15,000 examples may be too little for the model to tie the number to the output's FKGL.

**Consequence for Clarity:** the base model `qwen3:4b-instruct-2507-q4_K_M` stays the app's default. Prompt 11 should not switch to clarity-simplify; the grade problem is better attacked in the prompt or in the run loop (for example, re-asking when the output's FKGL misses the target), which can be measured on these same items only after a new pre-registration.
