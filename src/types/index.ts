export type ContentNode = {
  id: string;
  type: 'heading' | 'paragraph' | 'list' | 'list-item' | 'table' | 'blockquote';
  level?: number;
  text: string;
  children?: ContentNode[];
  entities?: Entity[];
  skipSimplification?: boolean;
};

export type Entity = {
  text: string;
  type: 'person' | 'org' | 'date' | 'number' | 'place' | 'other';
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
 * A SimplificationResult that has been persisted to storage.
 * Carries the node's structural type and heading level so the Reading page
 * can render it correctly (h2/h3 vs p vs blockquote vs li) without needing
 * to re-segment the HTML on every load.
 */
export interface StoredResult extends SimplificationResult {
  type: 'heading' | 'paragraph' | 'list-item' | 'blockquote';
  level?: number;
}

/** One rendered block of simplified model output (see lib/render/format-output.ts). */
export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

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
