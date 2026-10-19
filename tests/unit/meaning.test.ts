import { describe, it, expect, vi } from 'vitest';
import prereg from '../../eval/checker/PREREG.md?raw';
import {
  assessMeaning, buildRetryInstruction, candidatePasses, contradictionReason, driftReason,
  droppedEntityReason, echoLineReason, INSTRUCTION_ECHO_REASON, keyEntityTexts, lengthReason, mainPointReason,
  meaningScore, MEANING_RETRY_INSTRUCTION, NO_SENTENCES_REASON, pickBetterVersion, RETRY_OPENING, retryInputOf, shouldRetry,
  SCORE_MODELS, toStoredMeaning, unsupportedReason,
  type MeaningDeps, type ScoreModels,
} from '../../src/lib/quality/meaning';
import { NLI_FEATURES, sigmoid } from '../../src/lib/quality/checker';
import { RETRY_ECHO_PHRASES } from '../../src/lib/quality/echo';
import { COMBINED_SCORE_FULL, COMBINED_SCORE_LITE, CONTRADICTION_MAX, MAX_RETRY_REASONS } from '../../src/lib/quality/config';
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

/**
 * A transparent test model: means at "good" values, std 0.1, weights ±1, so
 * t = Σ ±(x − mean)/0.1 and a version passes when t ≥ 0 (score ≥ 0.5).
 */
const TEST: ScoreModels = {
  full: {
    id: 'full',
    features: ['sbert', 'entity', 'nliMin', 'contra', 'numbers'],
    means: [0.9, 1, 0.9, 0.1, 1],
    stds: [0.1, 0.1, 0.1, 0.1, 0.1],
    weights: [1, 1, 1, -1, 1],
    bias: 0,
    threshold: 0.5,
  },
  lite: {
    id: 'lite',
    features: ['sbert', 'entity', 'numbers'],
    means: [0.9, 1, 1],
    stds: [0.1, 0.1, 0.1],
    weights: [1, 1, 1],
    bias: 0,
    threshold: 0.5,
  },
};

/** TEST with the mainClaim feature added to FULL. */
const WITH_MAIN: ScoreModels = {
  ...TEST,
  full: { ...TEST.full, features: [...TEST.full.features, 'mainClaim'], means: [...TEST.full.means, 0.9], stds: [...TEST.full.stds, 0.1], weights: [...TEST.full.weights, 1] },
};

const assess = (simplified: string, d: MeaningDeps, models: ScoreModels = TEST, ents = ENTITIES) =>
  assessMeaning(ORIGINAL, simplified, ents, [], d, { models });

// ---------------------------------------------------------------------------
// The frozen values
// ---------------------------------------------------------------------------
describe('frozen combined score', () => {
  it('config.ts matches the JSON block of eval/checker/PREREG.md', () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(prereg.replace(/\r\n/g, '\n'));
    expect(block).not.toBeNull();
    const frozen = JSON.parse((block as RegExpExecArray)[1]);
    expect(frozen.full).toEqual(COMBINED_SCORE_FULL);
    expect(frozen.lite).toEqual(COMBINED_SCORE_LITE);
  });

  it('LITE uses no NLI feature, and the default models are the frozen ones', () => {
    expect(COMBINED_SCORE_LITE.features.some(f => NLI_FEATURES.has(f))).toBe(false);
    expect(SCORE_MODELS).toEqual({ full: COMBINED_SCORE_FULL, lite: COMBINED_SCORE_LITE });
  });

  it('passes a close, supported paraphrase and fails a contradicted one', async () => {
    const good = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.93, makeEntailment({ minEntailment: 0.95, maxContradiction: 0.01 })));
    expect(good).toMatchObject({ passed: true, scoreModel: 'full', reasons: [], failures: [] });
    const bad = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], deps(0.93, makeEntailment({
      minEntailment: 0.1, maxContradiction: 0.97, contradictedSentences: ['The war ended in 1945.'],
    })));
    expect(bad.passed).toBe(false);
    expect(bad.score).toBeLessThan(COMBINED_SCORE_FULL.threshold);
    expect(bad.reasons[0]).toBe(contradictionReason('The war ended in 1945.'));
  });
});

// ---------------------------------------------------------------------------
// assessMeaning — the combined score
// ---------------------------------------------------------------------------
describe('assessMeaning: combined score', () => {
  it('scores with the known formula and passes at the threshold', async () => {
    // z: sbert 0.2, entity 0, nliMin 0.5, contra −0.8 (weight −1), numbers 0 → t = 1.5
    const a = await assess(KEEPS, deps(0.92, makeEntailment()));
    expect(a.score).toBeCloseTo(sigmoid(1.5), 10);
    expect(a).toMatchObject({ passed: true, scoreModel: 'full', nliChecked: true, fullyChecked: true, reasons: [], failures: [] });
    expect(a.features).toMatchObject({ sbert: 0.92, entity: 1, nliMin: 0.95, contra: 0.02, numbers: 1 });
  });

  it('a strong feature can outweigh a weaker one (no hard per-check cutoff)', async () => {
    // sbert 0.85 failed the old SBERT ≥ 0.87 rule; here t = −0.5 + 0.5 + 0.8 = 0.8
    expect((await assess(KEEPS, deps(0.85, makeEntailment()))).passed).toBe(true);
  });

  it('drift alone: fails, named as drift', async () => {
    const a = await assess(KEEPS, deps(0.5, makeEntailment()));
    expect(a).toMatchObject({ passed: false, failures: ['similarity'], reasons: [driftReason(0.5)] });
  });

  it('a dropped key date: fails, named once although entity and numbers both drop', async () => {
    const a = await assess(DROPS, deps(0.92, makeEntailment()));
    expect(a.features).toMatchObject({ entity: 2 / 3, numbers: 0 });
    expect(a).toMatchObject({ passed: false, failures: ['entities'], reasons: ['You dropped the date 1945.'] });
  });

  it('a contradiction: fails, naming the contradicted sentence', async () => {
    const nli = makeEntailment({ maxContradiction: 0.9, contradictedSentences: ['The war ended in 1945.'] });
    const a = await assess(KEEPS, deps(0.92, nli));
    expect(a).toMatchObject({ passed: false, failures: ['contradiction'], reasons: [contradictionReason('The war ended in 1945.')] });
  });

  it('an unsupported sentence: fails, naming it; a contradicted one is not also called unsupported', async () => {
    expect(await assess(KEEPS, deps(0.92, UNSUPPORTED))).toMatchObject({
      passed: false, failures: ['unsupported'], reasons: [unsupportedReason('Germany gave up to the Allies in Berlin.')],
    });
    const both = makeEntailment({
      minEntailment: 0.1, maxContradiction: 0.9,
      contradictedSentences: ['The war ended in 1946.'], unsupportedSentences: ['The war ended in 1946.'],
    });
    const a = await assess(KEEPS, deps(0.92, both));
    // nliMin and contra both lower the score; the one bad sentence is named once, as contradicted
    expect(a.failures).toEqual(['unsupported', 'contradiction']);
    expect(a.reasons).toEqual([contradictionReason('The war ended in 1946.')]);
  });

  it('without a sentence below ENTAILMENT_MIN, names the least supported one', async () => {
    const nli = makeEntailment({
      minEntailment: 0.55,
      sentenceScores: [
        { sentence: 'The war ended in 1945.', entailment: 0.97, contradiction: 0.01, exempt: false },
        { sentence: 'Germany gave up to the Allies in Berlin.', entailment: 0.55, contradiction: 0.01, exempt: false },
      ],
    });
    const a = await assess(KEEPS, deps(0.6, nli));
    expect(a.reasons).toContain(unsupportedReason('Germany gave up to the Allies in Berlin.'));
  });

  it('orders reasons by how much each feature lowered the score', async () => {
    const nli = makeEntailment({
      minEntailment: 0.95, maxContradiction: 0.9, contradictedSentences: ['The war ended.'],
    });
    // contributions: numbers −10, contra −8, entity −3.3, sbert −1
    const a = await assess(DROPS, deps(0.8, nli));
    expect(a.reasons).toEqual(['You dropped the date 1945.', contradictionReason('The war ended.'), driftReason(0.8)]);
    expect(a.failures).toEqual(['similarity', 'entities', 'contradiction']);
  });

  it('a failed version always names a failure kind, even when no feature is below its mean', async () => {
    const strict: ScoreModels = { ...TEST, full: { ...TEST.full, threshold: 0.99 } };
    const a = await assess(KEEPS, deps(0.92, makeEntailment()), strict);
    expect(a.passed).toBe(false);
    expect(a.failures.length).toBeGreaterThan(0);
  });

  it('explains an output with no sentences', async () => {
    const a = await assessMeaning(ORIGINAL, '', [], [], deps(0.1, makeEntailment({ minEntailment: 0, sentences: 0 })), { models: TEST });
    expect(a.passed).toBe(false);
    expect(a.reasons).toContain(NO_SENTENCES_REASON);
  });

  it('computes entity recall over distinct entity texts', async () => {
    const a = await assess('Germany gave up.', deps(0.9, makeEntailment()), TEST, [...ENTITIES, entity('Germany', 'place')]);
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
    const a = await assess(KEEPS, deps(0.9, nli));
    expect(a).toMatchObject({ exemptedSentences: ['X means y.'], exemptionRate: 0.25, nliMs: 321, nliSentences: 4 });
  });
});

// ---------------------------------------------------------------------------
// assessMeaning — Lite and fallbacks (a check unavailable)
// ---------------------------------------------------------------------------
describe('assessMeaning: Lite and fallbacks', () => {
  it('without NLI (Lite mode or NLI unavailable), uses the LITE model and stays nliChecked false', async () => {
    const a = await assess(KEEPS, deps(0.92, null));
    expect(a).toMatchObject({
      scoreModel: 'lite', passed: true, nliChecked: false, fullyChecked: false, minEntailment: null, maxContradiction: null,
      exemptionRate: null, nliMs: null, nliSentences: 0,
    });
    expect(a.features).toMatchObject({ nliMin: null, nliMean: null, contra: null, mainClaim: null });
    expect(a.score).toBeCloseTo(sigmoid(0.2), 10);
    expect((await assess(DROPS, deps(0.92, null))).passed).toBe(false);
  });

  it('the frozen LITE path uses no NLI feature and never calls the main-claim check', async () => {
    const mainClaimEntailment = vi.fn(async () => ({ entailment: 0.9, weakest: null }));
    const a = await assessMeaning(ORIGINAL, KEEPS, ENTITIES, [], { ...deps(0.92, null), mainClaimEntailment });
    expect(a.scoreModel).toBe('lite');
    expect(a.nliChecked).toBe(false);
    expect(mainClaimEntailment).not.toHaveBeenCalled();
    expect(COMBINED_SCORE_LITE.features.every(f => !NLI_FEATURES.has(f))).toBe(true);
  });

  it('a FULL model with mainClaim asks for it only after NLI ran, with the claim indexes', async () => {
    const mainClaimEntailment = vi.fn(async () => ({ entailment: 0.95, weakest: 'x' }));
    const mainClaim = vi.fn(async () => [0]);
    await assess(KEEPS, { ...deps(0.92, null), mainClaim, mainClaimEntailment }, WITH_MAIN);
    expect(mainClaimEntailment).not.toHaveBeenCalled();
    const a = await assess(KEEPS, { ...deps(0.92, makeEntailment()), mainClaim, mainClaimEntailment }, WITH_MAIN);
    expect(mainClaimEntailment).toHaveBeenCalledWith(ORIGINAL, KEEPS, [0]);
    expect(a).toMatchObject({ scoreModel: 'full', features: { mainClaim: 0.95 } });
  });

  it('a failed main-claim check falls back to LITE; a lost main point is named', async () => {
    const failed = await assess(KEEPS, { ...deps(0.92, makeEntailment()), mainClaimEntailment: async () => null }, WITH_MAIN);
    expect(failed).toMatchObject({ scoreModel: 'lite', nliChecked: false });
    const lost = await assess(KEEPS, {
      ...deps(0.92, makeEntailment()),
      mainClaimEntailment: async () => ({ entailment: 0.05, weakest: 'The war ended in 1945.' }),
    }, WITH_MAIN);
    expect(lost).toMatchObject({ passed: false, failures: ['unsupported'], reasons: [mainPointReason('The war ended in 1945.')] });
  });

  it('without the embedding model, scores SBERT at its training mean and is not fully checked', async () => {
    const a = await assess(KEEPS, deps(null, makeEntailment()));
    expect(a).toMatchObject({ similarity: null, nliChecked: true, fullyChecked: false, scoreModel: 'full' });
    expect(a.score).toBeCloseTo(sigmoid(1.3), 10);
    expect((await assess(KEEPS, deps(null, UNSUPPORTED))).passed).toBe(false);
  });

  it('runs SBERT and NLI in parallel', async () => {
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
    const kept = await assessMeaning(original, 'Set up the call during PST with Anna next Monday.', zone, [], deps(0.9, makeEntailment()), { models: TEST });
    expect(kept.passed).toBe(true);
    const dropped = await assessMeaning(original, 'Set up the call with Anna next Monday.', zone, [], deps(0.9, makeEntailment()), { models: TEST });
    expect(dropped.reasons[0]).toBe('You dropped the time zone PST.');
  });

  it('quotes the failing sentence', () => {
    expect(unsupportedReason('Germany won.')).toBe('This sentence is not supported by the original: "Germany won."');
    expect(contradictionReason('It was 1918.')).toBe('This sentence contradicts the original: "It was 1918."');
    expect(mainPointReason('It ended the war.')).toBe('You lost the main point of the original: "It ended the war."');
  });

  it('states the similarity for drift, with no cutoff (the score decides)', () => {
    expect(driftReason(0.8234)).toBe('The meaning drifted from the original (similarity 0.82).');
  });

  it('says whether a version is too short or too long', () => {
    expect(lengthReason(0.32)).toBe('You left out too much of the original (your version has 32% of its words).');
    expect(lengthReason(1.8)).toBe('Your version is much longer than the original (180% of its words).');
  });
});

describe('buildRetryInstruction', () => {
  it('names missing items in quotes, in one sentence, and forbids a list', () => {
    expect(buildRetryInstruction({ missing: ['Roman', '1801'], reasons: [] })).toBe(
      `${RETRY_OPENING} left out "Roman" and "1801". Work them into your existing sentences; ` +
      'never output a list of names or numbers. Output only the rewritten text.',
    );
  });

  it(`names at most ${MAX_RETRY_REASONS} items in all, missing entities first, never as bullets`, () => {
    const text = buildRetryInstruction({
      missing: ['Roman', '43', '383', '410'],
      reasons: [droppedEntityReason('Roman', 'person'), driftReason(0.8)],
    });
    expect(text).toContain('"Roman", "43" and "383"');
    expect(text).not.toContain('"410"');
    expect(text).not.toContain('drifted');
    expect(text).not.toMatch(/^\s*- /m);
    expect(text).not.toContain('\n');
  });

  it('turns the other reasons into prose, without the dropped-entity strings', () => {
    const text = buildRetryInstruction({
      missing: ['1945'],
      reasons: [droppedEntityReason('1945', 'date'), unsupportedReason('It ended in Rome.')],
    });
    expect(text).toContain('left out "1945"');
    expect(text).toContain('Also fix this: This sentence is not supported by the original: "It ended in Rome."');
    expect(text).not.toContain('You dropped');
  });

  it('names a meaning change when nothing is missing', () => {
    expect(buildRetryInstruction({ missing: [], reasons: [driftReason(0.8)] })).toBe(
      `${RETRY_OPENING} changed the meaning. Fix this: The meaning drifted from the original (similarity 0.80). ` +
      'Output only the rewritten text.',
    );
  });

  it('is the base instruction without anything to name', () => {
    expect(buildRetryInstruction({ missing: [], reasons: [] })).toBe(`${MEANING_RETRY_INSTRUCTION} Output only the rewritten text.`);
  });

  it('a retry built from a failed assessment names its missing entity', async () => {
    const a = await assess(DROPS, deps(0.8, makeEntailment()));
    expect(retryInputOf(a).missing).toEqual(['1945']);
    expect(buildRetryInstruction(retryInputOf(a))).toContain('left out "1945"');
  });

  it('retryInputOf names no entities when no dropped entity is among the reasons', () => {
    const a = makeAssessment({ passed: false, missingEntities: ['Rome'], reasons: [driftReason(0.8)] });
    expect(retryInputOf(a).missing).toEqual([]);
  });

  it('every echo phrase of the current prompts occurs in the retry or entity instruction', () => {
    const retry = buildRetryInstruction({ missing: ['A'], reasons: [driftReason(0.8)] }).toLowerCase();
    const entityLine = 'keep these names, numbers and dates inside your sentences; do not list them separately';
    const current = RETRY_ECHO_PHRASES.filter(p => retry.includes(p) || entityLine.includes(p));
    expect(current).toEqual(expect.arrayContaining([
      'your last version', 'work them into your existing sentences', 'never output a list',
      'output only the rewritten text', 'do not list them separately',
    ]));
  });
});

describe('shouldRetry', () => {
  const failing = (over: Partial<import('../../src/types').MeaningAssessment>) =>
    makeAssessment({ passed: false, failures: ['unsupported'], maxContradiction: 0.05, entityRecall: 1, ...over });

  it('skips an unsupported-only failure with low contradiction and every entity kept', () => {
    expect(shouldRetry(failing({}))).toBe(false);
  });

  it('retries when contradiction reaches the limit, an entity is missing, or NLI did not run', () => {
    expect(shouldRetry(failing({ maxContradiction: CONTRADICTION_MAX }))).toBe(true);
    expect(shouldRetry(failing({ entityRecall: 0.9 }))).toBe(true);
    expect(shouldRetry(failing({ maxContradiction: null }))).toBe(true);
  });

  it('retries entities, contradiction, similarity and echo failures', () => {
    for (const kind of ['entities', 'contradiction', 'similarity', 'echo'] as const) {
      expect(shouldRetry(failing({ failures: [kind] }))).toBe(true);
      expect(shouldRetry(failing({ failures: ['unsupported', kind] }))).toBe(true);
    }
  });
});

describe('echo guard in assessMeaning', () => {
  const echoed = `${KEEPS}\n- 1945, Germany, Berlin, Allies`;

  it('fails a passing version that copied the entity list, with failure echo', async () => {
    const a = await assessMeaning(ORIGINAL, echoed, ENTITIES, [], deps(0.95, makeEntailment()), {
      models: TEST, echoGuard: true,
    });
    expect(a.echo).toBe(true);
    expect(a.passed).toBe(false);
    expect(a.failures).toEqual(['echo']);
    expect(a.reasons[0]).toBe(echoLineReason('- 1945, Germany, Berlin, Allies'));
    expect(toStoredMeaning(a).echo).toBe(true);
  });

  it('does not change the score: the guard only adds the echo condition', async () => {
    const on = await assessMeaning(ORIGINAL, echoed, ENTITIES, [], deps(0.95, makeEntailment()), { models: TEST, echoGuard: true });
    const off = await assessMeaning(ORIGINAL, echoed, ENTITIES, [], deps(0.95, makeEntailment()), { models: TEST });
    expect(on.score).toBe(off.score);
    expect(off.passed).toBe(true);
    expect(off.echo).toBe(false);
    expect(toStoredMeaning(off).echo).toBeUndefined();
  });

  it('fails a version that repeats the instruction wording', async () => {
    const a = await assessMeaning(ORIGINAL, `${KEEPS} Work them into your existing sentences.`, ENTITIES, [],
      deps(0.95, makeEntailment()), { models: TEST, echoGuard: true });
    expect(a.passed).toBe(false);
    expect(a.reasons).toContain(INSTRUCTION_ECHO_REASON);
  });
});

// ---------------------------------------------------------------------------
// meaningScore / pickBetterVersion / toStoredMeaning
// ---------------------------------------------------------------------------
describe('meaningScore', () => {
  it('is the combined score', () => {
    expect(meaningScore(makeAssessment({ score: 0.42 }))).toBe(0.42);
  });
});

describe('pickBetterVersion', () => {
  const version = (text: string, overrides = {}): MeaningCandidate => ({ text, meaning: makeAssessment(overrides) });

  it('prefers a passing version over a failing one with a higher score', () => {
    const first = version('first', { passed: false, score: 0.99 });
    const retry = version('retry', { passed: true, score: 0.6 });
    expect(pickBetterVersion(first, retry).text).toBe('retry');
  });

  it('keeps the higher combined score when both fail or both pass', () => {
    expect(pickBetterVersion(version('o', { passed: false, score: 0.3 }), version('r', { passed: false, score: 0.4 })).text).toBe('r');
    expect(pickBetterVersion(version('o', { score: 0.95 }), version('r', { score: 0.9 })).text).toBe('o');
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
  it('stores the verdict fields and the score, and leaves unmeasured ones out', () => {
    expect(toStoredMeaning(makeAssessment({
      similarity: null, minEntailment: null, maxContradiction: null, nliChecked: false, score: 0.61, scoreModel: 'lite',
    }))).toEqual({ entityRecall: 1, nliChecked: false, passed: true, reasons: [], failures: [], score: 0.61, scoreModel: 'lite' });
    expect(toStoredMeaning(makeAssessment())).toEqual({
      similarity: 0.92, entityRecall: 1, minEntailment: 0.95, maxContradiction: 0.02,
      nliChecked: true, passed: true, reasons: [], failures: [], score: 0.9, scoreModel: 'full',
    });
  });
});

// ---------------------------------------------------------------------------
// Entities: keep ratio, and key facts (main-claim numbers and dates)
// ---------------------------------------------------------------------------
describe('entity features', () => {
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
  const run = (simplified: string, d: MeaningDeps, original = PARIS, ents = ENTS) =>
    assessMeaning(original, simplified, ents, [], d, { models: TEST });

  it('key entities are the numbers and dates of the main-claim sentence only', () => {
    expect(keyEntityTexts(PARIS, ENTS, [0])).toEqual(['1889']);
    expect(keyEntityTexts(PARIS, ENTS, [2])).toEqual(['1930']);
    expect(keyEntityTexts(PARIS, ENTS, [0, 1, 2])).toEqual(['1889', 'two years', '1930']);
  });

  it('every number and date is key when the main claim cannot be located', () => {
    expect(keyEntityTexts(PARIS, ENTS, [7])).toEqual(['1889', 'two years', '1930']);
  });

  it('a dropped minor name lowers the keep ratio but not the numbers feature', async () => {
    const simplified = 'The Eiffel Tower in Paris was done in 1889 for a World Fair. It took two years. It was the tallest until 1930.';
    const a = await run(simplified, { ...ok(), mainClaim: firstSentence });
    expect(a.missingEntities).toEqual(['Maurice Koechlin']);
    expect(a.missingKeyEntities).toEqual([]);
    expect(a.features).toMatchObject({ entity: 5 / 6, numbers: 1 });
  });

  it('a dropped key date zeroes the numbers feature and is named first', async () => {
    const simplified = 'The Eiffel Tower in Paris was built for a World Fair by Maurice Koechlin over two years. It was the tallest until 1930.';
    const a = await run(simplified, { ...ok(), mainClaim: firstSentence });
    expect(a).toMatchObject({ passed: false, failures: ['entities'], missingKeyEntities: ['1889'], features: { numbers: 0 } });
    expect(a.reasons).toEqual([droppedEntityReason('1889', 'date')]);
  });

  it('a dropped number outside the main claim is minor', async () => {
    const simplified = 'The Eiffel Tower in Paris was done in 1889 for a World Fair by Maurice Koechlin over two years.';
    const a = await run(simplified, { ...ok(), mainClaim: firstSentence });
    expect(a).toMatchObject({ missingKeyEntities: [], features: { numbers: 1 } });
    expect(a.missingEntities).toEqual(['1930']);
  });

  it('without a main-claim dependency, a 1–2 sentence original is all main claim', async () => {
    const two = 'The bridge opened in 1893. It cost 4 million dollars to build.';
    const ents = [at(two, '1893', 'date'), at(two, '4 million', 'number')];
    const a = await run('The bridge opened in 1893.', ok(), two, ents);
    expect(a).toMatchObject({ passed: false, missingKeyEntities: ['4 million'], features: { numbers: 0.5 } });
  });

  it('key drops are named before minor ones', async () => {
    const a = await run('A tower was built for a fair.', { ...ok(), mainClaim: firstSentence });
    expect(a.reasons[0]).toBe(droppedEntityReason('1889', 'date'));
    expect(a.reasons).toContain(droppedEntityReason('Maurice Koechlin', 'person'));
  });
});
