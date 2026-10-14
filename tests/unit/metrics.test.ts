import { describe, it, expect } from 'vitest';
import { syllableCount } from '../../src/lib/metrics/syllables';
import { computeReadabilityReport } from '../../src/lib/metrics/engine';
import { BASE_COMMON_WORDS, isCommonWord, wordFormCandidates } from '../../src/lib/metrics/common-words';

// ---------------------------------------------------------------------------
// Syllable counter — reference word list with known correct counts
// The heuristic is ~90-95% accurate (documented in syllables.ts).
// These words are chosen to exercise the main code paths: short words,
// multi-syllable words, silent-e words, -ed/-ated endings.
// ---------------------------------------------------------------------------
describe('syllables', () => {
  it('counts syllables correctly', () => {
    // Length-≤3 shortcut
    expect(syllableCount('the')).toBe(1);
    expect(syllableCount('cat')).toBe(1);

    // Multi-syllable words — also validates that blanket '-ed' stripping
    // does NOT fire on '-ated' endings (would undercount by 1).
    expect(syllableCount('implementation')).toBe(5);  // im-ple-men-ta-tion
    expect(syllableCount('sophisticated')).toBe(5);   // so-phis-ti-ca-ted
    expect(syllableCount('algorithmic')).toBe(4);     // al-go-rith-mic
    expect(syllableCount('methodologies')).toBe(5);   // me-thod-ol-o-gies
    expect(syllableCount('necessitates')).toBe(5);    // ne-ces-si-ta-tes

    // Silent-e stripping
    expect(syllableCount('make')).toBe(1);   // consonant+e → stripped
    expect(syllableCount('nice')).toBe(1);

    // Syllabic -le endings (l excluded from silent-e strip)
    expect(syllableCount('table')).toBe(2);  // ta-ble
    expect(syllableCount('simple')).toBe(2); // sim-ple
  });
});

// ---------------------------------------------------------------------------
// Readability metrics engine
//
// Reference paragraph 1 (simple):
//   "The cat sat on the mat. The dog ran in the park. Birds fly in the sky."
//
//   Manually counted:
//     W  = 17 words
//     St = 3 sentences
//     Sy = 17 syllables  (all single-syllable words)
//     Ch = 51 alpha characters ([a-zA-Z] only — punctuation/spaces excluded)
//     CW = 0 complex words (none ≥3 syllables)
//     DW = 1 difficult word ("mat" is not in the 5k list; "birds" → "bird")
//
//   Derived formula values (verified by running the engine in Node):
//     FRE    = 206.835 − 1.015×(17/3) − 84.6×(17/17) = 116.483
//     FKGL   = 0.39×(17/3) + 11.8 − 15.59            = −1.580
//     GFI    = 0.4×(17/3 + 0)                         = 2.267
//     SMOG   = 1.0430×√0 + 3.1291                     = 3.129  (CW=0)
//     L      = (51/17)×100 = 300.00 letters per 100 words
//     S      = (3/17)×100  =  17.65 sentences per 100 words
//     CLI    = 0.0588×300 − 0.296×17.647 − 15.8      = −3.384
//     ARI    = 4.71×(51/17) + 0.5×(17/3) − 21.43     = −4.467
//     Jargon = 1/17×100                               = 5.882%
//     DC     = 0.1579×5.882 + 0.0496×(17/3) + 3.6365 = 4.846  (DW% > 5)
// ---------------------------------------------------------------------------
describe('metrics engine', () => {
  it('calculates all metrics for simple text (reference paragraph 1)', () => {
    const text = 'The cat sat on the mat. The dog ran in the park. Birds fly in the sky.';
    const report = computeReadabilityReport(text);

    // toBeCloseTo(x, 1) allows ±0.05; all expected values derived from the
    // hand-computed table above — not rounded further.
    expect(report.fleschReadingEase).toBeCloseTo(116.48, 1);
    expect(report.fleschKincaidGradeLevel).toBeCloseTo(-1.58, 1);
    expect(report.gunningFogIndex).toBeCloseTo(2.27, 1);
    expect(report.smogIndex).toBeCloseTo(3.13, 1);
    expect(report.colemanLiauIndex).toBeCloseTo(-3.38, 1);
    expect(report.automatedReadabilityIndex).toBeCloseTo(-4.47, 1);
    expect(report.jargonDensity).toBeCloseTo(5.88, 1);
    expect(report.daleChallScore).toBeCloseTo(4.85, 1);
  });

  it('calculates metrics for complex text (reference paragraph 2)', () => {
    // Verifies that the engine detects high-grade, jargon-heavy text correctly.
    // Exact grade-level values are omitted here because the syllable heuristic's
    // ~5% error rate makes per-word precision less meaningful at this length;
    // directional assertions are sufficient.
    //
    // Jargon: W = 28, St = 2, DW = 17. Common: the, of (×2), in, and,
    // understanding, theory, regarding, systems/professionals/challenges
    // (via -s form matching).
    //   Jargon = 17/28×100                          = 60.714%
    //   DC     = 0.1579×60.714 + 0.0496×14 + 3.6365 = 13.918
    const text =
      'The implementation of sophisticated algorithmic methodologies necessitates ' +
      'comprehensive understanding of computational complexity theory. ' +
      'Professionals specializing in distributed systems architecture frequently ' +
      'encounter challenges regarding concurrent synchronization and transactional consistency.';
    const report = computeReadabilityReport(text);

    expect(report.fleschReadingEase).toBeLessThan(30);
    expect(report.fleschKincaidGradeLevel).toBeGreaterThan(15);
    expect(report.complexWordPercent).toBeGreaterThan(50);
    expect(report.estimatedGradeLevel).toBeGreaterThan(14);
    expect(report.jargonDensity).toBeCloseTo(60.71, 1);
    expect(report.daleChallScore).toBeCloseTo(13.92, 1);
  });

  it('scores everyday text far below technical text on jargon', () => {
    // Only "mat" is outside the list: 1/11 words.
    //   DC = 0.1579×9.091 + 0.0496×(11/2) + 3.6365 = 5.345
    const simple = computeReadabilityReport('The cat sat on the mat. It was a sunny day.');
    const technical = computeReadabilityReport(
      'The implementation of sophisticated algorithmic methodologies necessitates ' +
        'comprehensive understanding of computational complexity theory.',
    );

    expect(simple.jargonDensity).toBeCloseTo(9.09, 1);
    expect(simple.daleChallScore).toBeCloseTo(5.35, 1);
    expect(technical.jargonDensity).toBeGreaterThan(4 * simple.jargonDensity);
    expect(technical.daleChallScore).toBeGreaterThan(simple.daleChallScore);
  });

  it('treats custom words as common', () => {
    const text = 'The cat sat on the mat. It was a sunny day.';
    expect(computeReadabilityReport(text, new Set(['mat'])).jargonDensity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Word-form matching — inflected forms count as common when a base form does
// ---------------------------------------------------------------------------
describe('word-form matching', () => {
  // Each surface form is absent from the list and only its base is present,
  // so these pass only through form matching (guarded by the first expect).
  it('matches -s, -es, -ed, -ing and -ly forms of common words', () => {
    for (const word of [
      'cups', 'lamps',                                // -s
      'brushes', 'puppies',                           // -es, -ies → y
      'climbed', 'smiled', 'hurried', 'hugged',       // -ed, -ed → e, -ied → y, doubled
      'smelling', 'waving', 'grabbing',               // -ing, -ing → e, doubled
      'warmly', 'angrily',                            // -ly, -ily → y
    ]) {
      expect(BASE_COMMON_WORDS.has(word), `${word} in list`).toBe(false);
      expect(isCommonWord(word), word).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isCommonWord('Climbed')).toBe(true);
    expect(isCommonWord('CUPS')).toBe(true);
  });

  it('applies form matching to custom words too', () => {
    expect(isCommonWord('kubernetes')).toBe(false);
    expect(isCommonWord('kubernetes', new Set(['kubernetes']))).toBe(true);
    expect(isCommonWord('containerized', new Set(['containerize']))).toBe(true);
  });

  it('rejects non-words and unknown bases', () => {
    expect(isCommonWord('xqzt')).toBe(false);
    expect(isCommonWord('xqzting')).toBe(false);
  });

  it('derives the expected base candidates', () => {
    expect(wordFormCandidates('running')).toEqual(['running', 'runn', 'run', 'runne']);
    expect(wordFormCandidates('cities')).toContain('city');
    expect(wordFormCandidates('carried')).toContain('carry');
    expect(wordFormCandidates('making')).toContain('make');
    expect(wordFormCandidates('happily')).toContain('happy');
    expect(wordFormCandidates('stopped')).toContain('stop');
  });

  it('never strips down to a one-letter base', () => {
    // "as" → "a" would be a bogus match; "bed" must not become "b".
    expect(wordFormCandidates('as')).toEqual(['as']);
    expect(wordFormCandidates('bed')).toEqual(['bed', 'be']);
  });
});
