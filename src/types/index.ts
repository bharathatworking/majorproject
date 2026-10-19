export type ContentNode = {
  id: string;
  type: 'heading' | 'paragraph' | 'list' | 'list-item' | 'table' | 'blockquote';
  level?: number;
  text: string;
  /** List-item nesting depth (1 = Word "o" sub-bullet); omitted at the top level. */
  depth?: number;
  /** List item of an <ol>. */
  ordered?: boolean;
  children?: ContentNode[];
  entities?: Entity[];
  skipSimplification?: boolean;
};

export type Entity = {
  text: string;
  type: 'person' | 'org' | 'date' | 'timezone' | 'number' | 'place' | 'other';
  start: number;
  end: number;
};

export type ReadabilityReport = {
  fleschReadingEase: number;
  fleschKincaidGradeLevel: number;
  gunningFogIndex: number;
  smogIndex: number;
  colemanLiauIndex: number;
  automatedReadabilityIndex: number;
  daleChallScore: number;
  avgSentenceLength: number;
  avgWordLength: number;
  complexWordPercent: number;
  longSentencePercent: number;
  typeTokenRatio: number;
  jargonDensity: number;
  estimatedGradeLevel: number;
};

/** One-click reading presets shown as cards in Settings (see lib/profile/presets.ts). */
export type PresetId =
  | 'beginner'
  | 'student'
  | 'dyslexic-friendly'
  | 'non-native'
  | 'elderly'
  | 'technical-learner';

export type UserProfile = {
  ageGroup: 'child' | 'teen' | 'adult';
  targetGradeLevel: number | 'auto';
  readingPurpose: 'general' | 'esl' | 'dyslexia-friendly' | 'expert-to-lay';
  domainFamiliarity: 'novice' | 'intermediate' | 'expert';
  preferredStyle: 'plain' | 'bullet-summary' | 'eli5' | 'concise';
  /** Preset the fields came from; 'custom' once any field is edited. Missing on old profiles. */
  preset?: PresetId | 'custom';
};

export type SimplificationSpec = {
  targetGrade: number;
  depthTier: 'none' | 'light' | 'moderate' | 'aggressive';
  style: string;
  preserveEntities: boolean;
  maxSentenceLength: number;
  allowBullets: boolean;
  tone: string;
  /** Explain technical terms in brackets the first time they appear. */
  explainTerms: boolean;
  /** Reader knows the field: keep terms, simplify only structure. Overrides explainTerms. */
  keepTerms: boolean;
  /** Avoid idioms, phrasal verbs and figurative language (ESL readers). */
  avoidIdioms: boolean;
  /** One idea per sentence and short paragraphs (dyslexia-friendly). */
  oneIdeaPerSentence: boolean;
};

export type LLMAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

export interface ExtractedArticle {
  title: string;
  byline: string | null;
  content: string;
  textContent: string;
  excerpt: string | null;
  siteName: string | null;
  contentHash: string;
}

export interface SimplificationResult {
  nodeId: string;
  originalText: string;
  simplifiedText: string;
  status: 'pending' | 'streaming' | 'done' | 'error';
}

/**
 * Meaning-check fields of a stored result (see lib/quality/meaning.ts). All are
 * absent when the node was not checked (headings, short texts, already simple)
 * or was stored before the thesis standard existed; `passed` is set exactly
 * when it was checked under the current standard.
 */
export interface StoredMeaning {
  /** 0–1 embedding cosine vs the original; absent when the embedding model was missing. */
  similarity?: number;
  /** Share of the original's entities still present. */
  entityRecall?: number;
  /** Lowest NLI entailment over the non-exempt simplified sentences. */
  minEntailment?: number;
  /** Highest NLI contradiction over all simplified sentences. */
  maxContradiction?: number;
  /** The NLI model scored this version (false: it fell back to SBERT + entities). */
  nliChecked?: boolean;
  /**
   * Met the meaning standard: since 2026-10-19 the combined score ≥ its
   * threshold, and no copied list or instruction echo (lib/quality/echo.ts).
   */
  passed?: boolean;
  /** The version copied the prompt (a list of entities or instruction wording); absent otherwise. */
  echo?: true;
  /** Why it failed, most important first; empty when it passed. */
  reasons?: string[];
  /** Checked in Lite quality mode (SBERT + entities only, NLI skipped on purpose). */
  lite?: boolean;
  /** Which checks failed (empty when it passed; absent in results stored before it existed). */
  failures?: MeaningFailure[];
  /** Combined meaning score (0–1) that decided `passed`; absent in results stored before it existed. */
  score?: number;
  /** Which frozen score model gave `score`. */
  scoreModel?: CombinedScoreModel['id'];
}

/**
 * Why a version failed the meaning standard; one version can fail several:
 * SBERT cosine below the cutoff, a dropped entity, an NLI-unsupported
 * sentence (or no sentences), an NLI-contradicted sentence, a line copied
 * from the prompt (lib/quality/echo.ts).
 */
export type MeaningFailure = 'similarity' | 'entities' | 'unsupported' | 'contradiction' | 'echo';

/** Failed versions per failure kind (one can count under several), and how many failed. */
export type FailureBreakdown = Record<MeaningFailure, number> & { failedParagraphs: number };

/**
 * A concrete reason shown beside a "Not verified" badge on the Reading page
 * (lib/quality/similarity.ts meaningChips): a dropped number, date, time
 * zone or name, or an NLI contradiction. Rendered as React text only.
 */
export interface MeaningChip {
  kind: 'entity' | 'contradiction';
  /** Short text, e.g. "missing number" or "contradiction". */
  label: string;
  /** Tooltip: the full reason(s) behind the chip. */
  title: string;
}

/**
 * A SimplificationResult that has been persisted to storage.
 * Carries the node's structural type and heading level so the Reading page
 * can render it correctly (h2/h3 vs p vs blockquote vs li) without needing
 * to re-segment the HTML on every load.
 */
export interface StoredResult extends SimplificationResult, StoredMeaning {
  type: 'heading' | 'paragraph' | 'list-item' | 'blockquote';
  level?: number;
  /** Node was already at or below the target grade; simplifiedText is the original. */
  skipped?: boolean;
}

/** One cached model output for a node (see lib/storage/cache.ts). */
export interface CachedResult {
  text: string;
  /** Meaning check of the cached version; null when the node is not checked. */
  meaning: StoredMeaning | null;
  /** Entry format (CACHE_FORMAT, set by putCached); older entries are misses. */
  format?: number;
}

/** Result of the embedding meaning check for one simplified node. */
export interface MeaningCheck {
  similarity: number;
}

/** NLI scores of one simplified sentence over its premises (lib/quality/nli.ts). */
export interface SentenceScore {
  sentence: string;
  /**
   * The text scored as the hypothesis: the sentence, or the previous
   * sentence plus it when it is short or referring (hypothesisFor in nli.ts).
   */
  hypothesis?: string;
  /** Max entailment over the sentence's premises. */
  entailment: number;
  /** Contradiction per NLI_CONTRADICTION_AGG. */
  contradiction: number;
  /** Glossary sentence: skips the entailment requirement, not the contradiction one. */
  exempt: boolean;
}

/**
 * Paragraph rule of the NLI check (lib/quality/verdict.ts): 'A' every
 * non-exempt sentence entailed; 'B' as A, but one neutral (unsupported, not
 * contradicted) sentence is tolerated when the output has
 * NLI_NEUTRAL_MIN_SENTENCES or more sentences. Contradictions never pass.
 */
export type NliParagraphRule = 'A' | 'B';

/** Sentence-level NLI result for one simplified node (see lib/quality/nli.ts). */
export interface EntailmentCheck {
  /** The paragraph passed the NLI rule (lib/quality/verdict.ts nliVerdict). */
  passed: boolean;
  /** Every sentence's scores, in order. */
  sentenceScores: SentenceScore[];
  /** Unsupported sentences the paragraph rule tolerated (rule B); not failures. */
  toleratedSentences: string[];
  /** Lowest entailment over the non-exempt sentences (0 when there are none). */
  minEntailment: number;
  /** Highest contradiction over all sentences, exempt ones included. */
  maxContradiction: number;
  /** Non-exempt sentences below ENTAILMENT_MIN that the rule did not tolerate, in order. */
  unsupportedSentences: string[];
  /** Sentences above CONTRADICTION_MAX, in order. */
  contradictedSentences: string[];
  /** Glossary sentences that skipped the entailment requirement. */
  exemptedSentences: string[];
  /** exemptedSentences / sentences (0 when there are none). */
  exemptionRate: number;
  /** Sentences scored. */
  sentences: number;
  /** Pairs answered from the in-memory cache. */
  cachedPairs: number;
  /** Premise/hypothesis pairs scored (after top-k pruning and dedup). */
  pairs: number;
  /** Pairs longer than the model's 512 tokens, scored truncated. */
  truncatedPairs: number;
  /** How premises were picked per sentence (lib/quality/premises.ts). */
  ranking: PremiseRanking;
  /** Time spent ranking premises (embedding call) and scoring pairs. */
  rankMs: number;
  scoreMs: number;
  ms: number;
}

/**
 * 'embedding': top premises by all-minilm cosine; 'lexical': by word overlap
 * (embedding model missing); 'all': no more premises than the top-k.
 */
export type PremiseRanking = 'embedding' | 'lexical' | 'all';

// ─── Quality mode and NLI backend ────────────────────────────────────────────

/** "Quality mode" setting (chrome.storage.sync `qualityMode`). */
export type QualityModeSetting = 'auto' | 'full' | 'lite';

/** The mode a run actually uses (lib/quality/mode.ts). */
export type QualityMode = 'full' | 'lite';

/** Where the NLI model runs. */
export type NliBackendName = 'webgpu' | 'wasm';

/**
 * Requested NLI device: WebGPU first ('auto'), wasm only, or WebGPU with fp16
 * weights (the fp16 experiment); the last two are debug overrides.
 */
export type NliDevice = 'auto' | 'wasm' | 'webgpu-fp16';

/** Weights the NLI model runs with: 8-bit quantized (the default) or fp16 (experiment). */
export type NliDtype = 'q8' | 'fp16';

/**
 * NLI speed benchmark (chrome.storage.local `nli:bench`), re-run when the
 * extension version, the WebGPU adapter or the requested device changes.
 */
export interface NliBenchRecord {
  backend: NliBackendName;
  /** GPU adapter vendor (e.g. "nvidia"); null on wasm. */
  adapterVendor: string | null;
  /** Weights the benchmark ran with (absent in records from before the fp16 experiment: q8). */
  dtype?: NliDtype;
  /**
   * ms to score the benchmark paragraph's pairs (format 2: the 18 pairs of
   * NLI_BENCH_PARAGRAPH in the backend's batch size; format 1: one batch of 8
   * short pairs), after a warm-up.
   */
  ms: number;
  /** Benchmark format (absent: 1, the 8-pair benchmark; such records are stale). */
  benchFormat?: number;
  /** Predicted NLI ms per paragraph (lib/quality/mode.ts predictParagraphMs). */
  predictedParagraphMs: number;
  /** Extension version the benchmark ran on. */
  version: string;
  /** The page saw a WebGPU adapter when the benchmark ran. */
  webgpuAdapter: boolean;
  device: NliDevice;
  at: number;
}

/**
 * Candidate features of the combined meaning score (lib/quality/checker.ts):
 * SBERT cosine, entity keep ratio, min / mean NLI entailment, max
 * contradiction, entailment of the original's main claim, share of the main
 * claim's numbers and dates kept, and the output/original word ratio.
 */
export type CheckerFeature =
  | 'sbert' | 'entity' | 'nliMin' | 'nliMean' | 'contra' | 'mainClaim' | 'numbers' | 'lenRatio';

/** One version's feature values; null when the check behind it did not run. */
export type CheckerFeatures = Record<CheckerFeature, number | null>;

/**
 * A frozen logistic-regression meaning score (eval/checker/PREREG.md):
 * score = sigmoid(Σ weights·(x − means)/stds + bias), pass = score ≥ threshold.
 * 'full' may use NLI features; 'lite' never does.
 */
export interface CombinedScoreModel {
  id: 'full' | 'lite';
  features: readonly CheckerFeature[];
  means: readonly number[];
  stds: readonly number[];
  weights: readonly number[];
  bias: number;
  threshold: number;
}

/**
 * Combined meaning assessment of one simplified version (thesis standard,
 * lib/quality/meaning.ts): SBERT cosine, entity recall and NLI.
 */
export interface MeaningAssessment {
  /** Null when the embedding model was unavailable. */
  similarity: number | null;
  entityRecall: number;
  missingEntities: string[];
  /** Dropped key entities (numbers, dates, time zones of the original's main claim). */
  missingKeyEntities: string[];
  /** Null when NLI did not run. */
  minEntailment: number | null;
  maxContradiction: number | null;
  nliChecked: boolean;
  /** SBERT, NLI and entities all ran. */
  fullyChecked: boolean;
  /** The combined score reached its model's threshold and the version did not echo the prompt. */
  passed: boolean;
  /** The version has a copied list line or repeats instruction wording (echo guard on). */
  echo: boolean;
  /** Failure reasons, most important first. */
  reasons: string[];
  /** Which checks failed; empty exactly when `passed`. */
  failures: MeaningFailure[];
  exemptedSentences: string[];
  /** Null when NLI did not run. */
  exemptionRate: number | null;
  /** NLI scoring time for this version; null when NLI did not run. */
  nliMs: number | null;
  /** Of nliMs: premise ranking (embedding call) and pair scoring; null when NLI did not run. */
  nliRankMs: number | null;
  nliScoreMs: number | null;
  /** NLI-scored sentences; 0 when NLI did not run. */
  nliSentences: number;
  /** Combined meaning score (lib/quality/checker.ts); `passed` is score ≥ the model's threshold. */
  score: number;
  /** The frozen model used: 'full' with NLI, 'lite' without (Lite mode or NLI unavailable). */
  scoreModel: CombinedScoreModel['id'];
  /** Feature values the score was computed from (null = not measured). */
  features: CheckerFeatures;
}

/** One simplified version of a node; `meaning` is null when the node is not checked. */
export interface MeaningCandidate {
  text: string;
  meaning: MeaningAssessment | null;
}

// ─── Stage 7: prompt variants, candidate scores and run logs ─────────────────

/** Prompt variants of lib/prompt-builder/variants.ts; add a member there too. */
export type PromptVariantId = 'standard' | 'stepwise' | 'example-guided';

/** Quality score of one simplified version (see lib/quality/score.ts). */
export interface CandidateScores {
  /** Output grade minus the target grade; positive means still too hard. */
  gradeGap: number;
  /** Embedding cosine vs the original; null when not measured. */
  similarity: number | null;
  /** Share of the original's entities still present (1 when it has none). */
  entityRecall: number;
  /** Output words divided by original words. */
  lengthRatio: number;
  /** Lowest NLI entailment; null when NLI did not run or the node is not checked. */
  minEntailment: number | null;
  /** Highest NLI contradiction; null when NLI did not run or the node is not checked. */
  maxContradiction: number | null;
  /** Passed the meaning checks (true when the node is not checked). */
  passed: boolean;
  /** Weighted sum of meaning, readability and length, 0–1. */
  total: number;
}

/** One model output for a node, as recorded in the run log. */
export interface CandidateLog {
  variant: PromptVariantId;
  /** The prompt carried the meaning-retry instruction. */
  retryInstruction: boolean;
  /** This version was kept. */
  chosen: boolean;
  ms: number;
  scores: CandidateScores;
  missingEntities: string[];
  /** Of missingEntities, the key ones (absent in older logs). */
  missingKeyEntities?: string[];
  /** The model output (after example-label stripping), for offline replay. */
  text?: string;
  /** Meaning-check failure reasons of this version. */
  reasons: string[];
  /** Which checks failed (absent in logs before clarity-run-report/3). */
  failures?: MeaningFailure[];
  nliChecked: boolean;
  /** Glossary sentences that skipped the entailment requirement. */
  exemptedSentences: string[];
  /** Null when NLI did not run. */
  exemptionRate: number | null;
  nliMs: number | null;
  /** Of nliMs: premise ranking and pair scoring (absent in older logs). */
  nliRankMs?: number | null;
  nliScoreMs?: number | null;
  /**
   * This entry is the kept version with its copied-list lines removed (no
   * model call), because every version echoed the prompt.
   */
  echoStripped?: boolean;
}

/** How a node got its result in a run. */
/** 'heading': kept as written, never sent to the model; 'skipped': already simple. */
export type NodeSource = 'model' | 'cache' | 'heading' | 'skipped' | 'error';

/** Per-node entry of a run log. */
export interface NodeRunLog {
  nodeId: string;
  type: StoredResult['type'];
  /** The node's original text, for offline replay (absent in older logs). */
  originalText?: string;
  /**
   * The text the model and the meaning check got, when it differs from
   * originalText: citation markers and hatnotes removed
   * (lib/segmentation/clutter.ts). '' when the node was only a hatnote.
   */
  modelInput?: string;
  source: NodeSource;
  /** Variant of the kept version; null when the model did not produce it. */
  variantUsed: PromptVariantId | null;
  modelCalls: number;
  /** Model calls after the first one. */
  retries: number;
  ms: number;
  candidates: CandidateLog[];
  /**
   * Flesch-Kincaid grade of the text the model got (modelInput, else
   * originalText) and of the kept version as plain text; fkglAfter is null
   * when the node failed. Absent in logs before clarity-run-report/4.
   */
  fkglBefore?: number;
  fkglAfter?: number | null;
  /**
   * The first version failed only on unsupported sentences (low
   * contradiction, every entity kept), so no retry was made (meaning.ts
   * shouldRetry). Absent otherwise.
   */
  retrySkipped?: 'unsupported-only';
  /** Thesis category of the kept version (see MeaningSummary). */
  meaningStatus: MeaningStatus;
  /** Meaning check of the kept version (model or cache); absent when not checked. */
  meaning?: NodeMeaningLog;
}

/** Meaning fields of a kept version in the run log. */
export interface NodeMeaningLog extends StoredMeaning {
  /** Glossary exemptions; absent for a cache hit. */
  exemptedSentences?: string[];
  exemptionRate?: number | null;
  nliMs?: number | null;
}

/**
 * Thesis category of one node: 'passed'/'failed' when fully checked (SBERT +
 * NLI + entities), 'not-fully-checked' when a check fell back, 'excluded' for
 * headings, short texts and already-simple nodes, 'error' when it failed.
 */
export type MeaningStatus = 'passed' | 'failed' | 'not-fully-checked' | 'excluded' | 'error';

/** Meaning counts of one run or document; the pass rate is over fully checked nodes. */
export interface MeaningSummary {
  passed: number;
  failed: number;
  /** Checked, but without NLI or without the embedding model. */
  notFullyChecked: number;
  excluded: number;
  /** passed / (passed + failed); null when nothing was fully checked. */
  passRate: number | null;
  /** (passed + failed) / (passed + failed + notFullyChecked); null when nothing was eligible. */
  coverage: number | null;
  /** coverage ≥ THESIS_COVERAGE_MIN. */
  thesisGrade: boolean;
}

/** MeaningSummary of a run, plus its NLI time and glossary exemptions. */
export interface RunMeaningSummary extends MeaningSummary {
  /** Mean NLI ms per NLI-scored version; null when NLI never ran. */
  avgNliMs: number | null;
  /** Glossary exemptions over the kept versions. */
  exemptedSentences: number;
  /** exemptedSentences / NLI-scored sentences of the kept versions; null when none. */
  exemptionRate: number | null;
  /** NLI pairs scored and how many of them were truncated (absent in older logs). */
  nliPairs?: number;
  truncatedPairs?: number;
  /** Failure kinds of the failed kept versions (absent in logs before clarity-run-report/3). */
  failureBreakdown?: FailureBreakdown;
  /**
   * Kept versions checked in Lite mode, how many of them the LITE score did
   * not pass, and why. Lite results stay out of passRate (null for thesis
   * use); this is what a Lite run says instead. Absent in logs before
   * clarity-run-report/4.
   */
  liteChecked?: number;
  liteFailed?: number;
  liteFailureBreakdown?: FailureBreakdown;
}

/** Everything one simplification run did, for the downloadable run report. */
export interface RunLog {
  id: string;
  startedAt: number;
  finishedAt: number;
  cancelled: boolean;
  mode: RunMode;
  model: string;
  /**
   * Build and server of the run (absent in logs before clarity-run-report/4):
   * package.json version, git commit at build time (null when unknown) and
   * Ollama's /api/version (null when it didn't answer).
   */
  appVersion?: string;
  gitCommit?: string | null;
  ollamaVersion?: string | null;
  extraQuality: boolean;
  /** Quality mode setting and the mode used (absent in logs from before quality modes). */
  qualitySetting?: QualityModeSetting;
  qualityMode?: QualityMode;
  qualityModeReason?: string;
  /** NLI backend of this run; null when NLI never loaded. */
  nli?: {
    backend: NliBackendName;
    adapterVendor: string | null;
    /** Weights used (absent in logs before the fp16 experiment: q8). */
    dtype?: NliDtype;
    benchMs: number;
    predictedParagraphMs: number;
    /**
     * What this run measured, to compare with the prediction (absent in logs
     * before clarity-run-report/4; null when NLI never scored): mean NLI ms
     * per scored version (premise ranking included), and of that the pair
     * scoring and the premise ranking (all-minilm through Ollama).
     */
    measuredParagraphMs?: number | null;
    measuredScoreMs?: number | null;
    measuredRankMs?: number | null;
  } | null;
  targetGrade: number;
  depthTier: SimplificationSpec['depthTier'];
  /**
   * The reader's style and whether it allows bullets ('bullet-summary'
   * only); paragraph output is flattened to sentences otherwise. Absent in
   * logs before clarity-run-report/4.
   */
  style?: SimplificationSpec['style'];
  allowBullets?: boolean;
  qualityThreshold: number;
  weights: { meaning: number; readability: number; length: number };
  /** The meaning standard this run was judged by (lib/quality/config.ts). */
  meaningThresholds: {
    similarity: number;
    entailmentMin: number;
    contradictionMax: number;
    glossaryExemptionMaxRate: number;
    nliModel: string;
    /** Premise strategy, e.g. 'summac-sentences+pairs/top3' (absent in older logs). */
    premiseStrategy?: string;
    contradictionAggregation?: 'max' | 'best-entailing';
    /** NLI paragraph rule (absent in logs before clarity-run-report/3, which used 'A'). */
    paragraphRule?: NliParagraphRule;
    /** How hypotheses are formed (config NLI_HYPOTHESIS_CONTEXT; absent: each sentence alone). */
    hypothesisContext?: string;
    /** Minimum share of entities kept (config ENTITY_RECALL_MIN; absent: 1, every entity). */
    entityRecallMin?: number;
    /**
     * What decided pass/fail: 'combined-score' (the frozen scoreModels, since
     * 2026-10-19); absent: the AND of the thresholds above.
     */
    verdict?: 'combined-score';
    scoreModels?: { full: CombinedScoreModel; lite: CombinedScoreModel };
  };
  summary: {
    nodes: number;
    counts: Record<NodeSource, number>;
    totalSeconds: number;
    secondsPerNode: number | null;
    secondsPerModelNode: number | null;
    /** Seconds from run start to the first finished node; null if none. */
    firstResultSeconds: number | null;
    meaning: RunMeaningSummary;
  };
  nodes: NodeRunLog[];
}

/** One rendered block of simplified model output (see lib/render/format-output.ts). */
export type Block =
  | { kind: 'paragraph'; text: string }
  | {
      kind: 'list';
      ordered: boolean;
      items: string[];
      /** Nesting depth per item (sub-bullets); omitted when the list is flat. */
      depths?: number[];
    };

export interface SegmentedDocument {
  title: string;
  nodes: ContentNode[];
  contentHash: string;
}

/** One document in the Clarity store. */
export interface ClarityDocument {
  id: string;                           // crypto.randomUUID()
  source: 'page' | 'paste' | 'pdf';
  title: string;
  sourceUrl?: string;                   // pages only
  fileName?: string;                    // pdfs only
  createdAt: number;
  updatedAt: number;
  contentHash: string;                  // SHA-256 of textContent
  html: string;                         // sanitized HTML for segmentHtml
  textContent: string;
  report: ReadabilityReport | null;     // null until the app computes it
  results: StoredResult[];              // empty until first Simplify run
  simplifiedReport: ReadabilityReport | null;
  lastRunAt?: number;
  /** The last MAX_RUN_LOGS runs, oldest first (see lib/run/run-log.ts). */
  runLogs?: RunLog[];
}

/** Lightweight entry kept in docs:index for the sidebar list. */
export interface DocumentIndexEntry {
  id: string;
  title: string;
  source: 'page' | 'paste' | 'pdf';
  updatedAt: number;
  hasResults: boolean;
}

/** User's display preferences (dyslexia font, text size, focus mode). */
export interface DisplayPrefs {
  dyslexiaFont: boolean;
  textSize: 'normal' | 'large' | 'xlarge';
  focusMode: boolean;
}

/** A named profile plus the display prefs recommended with it. */
export interface ReadingPreset {
  id: PresetId;
  name: string;
  /** One line shown under the name on the Settings card. */
  description: string;
  profile: UserProfile;
  /** Focus mode is a personal choice, so presets leave it alone. */
  displayPrefs: Pick<DisplayPrefs, 'dyslexiaFont' | 'textSize'>;
}

/** Hash routes of the app tab (#/dashboard, #/reading, ...). */
export type NavPage = 'dashboard' | 'reading' | 'progress' | 'settings';

/** Capture progress written by the background worker to session `capture:status`. */
export interface CaptureStatus {
  state: 'extracting' | 'error';
  tabTitle?: string;
  error?: string;
  at: number;
}

/**
 * Which nodes a simplification run processes: `remaining` skips nodes already
 * `done` ("Simplify again"); `all` re-runs every node ("Re-simplify all").
 */
export type RunMode = 'remaining' | 'all';

/** Tab shown when the New document dialog opens. */
export type NewDocTab = 'paste' | 'pdf';
