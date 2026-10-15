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
  /** Every check that ran passed. */
  passed?: boolean;
  /** Why it failed, most important first; empty when it passed. */
  reasons?: string[];
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

/** Sentence-level NLI result for one simplified node (see lib/quality/nli.ts). */
export interface EntailmentCheck {
  /** Lowest entailment over the non-exempt sentences (0 when there are none). */
  minEntailment: number;
  /** Highest contradiction over all sentences, exempt ones included. */
  maxContradiction: number;
  /** Non-exempt sentences below ENTAILMENT_MIN, in order. */
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
  ms: number;
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
  /** Null when NLI did not run. */
  minEntailment: number | null;
  maxContradiction: number | null;
  nliChecked: boolean;
  /** SBERT, NLI and entities all ran. */
  fullyChecked: boolean;
  /** Every check that ran passed. */
  passed: boolean;
  /** Failure reasons, most important first. */
  reasons: string[];
  exemptedSentences: string[];
  /** Null when NLI did not run. */
  exemptionRate: number | null;
  /** NLI scoring time for this version; null when NLI did not run. */
  nliMs: number | null;
  /** NLI-scored sentences; 0 when NLI did not run. */
  nliSentences: number;
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
  /** Meaning-check failure reasons of this version. */
  reasons: string[];
  nliChecked: boolean;
  /** Glossary sentences that skipped the entailment requirement. */
  exemptedSentences: string[];
  /** Null when NLI did not run. */
  exemptionRate: number | null;
  nliMs: number | null;
}

/** How a node got its result in a run. */
export type NodeSource = 'model' | 'cache' | 'skipped' | 'error';

/** Per-node entry of a run log. */
export interface NodeRunLog {
  nodeId: string;
  type: StoredResult['type'];
  source: NodeSource;
  /** Variant of the kept version; null when the model did not produce it. */
  variantUsed: PromptVariantId | null;
  modelCalls: number;
  /** Model calls after the first one. */
  retries: number;
  ms: number;
  candidates: CandidateLog[];
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
}

/** Everything one simplification run did, for the downloadable run report. */
export interface RunLog {
  id: string;
  startedAt: number;
  finishedAt: number;
  cancelled: boolean;
  mode: RunMode;
  model: string;
  extraQuality: boolean;
  targetGrade: number;
  depthTier: SimplificationSpec['depthTier'];
  qualityThreshold: number;
  weights: { meaning: number; readability: number; length: number };
  /** The meaning standard this run was judged by (lib/quality/config.ts). */
  meaningThresholds: {
    similarity: number;
    entailmentMin: number;
    contradictionMax: number;
    glossaryExemptionMaxRate: number;
    nliModel: string;
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
