import { syllableCount } from './syllables';
import { isCommonWord } from './common-words';
import { countSentenceText, splitSentenceText } from '../utils/sentences';
import type { ReadabilityReport } from '../../types';

export function countWords(text: string): number {
  const matches = text.match(/\b\w+\b/g);
  return matches ? matches.length : 0;
}

/** Sentences for the formulas (lib/utils/sentences.ts: "10.2%" or "No. 5" is not a boundary). */
export function countSentences(text: string): number {
  return countSentenceText(text);
}

export function countCharacters(text: string): number {
  const matches = text.match(/[a-zA-Z]/g);
  return matches ? matches.length : 0;
}

export function computeReadabilityReport(text: string, customWords: Set<string> = new Set()): ReadabilityReport {
  const words = text.match(/\b[a-zA-Z]+\b/g) || [];
  const W = words.length || 1;
  const St = countSentences(text) || 1;
  const Ch = countCharacters(text);
  
  let Sy = 0;
  let CW = 0; // complex words (3+ syllables)
  let DW = 0; // difficult words (not in common words)
  let longSentences = 0;
  const uniqueWords = new Set<string>();

  for (const word of words) {
    const syllables = syllableCount(word);
    Sy += syllables;
    if (syllables >= 3) CW++;
    if (!isCommonWord(word, customWords)) DW++;
    uniqueWords.add(word.toLowerCase());
  }

  const sentences = splitSentenceText(text);
  for (const sentence of sentences) {
    if (countWords(sentence) > 20) longSentences++;
  }

  // Flesch Reading Ease = 206.835 − 1.015×(W/St) − 84.6×(Sy/W)
  const fleschReadingEase = 206.835 - 1.015 * (W / St) - 84.6 * (Sy / W);

  // Flesch-Kincaid Grade Level = 0.39×(W/St) + 11.8×(Sy/W) − 15.59
  const fleschKincaidGradeLevel = 0.39 * (W / St) + 11.8 * (Sy / W) - 15.59;

  // Gunning Fog Index = 0.4 × [(W/St) + 100×(CW/W)]
  const gunningFogIndex = 0.4 * ((W / St) + 100 * (CW / W));

  // SMOG Index = 1.0430 × sqrt(30 × CW_in_30_sentences) + 3.1291
  // Scale for texts < 30 sentences: CW * (30/St)
  const smogIndex = 1.0430 * Math.sqrt(CW * (30 / St)) + 3.1291;

  // Coleman-Liau Index = 0.0588×L − 0.296×S − 15.8
  const L = (Ch / W) * 100;
  const S = (St / W) * 100;
  const colemanLiauIndex = 0.0588 * L - 0.296 * S - 15.8;

  // ARI = 4.71×(Ch/W) + 0.5×(W/St) − 21.43
  const automatedReadabilityIndex = 4.71 * (Ch / W) + 0.5 * (W / St) - 21.43;

  // Dale-Chall Score = 0.1579×(DW/W×100) + 0.0496×(W/St), +3.6365 if DW% > 5%
  const dwPercent = (DW / W) * 100;
  let daleChallScore = 0.1579 * dwPercent + 0.0496 * (W / St);
  if (dwPercent > 5) daleChallScore += 3.6365;

  const estimatedGradeLevel = (fleschKincaidGradeLevel + gunningFogIndex + smogIndex + colemanLiauIndex + automatedReadabilityIndex) / 5;

  return {
    fleschReadingEase,
    fleschKincaidGradeLevel,
    gunningFogIndex,
    smogIndex,
    colemanLiauIndex,
    automatedReadabilityIndex,
    daleChallScore,
    avgSentenceLength: W / St,
    avgWordLength: Ch / W,
    complexWordPercent: (CW / W) * 100,
    longSentencePercent: (longSentences / St) * 100,
    typeTokenRatio: uniqueWords.size / W,
    jargonDensity: (DW / W) * 100,
    estimatedGradeLevel
  };
}
