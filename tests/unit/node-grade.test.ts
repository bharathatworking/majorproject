import { describe, it, expect } from 'vitest';
import { estimateNodeGrade, isAlreadySimple } from '../../src/lib/metrics/node-grade';
import { computeReadabilityReport } from '../../src/lib/metrics/engine';

const EASY = 'The cat sat on the mat.';
const HARD =
  'The mitochondrial electron transport chain facilitates oxidative phosphorylation ' +
  'through chemiosmotic coupling across the inner membrane.';
const words = new Set<string>();

// ---------------------------------------------------------------------------
// estimateNodeGrade — same scale as the document report
// ---------------------------------------------------------------------------
describe('estimateNodeGrade', () => {
  it('matches the metrics engine estimate', () => {
    expect(estimateNodeGrade(HARD, words)).toBe(computeReadabilityReport(HARD, words).estimatedGradeLevel);
  });

  it('rates technical text above plain text', () => {
    expect(estimateNodeGrade(HARD, words)).toBeGreaterThan(estimateNodeGrade(EASY, words));
  });
});

// ---------------------------------------------------------------------------
// isAlreadySimple — skip rule for the run loop
// ---------------------------------------------------------------------------
describe('isAlreadySimple', () => {
  it('accepts plain text at a low target', () => {
    expect(isAlreadySimple(EASY, 4, words)).toBe(true);
  });

  it('rejects technical text at grade 8', () => {
    expect(isAlreadySimple(HARD, 8, words)).toBe(false);
  });

  it('counts a text exactly at the target as simple', () => {
    const grade = estimateNodeGrade(HARD, words);
    expect(isAlreadySimple(HARD, grade, words)).toBe(true);
    expect(isAlreadySimple(HARD, grade - 0.01, words)).toBe(false);
  });

  it('sends a one-word heading with long words to the model', () => {
    expect(isAlreadySimple('Photosynthesis', 12, words)).toBe(false);
  });
});
