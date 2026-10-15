/**
 * Every tunable number of the quality pipeline (stage 6C semantic
 * preservation and stage 7 candidate scoring), in one place.
 *
 * Design decisions:
 *  - No imports, so UI chunks (Reading badge, Progress stats) can read the
 *    thresholds without pulling compromise or Transformers.js in.
 *  - The thesis standard for "meaning preserved" (lib/quality/meaning.ts):
 *    cosine ≥ SIMILARITY_THRESHOLD AND every entity kept AND, per simplified
 *    sentence, entailment ≥ ENTAILMENT_MIN and contradiction ≤
 *    CONTRADICTION_MAX. Changing any of these changes the thesis metric, so
 *    the run log records them with every run.
 */

// ─── Meaning preservation (stage 6C) ─────────────────────────────────────────

/**
 * Minimum cosine similarity (all-MiniLM-L6-v2 via Ollama) between original and
 * simplified paragraph. The thesis standard; faithful rewrites typically score
 * 0.85–0.95, so heavy rewording will trigger more retries than the old 0.80.
 */
export const SIMILARITY_THRESHOLD = 0.87;

/** Every non-exempt simplified sentence needs at least this entailment probability. */
export const ENTAILMENT_MIN = 0.5;

/** No simplified sentence (exempt or not) may exceed this contradiction probability. */
export const CONTRADICTION_MAX = 0.2;

/** Nodes with fewer words than this skip all meaning checks. */
export const MIN_WORDS_FOR_CHECK = 8;

/**
 * Glossary exemptions (lib/quality/glossary.ts): at most this share of a
 * node's simplified sentences may skip the entailment requirement, rounded
 * down, so nodes of 1–3 sentences get none.
 */
export const GLOSSARY_EXEMPTION_MAX_RATE = 0.3;

/** At most this many reasons are named in a retry instruction. */
export const MAX_RETRY_REASONS = 3;

/**
 * A run's pass rate is thesis-grade only when at least this share of its
 * eligible paragraphs was fully checked (SBERT + NLI + entities).
 */
export const THESIS_COVERAGE_MIN = 0.9;

// ─── NLI model (lib/quality/nli.ts) ──────────────────────────────────────────

/** Hugging Face id of the bundled cross-encoder; files live in public/models/<id>/. */
export const NLI_MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';

/** Premise/hypothesis pairs per worker inference call. */
export const NLI_BATCH_SIZE = 8;

/** Pair scores kept in memory (least recently used evicted). */
export const NLI_CACHE_MAX = 500;

/** Model load (first call) may take this long before NLI counts as unavailable. */
export const NLI_LOAD_TIMEOUT_MS = 60_000;

/** One scoring request may take this long before it fails for that node. */
export const NLI_SCORE_TIMEOUT_MS = 30_000;

/** Average NLI time per paragraph above which the run log warns (thesis budget). */
export const NLI_SLOW_MS = 500;

// ─── Candidate scoring (stage 7, lib/quality/score.ts) ───────────────────────

/** Weights of the three parts of the candidate total; they sum to 1. */
export const WEIGHTS = { meaning: 0.5, readability: 0.3, length: 0.2 } as const;

/** Below this total, "Extra quality" tries the other prompt variants. */
export const QUALITY_THRESHOLD = 0.75;

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
