import { describe, it, expect, vi } from 'vitest';
import {
  assessMeaning, buildRetryInstruction, candidatePasses, contradictionReason, driftReason,
  droppedEntityReason, keyEntityTexts, meaningScore, MEANING_RETRY_INSTRUCTION, NO_SENTENCES_REASON,
  pickBetterVersion, toStoredMeaning, unsupportedReason, type MeaningDeps,
} from '../../src/lib/quality/meaning';
import { MAX_RETRY_REASONS, SIMILARITY_THRESHOLD } from '../../src/lib/quality/config';
import { makeAssessment, makeEntailment } from '../mocks/fixtures';
import type { EntailmentCheck, Entity, MeaningCandidate } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORIGINAL = 'The war ended in 1945 when Germany surrendered to the Allies in Berlin.';
const KEEPS = 'The war ended in 1945. Germany gave up to the Allies in Berlin.';
const DROPS = 'The war ended. Germany gave up to the Allies in Berlin.';

function entity(text: string, type: Entity['type']): Entity {
  return { text, type, start: 0, end: text.length };
}
const ENTITIES = [entity('1945', 'date'), entity('Germany', 'place'), entity('Berlin', 'place')];

const UNSUPPORTED = makeEntailment({
  minEntailment: 0.1, unsupportedSentences: ['Germany gave up to the Allies in Berlin.'],
});

function deps(similarity: number | null, nli: EntailmentCheck | null): MeaningDeps {
  return { similarity: vi.fn(async () => similarity), entail: vi.fn(async () => nli) };
}

// ---------------------------------------------------------------------------
// assessMeaning — the thesis standard, every pass/fail combination
// ---------------------------------------------------------------------------
describe('assessMeaning: all three checks', () => {
  const cases = [
    { sbert: true,  entities: true,  nli: true,  passed: true },
    { sbert: false, entities: true,  nli: true,  passed: false },
    { sbert: true,  entities: false, nli: true,  passed: false },
    { sbert: true,  entities: true,  nli: false, passed: false },
    { sbert: false, entities: false, nli: true,  passed: false },
    { sbert: false, entities: true,  nli: false, passed: false },
    { sbert: true,  entities: false, nli: false, passed: false },
    { sbert: false, entities: false, nli: false, passed: false },
  ];

  it.each(cases)('SBERT $sbert, entities $entities, NLI $nli → passed $passed', async (c) => {
    const a = await assessMeaning(
      ORIGINAL,
      c.entities ? KEEPS : DROPS,
      ENTITIES,
      [],
      deps(c.sbert ? 0.92 : 0.8, c.nli ? makeEntailment() : UNSUPPORTED),
    );
    expect(a.passed).toBe(c.passed);
    expect(a.failures).toEqual([
      ...(c.sbert ? [] : ['similarity']),
      ...(c.entities ? [] : ['entities']),
      ...(c.nli ? [] : ['unsupported']),
    ]);
    expect(a.fullyChecked).toBe(true);
    expect(a.nliChecked).toBe(true);
    expect(a.reasons.length > 0).toBe(!c.passed);
  });

  it('passes at exactly the similarity threshold and fails just below', async () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.87);
    expect((await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.87, makeEntailment()))).passed).toBe(true);
    expect((await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.869, makeEntailment()))).passed).toBe(false);
  });

  it('fails on a contradiction alone, even when every sentence is entailed enough', async () => {
    const nli = makeEntailment({ maxContradiction: 0.21, contradictedSentences: ['The war ended in 1945.'] });
    const a = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.92, nli));
    expect(a.passed).toBe(false);
    expect(a.reasons).toEqual([contradictionReason('The war ended in 1945.')]);
  });

  it('names contradiction and unsupported separately when one version has both', async () => {
    const nli = makeEntailment({
      minEntailment: 0.1, maxContradiction: 0.9,
      contradictedSentences: ['The war ended in 1946.'],
      unsupportedSentences: ['The war ended in 1946.', 'Berlin is big.'],
    });
    const a = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.8, nli));
    expect(a.failures).toEqual(['similarity', 'unsupported', 'contradiction']);
  });

  it('counts a sentence that is only contradicted as contradiction, not unsupported', async () => {
    const nli = makeEntailment({
      minEntailment: 0.1, maxContradiction: 0.9,
      contradictedSentences: ['The war ended in 1946.'], unsupportedSentences: ['The war ended in 1946.'],
    });
    expect((await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.92, nli))).failures).toEqual(['contradiction']);
  });

  it('follows the NLI verdict: a tolerated neutral sentence (rule B) passes', async () => {
    const nli = makeEntailment({ minEntailment: 0.1, passed: true, toleratedSentences: ['Berlin is big.'] });
    const a = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.92, nli));
    expect(a).toMatchObject({ passed: true, failures: [], reasons: [] });
  });

  it('checks that did not run never fail', async () => {
    const a = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(null, null));
    expect(a).toMatchObject({ passed: true, failures: [] });
  });

  it('passes entailment and contradiction exactly at their limits', async () => {
    const nli = makeEntailment({ minEntailment: 0.5, maxContradiction: 0.2 });
    expect((await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.9, nli))).passed).toBe(true);
  });

  it('computes entity recall over distinct entity texts', async () => {
    const a = await assessMeaning(ORIGINAL, 'Germany gave up.', [...ENTITIES, entity('Germany', 'place')], [], deps(0.9, makeEntailment()));
    expect(a.missingEntities).toEqual(['1945', 'Berlin']);
    expect(a.entityRecall).toBeCloseTo(1 / 3);
  });

  it('gives the NLI check the raw output and the hinted words, and SBERT the plain text', async () => {
    const d = deps(0.9, makeEntailment());
    await assessMeaning(ORIGINAL, '- The war ended in 1945\n- Germany gave up in Berlin', ENTITIES, ['surrendered'], d);
    expect(d.entail).toHaveBeenCalledWith(ORIGINAL, '- The war ended in 1945\n- Germany gave up in Berlin', ['surrendered']);
    expect(d.similarity).toHaveBeenCalledWith(ORIGINAL, 'The war ended in 1945.\nGermany gave up in Berlin.');
  });

  it('carries the NLI exemptions and timing', async () => {
    const nli = makeEntailment({ exemptedSentences: ['X means y.'], exemptionRate: 0.25, ms: 321, sentences: 4 });
    const a = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.9, nli));
    expect(a).toMatchObject({ exemptedSentences: ['X means y.'], exemptionRate: 0.25, nliMs: 321, nliSentences: 4 });
  });
});

// ---------------------------------------------------------------------------
// assessMeaning — fallbacks (a check unavailable)
// ---------------------------------------------------------------------------
describe('assessMeaning: fallbacks', () => {
  it('without NLI, judges SBERT + entities and marks nliChecked false', async () => {
    const a = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.9, null));
    expect(a).toMatchObject({
      passed: true, nliChecked: false, fullyChecked: false, minEntailment: null, maxContradiction: null,
      exemptionRate: null, nliMs: null, nliSentences: 0,
    });
    expect((await assessMeaning(ORIGINAL, DROPS, ENTITIES, [], deps(0.9, null))).passed).toBe(false);
    expect((await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.8, null))).passed).toBe(false);
  });

  it('without the embedding model, judges entities + NLI and is not fully checked', async () => {
    const a = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(null, makeEntailment()));
    expect(a).toMatchObject({ passed: true, similarity: null, nliChecked: true, fullyChecked: false });
    expect((await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(null, UNSUPPORTED))).passed).toBe(false);
  });

  it('with neither, judges entities alone', async () => {
    expect((await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(null, null))).passed).toBe(true);
    expect((await assessMeaning(ORIGINAL, DROPS, ENTITIES, [], deps(null, null))).passed).toBe(false);
  });

  it('runs both checks in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = <T>(value: T) => async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return value;
    };
    await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], { similarity: slow(0.9), entail: slow(makeEntailment()) });
    expect(maxInFlight).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Reasons and the retry instruction
// ---------------------------------------------------------------------------
describe('reasons', () => {
  it('names a dropped entity by type', () => {
    expect(droppedEntityReason('1945', 'number')).toBe('You dropped the number 1945.');
    expect(droppedEntityReason('4 July 1776', 'date')).toBe('You dropped the date 4 July 1776.');
    expect(droppedEntityReason('Marie Curie', 'person')).toBe('You dropped the name Marie Curie.');
    expect(droppedEntityReason('Paris', 'place')).toBe('You dropped the place Paris.');
    expect(droppedEntityReason('UNESCO', 'org')).toBe('You dropped the organization UNESCO.');
    expect(droppedEntityReason('Magna Carta', 'other')).toBe('You dropped "Magna Carta".');
    expect(droppedEntityReason('PST', 'timezone')).toBe('You dropped the time zone PST.');
  });

  it('passes a kept time zone and names a dropped one as a time zone', async () => {
    const original = 'Please set up the call with Anna, who works in PST, for next Monday.';
    const zone = [entity('PST', 'timezone')];
    const kept = await assessMeaning(original, 'Set up the call during PST with Anna next Monday.', zone, [], deps(0.9, makeEntailment()));
    expect(kept.passed).toBe(true);
    const dropped = await assessMeaning(original, 'Set up the call with Anna next Monday.', zone, [], deps(0.9, makeEntailment()));
    expect(dropped.reasons[0]).toBe('You dropped the time zone PST.');
  });

  it('quotes the failing sentence', () => {
    expect(unsupportedReason('Germany won.')).toBe('This sentence is not supported by the original: "Germany won."');
    expect(contradictionReason('It was 1918.')).toBe('This sentence contradicts the original: "It was 1918."');
  });

  it('states the similarity and the threshold for drift', () => {
    expect(driftReason(0.8234)).toBe('The meaning drifted from the original (similarity 0.82, needs 0.87).');
  });

  it('orders reasons: entities, contradictions, unsupported, drift — without listing a sentence twice', async () => {
    const nli = makeEntailment({
      minEntailment: 0.01, maxContradiction: 0.9,
      contradictedSentences: ['The war ended.'],
      unsupportedSentences: ['The war ended.', 'Germany gave up to the Allies in Berlin.'],
    });
    const a = await assessMeaning(ORIGINAL, DROPS, ENTITIES, [], deps(0.8, nli));
    expect(a.reasons).toEqual([
      'You dropped the date 1945.',
      contradictionReason('The war ended.'),
      unsupportedReason('Germany gave up to the Allies in Berlin.'),
      driftReason(0.8),
    ]);
  });

  it('explains an output with no sentences', async () => {
    const nli = makeEntailment({ minEntailment: 0, sentences: 0 });
    const a = await assessMeaning(ORIGINAL, '', [], [], deps(0.1, nli));
    expect(a.reasons).toContain(NO_SENTENCES_REASON);
  });
});

describe('buildRetryInstruction', () => {
  it('names the specific reasons after the base instruction', () => {
    expect(buildRetryInstruction(['You dropped the number 1945.'])).toBe(
      `${MEANING_RETRY_INSTRUCTION} Fix these problems:\n- You dropped the number 1945.`,
    );
  });

  it(`names at most ${MAX_RETRY_REASONS} reasons, most important first`, () => {
    const text = buildRetryInstruction(['a', 'b', 'c', 'd']);
    expect(text).toContain('- a\n- b\n- c');
    expect(text).not.toContain('- d');
  });

  it('is the base instruction without reasons', () => {
    expect(buildRetryInstruction([])).toBe(MEANING_RETRY_INSTRUCTION);
  });
});

// ---------------------------------------------------------------------------
// meaningScore / pickBetterVersion / toStoredMeaning
// ---------------------------------------------------------------------------
describe('meaningScore', () => {
  it('multiplies similarity, entity recall and minimum entailment', () => {
    expect(meaningScore(makeAssessment({ similarity: 0.9, entityRecall: 0.5, minEntailment: 0.8 }))).toBeCloseTo(0.36);
  });

  it('leaves out parts that were not measured', () => {
    expect(meaningScore(makeAssessment({ similarity: null, entityRecall: 1, minEntailment: 0.8 }))).toBeCloseTo(0.8);
    expect(meaningScore(makeAssessment({ similarity: 0.9, entityRecall: 1, minEntailment: null }))).toBeCloseTo(0.9);
  });

  it('clamps a negative similarity to 0', () => {
    expect(meaningScore(makeAssessment({ similarity: -0.2 }))).toBe(0);
  });
});

describe('pickBetterVersion', () => {
  const version = (text: string, overrides = {}): MeaningCandidate => ({ text, meaning: makeAssessment(overrides) });

  it('prefers a passing version over a failing one with a higher score', () => {
    const first = version('first', { passed: false, similarity: 0.99 });
    const retry = version('retry', { passed: true, similarity: 0.88 });
    expect(pickBetterVersion(first, retry).text).toBe('retry');
  });

  it('keeps the higher meaning score when both fail or both pass', () => {
    expect(pickBetterVersion(version('o', { passed: false, minEntailment: 0.3 }), version('r', { passed: false, minEntailment: 0.4 })).text).toBe('r');
    expect(pickBetterVersion(version('o', { similarity: 0.95 }), version('r', { similarity: 0.9 })).text).toBe('o');
  });

  it('keeps the first version on a tie', () => {
    expect(pickBetterVersion(version('o'), version('r')).text).toBe('o');
  });

  it('treats an unchecked version as passing', () => {
    expect(candidatePasses({ text: 'x', meaning: null })).toBe(true);
    expect(candidatePasses(version('x', { passed: false }))).toBe(false);
  });
});

describe('toStoredMeaning', () => {
  it('stores the verdict fields and leaves unmeasured ones out', () => {
    expect(toStoredMeaning(makeAssessment({ similarity: null, minEntailment: null, maxContradiction: null, nliChecked: false })))
      .toEqual({ entityRecall: 1, nliChecked: false, passed: true, reasons: [], failures: [] });
    expect(toStoredMeaning(makeAssessment())).toEqual({
      similarity: 0.92, entityRecall: 1, minEntailment: 0.95, maxContradiction: 0.02,
      nliChecked: true, passed: true, reasons: [], failures: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Entity rule: minimum share kept, key facts (main-claim numbers and dates) always
// ---------------------------------------------------------------------------
describe('entity rule', () => {
  const at = (text: string, needle: string, type: Entity['type']): Entity => {
    const start = text.indexOf(needle);
    return { text: needle, type, start, end: start + needle.length };
  };
  const PARIS =
    'The Eiffel Tower was finished in 1889 for the World Fair in Paris. ' +
    'Maurice Koechlin\'s team designed and built it over two years. ' +
    'It was the tallest structure in the world until 1930.';
  const ENTS = [
    at(PARIS, 'Eiffel Tower', 'place'), at(PARIS, '1889', 'date'), at(PARIS, 'Paris', 'place'),
    at(PARIS, 'Maurice Koechlin', 'person'), at(PARIS, 'two years', 'date'), at(PARIS, '1930', 'date'),
  ];
  const ok = () => deps(0.92, makeEntailment());
  /** Main claim = the first sentence. */
  const firstSentence: MeaningDeps['mainClaim'] = async () => [0];

  it('key entities are the numbers and dates of the main-claim sentence only', () => {
    expect(keyEntityTexts(PARIS, ENTS, [0])).toEqual(['1889']);
    expect(keyEntityTexts(PARIS, ENTS, [2])).toEqual(['1930']);
    expect(keyEntityTexts(PARIS, ENTS, [0, 1, 2])).toEqual(['1889', 'two years', '1930']);
  });

  it('every number and date is key when the main claim cannot be located', () => {
    expect(keyEntityTexts(PARIS, ENTS, [7])).toEqual(['1889', 'two years', '1930']);
  });

  it('at a minimum of 0.8, a dropped minor name passes', async () => {
    const simplified = 'The Eiffel Tower in Paris was done in 1889 for a World Fair. It took two years. It was the tallest until 1930.';
    const a = await assessMeaning(PARIS, simplified, ENTS, [], { ...ok(), mainClaim: firstSentence }, { entityRecallMin: 0.8 });
    expect(a.missingEntities).toEqual(['Maurice Koechlin']);
    expect(a).toMatchObject({ passed: true, failures: [], reasons: [], missingKeyEntities: [] });
  });

  it('a dropped key number fails at any minimum, named first', async () => {
    const simplified = 'The Eiffel Tower in Paris was built for a World Fair by Maurice Koechlin over two years. It was the tallest until 1930.';
    const a = await assessMeaning(PARIS, simplified, ENTS, [], { ...ok(), mainClaim: firstSentence }, { entityRecallMin: 0.5 });
    expect(a).toMatchObject({ passed: false, failures: ['entities'], missingKeyEntities: ['1889'] });
    expect(a.reasons).toEqual([droppedEntityReason('1889', 'date')]);
  });

  it('a dropped number outside the main claim is minor', async () => {
    const simplified = 'The Eiffel Tower in Paris was done in 1889 for a World Fair by Maurice Koechlin over two years.';
    const a = await assessMeaning(PARIS, simplified, ENTS, [], { ...ok(), mainClaim: firstSentence }, { entityRecallMin: 0.8 });
    expect(a).toMatchObject({ passed: true, missingKeyEntities: [] });
    expect(a.missingEntities).toEqual(['1930']);
  });

  it('without a main-claim dependency, a 1–2 sentence original is all main claim', async () => {
    const two = 'The bridge opened in 1893. It cost 4 million dollars to build.';
    const ents = [at(two, '1893', 'date'), at(two, '4 million', 'number')];
    const a = await assessMeaning(two, 'The bridge opened in 1893.', ents, [], ok(), { entityRecallMin: 0.5 });
    expect(a).toMatchObject({ passed: false, missingKeyEntities: ['4 million'] });
  });

  it('below the minimum, minor drops are named after key ones', async () => {
    const simplified = 'A tower was built for a fair.';
    const a = await assessMeaning(PARIS, simplified, ENTS, [], { ...ok(), mainClaim: firstSentence }, { entityRecallMin: 0.8 });
    expect(a.reasons[0]).toBe(droppedEntityReason('1889', 'date'));
    expect(a.reasons).toContain(droppedEntityReason('Maurice Koechlin', 'person'));
  });
});
