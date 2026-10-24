/**
 * Every tunable number of the quality pipeline (stage 6C semantic
 * preservation and stage 7 candidate scoring), in one place.
 *
 * Design decisions:
 *  - No imports, so UI chunks (Reading badge, Progress stats) can read the
 *    thresholds without pulling compromise or Transformers.js in.
 *  - The thesis standard for "meaning preserved" (lib/quality/meaning.ts)
 *    since 2026-10-19: the combined score (COMBINED_SCORE_FULL / _LITE) ≥
 *    its frozen threshold. Before, it was cosine ≥ SIMILARITY_THRESHOLD AND
 *    every entity kept AND, per simplified sentence, entailment ≥
 *    ENTAILMENT_MIN and contradiction ≤ CONTRADICTION_MAX; those constants
 *    stay for the retry reasons and as the evaluation baseline. The run log
 *    records all of them with every run.
 */

// ─── Meaning preservation (stage 6C) ─────────────────────────────────────────

/**
 * Minimum cosine similarity (all-MiniLM-L6-v2 via Ollama) between original and
 * simplified paragraph. The thesis standard; faithful rewrites typically score
 * 0.85–0.95, so heavy rewording will trigger more retries than the old 0.80.
 */
export const SIMILARITY_THRESHOLD = 0.87;

/**
 * Every non-exempt simplified sentence needs at least this entailment probability.
 * Calibration 2026-10-15 (npm run calibrate-nli; eval/nli-calibration/, 60
 * items, PROPOSED labels not yet reviewed; top-3 premises, 'best-entailing'):
 * no value from 0.30 to 0.70 meets false-fail ≤ 10% and catch ≥ 90%. Every
 * value gives the same 13.3% false-fail (4/30 faithful) and 96.7% catch
 * (29/30 wrong), because the model's entailment scores are bimodal. NOT
 * frozen: it stays 0.5 until the labels are reviewed and the author decides.
 */
export const ENTAILMENT_MIN = 0.5;

/** No simplified sentence (exempt or not) may exceed this contradiction probability. */
export const CONTRADICTION_MAX = 0.2;

/**
 * Paragraph rule of the NLI check (lib/quality/verdict.ts): 'A' every
 * non-exempt sentence entailed; 'B' tolerates one neutral sentence when the
 * output has NLI_NEUTRAL_MIN_SENTENCES or more. Contradictions never pass.
 */
export const NLI_PARAGRAPH_RULE: 'A' | 'B' = 'A';

/** Rule B tolerates one neutral sentence only in outputs this long or longer. */
export const NLI_NEUTRAL_MIN_SENTENCES = 6;

/**
 * Hypothesis context (lib/quality/nli.ts hypothesisFor): a simplified
 * sentence with fewer words than this, or one starting with a referring word
 * (NLI_REFERRING_START), is scored together with the previous simplified
 * sentence. Alone, "That's called inflation." or "Anatocism is the same." has
 * no subject the premises can entail, and the model reads it as neutral or
 * contradicted.
 */
export const NLI_CONTEXT_MAX_WORDS = 7;
export const NLI_REFERRING_START = /^["'“‘(]?(?:this|that|it|these|they)\b/i;

/** Recorded in every run log: how a hypothesis is formed. */
export const NLI_HYPOTHESIS_CONTEXT = 'prev-sentence-if-<7-words-or-referring';

/**
 * Entity rule (lib/quality/verdict.ts entityVerdict): at least this share of
 * the original's entities must be kept, and every number, date and time zone
 * of its main claim must be kept. 1 = every entity (the rule before
 * calibration). NOT calibrated yet: set from npm run calibrate-meaning once
 * the labels are reviewed.
 */
export const ENTITY_RECALL_MIN = 1;

/**
 * The combined meaning score that decides pass/fail (lib/quality/checker.ts,
 * meaning.ts): score = sigmoid(Σ weights·(x − means)/stds + bias), pass =
 * score ≥ threshold. FROZEN 2026-10-19: fit on the 81 calibration items only
 * (npm run checker:fit; 5-fold stratified group CV, L2, balanced weights,
 * backward elimination, catch ≥ 90% threshold) and pre-registered in
 * eval/checker/PREREG.md, whose JSON block these values must match
 * (scripts/checker/test-heldout.mjs checks). Never re-tune them on the
 * bake-off test set; a new fit needs a new pre-registration.
 * FULL is used when the NLI model scored the version; LITE (no NLI feature)
 * in Lite mode or when NLI is unavailable. SIMILARITY_THRESHOLD,
 * ENTAILMENT_MIN, CONTRADICTION_MAX and ENTITY_RECALL_MIN no longer decide
 * the verdict: they only pick which sentences and drops a retry names, and
 * they define the old rule kept as the evaluation baseline.
 */
export const COMBINED_SCORE_FULL = {
  id: 'full',
  features: ['sbert', 'entity', 'nliMin', 'contra', 'lenRatio'],
  means: [0.861433, 0.826978, 0.377698, 0.210091, 0.693974],
  stds: [0.065517, 0.266737, 0.423375, 0.341966, 0.173897],
  weights: [0.075837, 0.057485, 0.099032, -0.107555, 0.095553],
  bias: 0.00375,
  threshold: 0.569168,
} as const;

export const COMBINED_SCORE_LITE = {
  id: 'lite',
  features: ['sbert', 'entity', 'lenRatio'],
  means: [0.861433, 0.826978, 0.693974],
  stds: [0.065517, 0.266737, 0.173897],
  weights: [0.080126, 0.057627, 0.091799],
  bias: 0.001869,
  threshold: 0.536117,
} as const;

/** Nodes with fewer words than this skip all meaning checks. */
export const MIN_WORDS_FOR_CHECK = 8;

/**
 * Glossary exemptions (lib/quality/glossary.ts): at most this share of a
 * node's simplified sentences may skip the entailment requirement, rounded
 * down but at least 1 for a node of 2+ sentences; a 1-sentence node gets none.
 */
export const GLOSSARY_EXEMPTION_MAX_RATE = 0.3;

/** At most this many reasons (missing items included) are named in a retry instruction. */
export const MAX_RETRY_REASONS = 3;

/**
 * Retry policy (meaning.ts shouldRetry): a failing version is NOT retried
 * when its only failure is 'unsupported', its highest contradiction is below
 * RETRY_SKIP_MAX_CONTRADICTION and its entity recall is at least
 * RETRY_SKIP_MIN_ENTITY_RECALL. It is kept as "Not verified" (still failed
 * in the pass rate). The frozen checker fails most faithful paragraphs on
 * NLI support alone (eval/checker/REPORT.md), so such a retry costs a model
 * call and an NLI pass for little gain (UK run: 19.9 s per model node).
 * Retries still happen for entities, contradiction, similarity and echo.
 */
export const RETRY_SKIP_UNSUPPORTED_ONLY = true;
export const RETRY_SKIP_MAX_CONTRADICTION = CONTRADICTION_MAX;
export const RETRY_SKIP_MIN_ENTITY_RECALL = 1;

/**
 * Echo guard (lib/quality/echo.ts): an output line is a copied list, not a
 * sentence, when it splits at commas into at least ECHO_MIN_PARTS parts, at
 * least ECHO_MIN_SOURCE_SHARE of them are entities or numbers from the
 * source, and no other part has more than ECHO_MAX_OTHER_WORDS words. The
 * last rule keeps real sentences with lists ("It is surrounded by the
 * Atlantic Ocean, North Sea, English Channel, Celtic Sea, and Irish Sea":
 * 3 of 5 parts are names, but the first part is a clause). Seen in a real
 * run (eval/fixtures/runs/uk-wiki-2026-10-19.json): "- Roman, Roman, 43,
 * 383, 410, 450, 1066, England, …" copied from the prompt's entity line.
 */
export const ECHO_MIN_PARTS = 4;
export const ECHO_MIN_SOURCE_SHARE = 0.6;
export const ECHO_MAX_OTHER_WORDS = 3;

/**
 * A run's pass rate is thesis-grade only when at least this share of its
 * eligible paragraphs was fully checked (SBERT + NLI + entities).
 */
export const THESIS_COVERAGE_MIN = 0.9;

// ─── NLI model (lib/quality/nli.ts) ──────────────────────────────────────────

/** Hugging Face id of the bundled cross-encoder; files live in public/models/<id>/. */
export const NLI_MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';

/**
 * Most premise/hypothesis pairs per worker inference call, by backend. A
 * batch is padded to its longest pair, so a smaller batch wastes less work
 * on padding; WebGPU still gains from 32 pairs at once, while wasm (one
 * thread) gains nothing from big batches and pads more.
 */
export const NLI_BATCH_SIZE_WEBGPU = 32;
export const NLI_BATCH_SIZE_WASM = 8;

/**
 * Premises scored per simplified sentence: the most similar original
 * sentences or 2-sentence windows (lib/quality/premises.ts).
 */
export const NLI_TOP_PREMISES = 3;

/**
 * How a sentence's contradiction is taken over its premises: 'max' (the
 * highest over all scored premises) or 'best-entailing' (the contradiction
 * of the premise that entails it best). Entailment is always the max.
 * Calibration 2026-10-15 (npm run calibrate-nli, 60 items, proposed labels):
 * 'max' failed 30.0% of faithful sentences, 8 of them on contradiction alone
 * (e.g. "It was named a World Heritage Site in 1981." scored 0.99 against
 * another sentence's date), so it is 'best-entailing': 13.3% false-fail,
 * 96.7% catch.
 */
export const NLI_CONTRADICTION_AGG: 'max' | 'best-entailing' = 'best-entailing';

/** Pair scores kept in memory (least recently used evicted). */
export const NLI_CACHE_MAX = 500;

/** Model load (first call) may take this long before NLI counts as unavailable. */
export const NLI_LOAD_TIMEOUT_MS = 60_000;

/** One scoring request may take this long before it fails for that node. */
export const NLI_SCORE_TIMEOUT_MS = 30_000;

/**
 * Thesis budget for the average NLI time per paragraph. A run above it logs
 * "NLI above budget" once with console.info, never console.warn: warnings go
 * to the chrome://extensions Errors page, which stays for real errors.
 */
export const NLI_BUDGET_MS = 1000;

// ─── Quality mode (lib/quality/mode.ts) ──────────────────────────────────────

/**
 * Simplified sentences in a typical paragraph: the benchmark paragraph
 * (lib/quality/nli.ts NLI_BENCH_PARAGRAPH) has this many.
 */
export const NLI_TYPICAL_SENTENCES = 6;

/**
 * Auto picks Lite when there is no WebGPU and the benchmark predicts more
 * than this many ms of NLI per paragraph.
 */
export const AUTO_LITE_PARAGRAPH_MS = 3000;

// ─── Candidate scoring (stage 7, lib/quality/score.ts) ───────────────────────

/** Weights of the three parts of the candidate total; they sum to 1. */
export const WEIGHTS = { meaning: 0.5, readability: 0.3, length: 0.2 } as const;

/**
 * QUALITY_THRESHOLD before the rescale, when the meaning part was entity
 * recall × similarity × minimum entailment. Not used by the app: it is the
 * anchor of the quantile match below (npm run checker:rescale).
 */
export const QUALITY_THRESHOLD_OLD_SCALE = 0.75;

/**
 * Below this total, "Extra quality" tries the other prompt variants.
 * Rescaled 2026-10-19 for the combined meaning score (npm run
 * checker:rescale): quantile matching on the 81 calibration items only
 * (eval/checker/features_calib.csv + the calibration outputs in
 * eval/nli-calibration/, FULL score, base word list, stored target grade 6).
 * Under the old total, 67/81 = 82.7% of items were below 0.75; under the new
 * total, 67/81 = 82.7% are below 0.718 (and 93.8% would be below 0.75). Only
 * the scale changed: the trigger share on calibration is the same.
 */
export const QUALITY_THRESHOLD = 0.718;

/** Never more model calls than this for one node (first attempt included). */
export const MAX_MODEL_CALLS_PER_NODE = 3;

/** Grade gap at which the readability part reaches 0. */
export const GRADE_GAP_SCALE = 6;

/** Weight of a gap below the target, relative to one above it. */
export const BELOW_TARGET_FACTOR = 0.5;

/** Length ratios scoring 1, and where the score reaches 0 on either side. */
export const LENGTH_IDEAL = { min: 0.5, max: 1.3 } as const;
export const LENGTH_MIN = 0.15;
export const LENGTH_MAX = 2.0;

// ─── Grade targeting (Prompt 11, lib/quality/grade.ts) ───────────────────────

/**
 * A version is on target when |FKGL − target grade| ≤ this. The same 1.0 as
 * the pre-registered "target-grade hit" (eval/grade-targeting/PREREG.md).
 */
export const GRADE_TOLERANCE = 1.0;

/**
 * Grade-aware prompt wording (arm B) in the app. Off until
 * eval/grade-targeting/REPORT.md: PREREG's decision rule keeps B's wording
 * only if B vs A breaks no guardrail.
 */
export const GRADE_WORDING_ENABLED = false;

/**
 * The FKGL measure-and-retry loop (arm C) in the app. Off until REPORT.md:
 * PREREG enables it by default only if the primary criterion and all four
 * guardrails hold. It never adds a model call (see lib/quality/grade.ts).
 */
export const GRADE_RETRY_ENABLED = false;

/**
 * What a grade means, for the grade-aware wording: the first band whose
 * `maxGrade` is ≥ the target. Typical reader ages (US grade + 5/6) and the
 * sentence lengths that give that Flesch-Kincaid grade with everyday words.
 */
export const GRADE_WORDING_BANDS: readonly { maxGrade: number; ages: string; words: string; vocabulary: string }[] = [
  { maxGrade: 3, ages: '7–9', words: '6–9', vocabulary: 'only very common, short words' },
  { maxGrade: 5, ages: '9–11', words: '8–12', vocabulary: 'common everyday words' },
  { maxGrade: 7, ages: '11–13', words: '12–15', vocabulary: 'mostly everyday words; explain any harder word' },
  { maxGrade: 9, ages: '13–15', words: '14–18', vocabulary: 'everyday words plus a few subject words' },
  { maxGrade: 12, ages: '15–18', words: '17–22', vocabulary: 'general vocabulary; subject terms are fine' },
  { maxGrade: Infinity, ages: 'adult', words: '20–25', vocabulary: 'educated adult vocabulary' },
];

/**
 * Model calls a node may make without best-of-N ("Extra quality" off, or
 * Lite mode): the first version plus one retry. The meaning retry and the
 * grade retry share that one retry (lib/quality/grade.ts planRetry).
 */
export const CALLS_WITHOUT_BEST_OF_N = 2;
