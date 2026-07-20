import { describe, it, expect } from 'vitest';
import { syllableCount } from '../../src/lib/metrics/syllables';
import { computeReadabilityReport } from '../../src/lib/metrics/engine';
import { BASE_COMMON_WORDS } from '../../src/lib/metrics/common-words';

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
//
//   Derived formula values (verified by running the engine in Node, see scratch/compute_values.js):
//     FRE  = 206.835 − 1.015×(17/3) − 84.6×(17/17) = 116.483
//     FKGL = 0.39×(17/3) + 11.8 − 15.59            = −1.580
//     GFI  = 0.4×(17/3 + 0)                         = 2.267
//     SMOG = 1.0430×√0 + 3.1291                     = 3.129  (CW=0)
//     L    = (51/17)×100 = 300.00 letters per 100 words
//     S    = (3/17)×100  =  17.65 sentences per 100 words
//     CLI  = 0.0588×300 − 0.296×17.647 − 15.8      = −3.384
//     ARI  = 4.71×(51/17) + 0.5×(17/3) − 21.43     = −4.467
// ---------------------------------------------------------------------------
describe('metrics engine', () => {
  it('calculates all metrics for simple text (reference paragraph 1)', () => {
    const text = 'The cat sat on the mat. The dog ran in the park. Birds fly in the sky.';
    const report = computeReadabilityReport(text, BASE_COMMON_WORDS);

    // toBeCloseTo(x, 1) allows ±0.05; all expected values derived from the
    // hand-computed table above — not rounded further.
    expect(report.fleschReadingEase).toBeCloseTo(116.48, 1);
    expect(report.fleschKincaidGradeLevel).toBeCloseTo(-1.58, 1);
    expect(report.gunningFogIndex).toBeCloseTo(2.27, 1);
    expect(report.smogIndex).toBeCloseTo(3.13, 1);
    expect(report.colemanLiauIndex).toBeCloseTo(-3.38, 1);
    expect(report.automatedReadabilityIndex).toBeCloseTo(-4.47, 1);
  });

  it('calculates metrics for complex text (reference paragraph 2)', () => {
    // Verifies that the engine detects high-grade, jargon-heavy text correctly.
    // Exact pinned values are omitted here because the syllable heuristic's
    // ~5% error rate makes per-word precision less meaningful at this length;
    // directional assertions are sufficient.
    const text =
      'The implementation of sophisticated algorithmic methodologies necessitates ' +
      'comprehensive understanding of computational complexity theory. ' +
      'Professionals specializing in distributed systems architecture frequently ' +
      'encounter challenges regarding concurrent synchronization and transactional consistency.';
    const report = computeReadabilityReport(text, BASE_COMMON_WORDS);

    expect(report.fleschReadingEase).toBeLessThan(30);
    expect(report.fleschKincaidGradeLevel).toBeGreaterThan(15);
    expect(report.complexWordPercent).toBeGreaterThan(50);
    expect(report.estimatedGradeLevel).toBeGreaterThan(14);
  });
});
