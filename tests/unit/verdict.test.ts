import { describe, it, expect } from 'vitest';
import {
  entityVerdict, failureBreakdown, failuresFromReasons, formatFailureBreakdown, nliVerdict, MEANING_FAILURES,
} from '../../src/lib/quality/verdict';

// ---------------------------------------------------------------------------
// entityVerdict — minimum share kept, key facts always
// ---------------------------------------------------------------------------
describe('entityVerdict', () => {
  const entityTexts = ['1893', 'Paris', 'Eiffel', 'Gustave', 'France'];

  it('passes at exactly the minimum share and fails just below', () => {
    expect(entityVerdict({ entityTexts, missing: ['Gustave'], keyTexts: ['1893'], recallMin: 0.8 }))
      .toEqual({ passed: true, recall: 0.8, missingKey: [], missingMinor: ['Gustave'] });
    expect(entityVerdict({ entityTexts, missing: ['Gustave', 'France'], keyTexts: ['1893'], recallMin: 0.8 }).passed)
      .toBe(false);
  });

  it('fails on a missing key entity whatever the share', () => {
    expect(entityVerdict({ entityTexts, missing: ['1893'], keyTexts: ['1893'], recallMin: 0.5 }))
      .toMatchObject({ passed: false, missingKey: ['1893'], missingMinor: [] });
  });

  it('counts repeated texts once and passes without entities', () => {
    expect(entityVerdict({ entityTexts: ['Paris', 'Paris', 'Rome'], missing: ['Rome'], keyTexts: [], recallMin: 0.5 }).recall).toBe(0.5);
    expect(entityVerdict({ entityTexts: [], missing: [], keyTexts: [], recallMin: 1 })).toMatchObject({ passed: true, recall: 1 });
  });

  it('defaults to the config minimum (1 until calibrated)', () => {
    expect(entityVerdict({ entityTexts, missing: ['Gustave'], keyTexts: [] }).passed).toBe(false);
  });
});
import {
  contradictionReason, driftReason, droppedEntityReason, echoLineReason, INSTRUCTION_ECHO_REASON, NO_SENTENCES_REASON, unsupportedReason,
} from '../../src/lib/quality/meaning';
import type { SentenceScore } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const s = (sentence: string, entailment: number, contradiction = 0.01, exempt = false): SentenceScore =>
  ({ sentence, entailment, contradiction, exempt });

/** n entailed sentences named e0, e1, … */
const entailed = (n: number) => Array.from({ length: n }, (_, i) => s(`e${i}.`, 0.95));

const T = { entailmentMin: 0.5, contradictionMax: 0.2, neutralMinSentences: 6 };

// ---------------------------------------------------------------------------
// nliVerdict — paragraph rules A and B
// ---------------------------------------------------------------------------
describe('nliVerdict', () => {
  it('rule A passes when every sentence is entailed and none contradicted', () => {
    expect(nliVerdict(entailed(3), { ...T, rule: 'A' })).toEqual({
      passed: true, unsupported: [], contradicted: [], tolerated: [],
    });
  });

  it('rule A fails on one neutral sentence, even in a long paragraph', () => {
    const v = nliVerdict([...entailed(6), s('n.', 0.1)], { ...T, rule: 'A' });
    expect(v).toMatchObject({ passed: false, unsupported: ['n.'], tolerated: [] });
  });

  it('rule B tolerates one neutral sentence when there are 6 or more', () => {
    const v = nliVerdict([...entailed(5), s('n.', 0.1)], { ...T, rule: 'B' });
    expect(v).toEqual({ passed: true, unsupported: [], contradicted: [], tolerated: ['n.'] });
  });

  it('rule B does not tolerate a neutral sentence in a paragraph of 5', () => {
    const v = nliVerdict([...entailed(4), s('n.', 0.1)], { ...T, rule: 'B' });
    expect(v).toMatchObject({ passed: false, unsupported: ['n.'], tolerated: [] });
  });

  it('rule B does not tolerate two neutral sentences', () => {
    const v = nliVerdict([...entailed(5), s('n1.', 0.1), s('n2.', 0.2)], { ...T, rule: 'B' });
    expect(v).toMatchObject({ passed: false, unsupported: ['n1.', 'n2.'], tolerated: [] });
  });

  it('never allows a contradiction, under either rule, exempt or not', () => {
    for (const rule of ['A', 'B'] as const) {
      const v = nliVerdict([...entailed(6), s('c.', 0.9, 0.5, true)], { ...T, rule });
      expect(v).toMatchObject({ passed: false, contradicted: ['c.'] });
    }
  });

  it('rule B tolerates no contradicted sentence as its neutral one', () => {
    const v = nliVerdict([...entailed(6), s('c.', 0.1, 0.5)], { ...T, rule: 'B' });
    expect(v).toMatchObject({ passed: false, contradicted: ['c.'], unsupported: ['c.'], tolerated: [] });
  });

  it('exempt sentences skip the entailment requirement', () => {
    expect(nliVerdict([s('g.', 0.01, 0.01, true), ...entailed(1)], { ...T, rule: 'A' }).passed).toBe(true);
  });

  it('passes exactly at the limits', () => {
    expect(nliVerdict([s('x.', 0.5, 0.2)], { ...T, rule: 'A' }).passed).toBe(true);
    expect(nliVerdict([s('x.', 0.4999, 0.2)], { ...T, rule: 'A' }).passed).toBe(false);
    expect(nliVerdict([s('x.', 0.5, 0.2001)], { ...T, rule: 'A' }).passed).toBe(false);
  });

  it('fails an output with no sentences', () => {
    expect(nliVerdict([], { ...T, rule: 'B' }).passed).toBe(false);
  });

  it('uses the config thresholds by default', () => {
    expect(nliVerdict(entailed(2)).passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure breakdown
// ---------------------------------------------------------------------------
describe('failureBreakdown', () => {
  it('counts each kind once per failed version and skips passing ones', () => {
    const b = failureBreakdown([
      ['entities', 'unsupported'],
      ['similarity'],
      [],
      ['entities', 'entities'],
    ]);
    expect(b).toEqual({ similarity: 1, entities: 2, unsupported: 1, contradiction: 0, echo: 0, failedParagraphs: 3 });
    expect(formatFailureBreakdown(b)).toBe('similarity 1, entities 2, unsupported 1, contradiction 0, echo 0 (of 3 failed)');
  });

  it('classifies every reason the meaning check writes', () => {
    expect(failuresFromReasons([
      unsupportedReason('A.'), droppedEntityReason('1945', 'date'), driftReason(0.8),
      contradictionReason('B.'), droppedEntityReason('Magna Carta', 'other'), echoLineReason('- A, B, C, D'),
      INSTRUCTION_ECHO_REASON,
    ])).toEqual(MEANING_FAILURES);
    expect(failuresFromReasons([NO_SENTENCES_REASON])).toEqual(['unsupported']);
    expect(failuresFromReasons([])).toEqual([]);
  });
});
