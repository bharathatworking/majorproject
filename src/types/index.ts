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

export type UserProfile = {
  ageGroup: 'child' | 'teen' | 'adult';
  targetGradeLevel: number | 'auto';
  readingPurpose: 'general' | 'esl' | 'dyslexia-friendly' | 'expert-to-lay';
  domainFamiliarity: 'novice' | 'intermediate' | 'expert';
  preferredStyle: 'plain' | 'bullet-summary' | 'eli5' | 'concise';
};

export type SimplificationSpec = {
  targetGrade: number;
  depthTier: 'none' | 'light' | 'moderate' | 'aggressive';
  style: string;
  preserveEntities: boolean;
  maxSentenceLength: number;
  allowBullets: boolean;
  tone: string;
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

export interface SegmentedDocument {
  title: string;
  nodes: ContentNode[];
  contentHash: string;
}

export interface CacheEntry {
  report: ReadabilityReport;
  results: SimplificationResult[];
  timestamp: number;
}
