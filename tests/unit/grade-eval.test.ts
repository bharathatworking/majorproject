import { afterEach, describe, it, expect, vi } from 'vitest';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dirtyFilesFromPorcelain, evaluateCriteria, formatMismatches, gradeItemId, isMixed, isNearCopyEdit, median,
  pairedBootstrap, pendingItems, planRunFile, provenanceGroups, provenanceMismatches, provenanceReportLines, quantile,
  runFileName, runFilePath, runsDir, selectGradeItems, supersededFileName,
  ARMS, BOOTSTRAP_RESAMPLES, CRITERIA, EVAL_OPTIONS, FILL_ORDER, GRADE_QUALITY_MODE, GRADE_TARGETS, PARA_MAX_ROWS,
  PARA_MIN_ROWS, PARAGRAPHS_PER_TARGET, PROVENANCE_FIELDS, SENTENCES_PER_TARGET,
  type BootstrapResult, type ProvenancedRecord, type RunProvenance, type SelectionInput,
} from '../../scripts/grade/lib';

// ─── Selection ────────────────────────────────────────────────────────────────

describe('selectGradeItems', () => {
  // Row r "reads at grade" r % 13; rows 0–99 are out of the pool (Prompt 10)
  const gradeOf = (rows: number[]) => Math.max(...rows.map(r => r % 13));
  const input: SelectionInput = {
    rowCount: 2000,
    inPool: r => r >= 100,
    sentenceLongEnough: r => r % 17 !== 0,
    windowOverlaps: rows => rows.includes(1500),
    alreadySimple: (rows, target) => gradeOf(rows) <= target,
  };

  it('fills every target with the pre-registered mix, seeded', () => {
    const a = selectGradeItems(input);
    expect(a).toEqual(selectGradeItems(input));
    expect(a.items).toHaveLength(GRADE_TARGETS.length * (SENTENCES_PER_TARGET + PARAGRAPHS_PER_TARGET));
    for (const t of GRADE_TARGETS) {
      expect(a.items.filter(i => i.target === t && i.kind === 'sent')).toHaveLength(SENTENCES_PER_TARGET);
      expect(a.items.filter(i => i.target === t && i.kind === 'para')).toHaveLength(PARAGRAPHS_PER_TARGET);
    }
  });

  it('never uses a row twice, a row outside the pool, a short sentence or an overlapping window', () => {
    const seen = new Set<number>();
    for (const item of selectGradeItems(input).items) {
      for (const r of item.rows) {
        expect(seen.has(r)).toBe(false);
        expect(r).toBeGreaterThanOrEqual(100);
        seen.add(r);
      }
      if (item.kind === 'sent') expect(item.rows[0] % 17).not.toBe(0);
      else expect(item.rows).not.toContain(1500);
    }
  });

  it('keeps only items above their target and counts the already simple ones', () => {
    const a = selectGradeItems(input);
    for (const item of a.items) expect(gradeOf(item.rows)).toBeGreaterThan(item.target);
    expect(Object.keys(a.alreadySimpleSentences).map(Number).sort((x, y) => x - y)).toEqual([...GRADE_TARGETS]);
    expect(a.alreadySimpleSentences[10]).toBeGreaterThan(0);
  });

  it('makes paragraphs of 3–5 consecutive rows', () => {
    for (const p of selectGradeItems(input).items.filter(i => i.kind === 'para')) {
      expect(p.rows.length).toBeGreaterThanOrEqual(PARA_MIN_ROWS);
      expect(p.rows.length).toBeLessThanOrEqual(PARA_MAX_ROWS);
      p.rows.forEach((r, i) => i > 0 && expect(r).toBe(p.rows[i - 1] + 1));
    }
  });

  it('fills the highest target first and throws when a bucket cannot be filled', () => {
    expect(FILL_ORDER[0]).toBe(10);
    expect(() => selectGradeItems({ ...input, alreadySimple: (_, t) => t >= 10 })).toThrow(/grade 10/);
  });

  it('names items by target, kind and rows', () => {
    expect(gradeItemId('sent', [7], 4)).toBe('g4-s-7');
    expect(gradeItemId('para', [7, 8, 9], 10)).toBe('g10-p-7-9');
  });
});

// ─── Measures ─────────────────────────────────────────────────────────────────

describe('measures', () => {
  it('calls an edit distance below 0.10 a near copy', () => {
    expect(isNearCopyEdit(0.0999)).toBe(true);
    expect(isNearCopyEdit(0.1)).toBe(false);
  });

  it('samples at temperature 0, seed 42', () => {
    expect(EVAL_OPTIONS).toEqual({ temperature: 0, seed: 42 });
  });
});

// ─── Statistics ───────────────────────────────────────────────────────────────

describe('statistics', () => {
  it('interpolates quantiles like numpy', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
  });

  it('bootstraps deterministically, with the mean inside the interval', () => {
    const diffs = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 1 : i % 7 === 0 ? -1 : 0));
    const a = pairedBootstrap(diffs);
    expect(a).toEqual(pairedBootstrap(diffs));
    expect(a.n).toBe(200);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
    expect(a.lo).toBeGreaterThan(0);
    expect(BOOTSTRAP_RESAMPLES).toBe(10_000);
  });

  it('gives a zero-width interval for constant differences', () => {
    const r = pairedBootstrap([0.5, 0.5, 0.5], 50);
    expect(r).toEqual({ n: 3, mean: 0.5, lo: 0.5, hi: 0.5 });
  });
});

// ─── Criteria ─────────────────────────────────────────────────────────────────

describe('evaluateCriteria', () => {
  const b = (mean: number, lo = mean, hi = mean): BootstrapResult => ({ n: 200, mean, lo, hi });
  const good = {
    hitDiff: b(0.2, 0.1, 0.3),
    meaningDiff: b(-0.03),
    entityDiff: b(-0.02),
    nearCopyRateC: 0.05,
    medianSecondsA: 10,
    medianSecondsC: 16,
  };

  it('adopts when every criterion holds, boundaries included', () => {
    const v = evaluateCriteria({ ...good, hitDiff: b(CRITERIA.minHitGain, 0.01, 0.3) });
    expect(v.criteria.every(c => c.met)).toBe(true);
    expect(v.adopt).toBe(true);
  });

  it('fails the primary criterion on a small gain or a CI touching 0', () => {
    expect(evaluateCriteria({ ...good, hitDiff: b(0.149, 0.05, 0.25) }).primaryMet).toBe(false);
    const v = evaluateCriteria({ ...good, hitDiff: b(0.2, 0, 0.4) });
    expect(v.primaryMet).toBe(false);
    expect(v.adopt).toBe(false);
  });

  it('fails each guardrail on its own', () => {
    const failed = (patch: Partial<typeof good>) =>
      evaluateCriteria({ ...good, ...patch }).criteria.filter(c => !c.met).map(c => c.id);
    expect(failed({ meaningDiff: b(-0.031) })).toEqual(['meaning']);
    expect(failed({ entityDiff: b(-0.021) })).toEqual(['entities']);
    expect(failed({ nearCopyRateC: 0.051 })).toEqual(['nearCopy']);
    expect(failed({ medianSecondsC: 16.1 })).toEqual(['time']);
    const v = evaluateCriteria({ ...good, nearCopyRateC: 0.2 });
    expect(v.primaryMet).toBe(true);
    expect(v.guardrailsMet).toBe(false);
    expect(v.adopt).toBe(false);
  });
});

// ─── Resume ───────────────────────────────────────────────────────────────────

describe('pendingItems', () => {
  it('skips done items of the same arm and refuses a changed prompt', () => {
    const wanted = [
      { arm: 'A', itemId: 'g4-s-1', promptHash: 'h1' },
      { arm: 'A', itemId: 'g4-s-2', promptHash: 'h2' },
    ];
    expect(pendingItems(wanted, [{ arm: 'A', itemId: 'g4-s-1', promptHash: 'h1' }])).toEqual([wanted[1]]);
    expect(pendingItems(wanted, [{ arm: 'C', itemId: 'g4-s-1', promptHash: 'x' }])).toEqual(wanted);
    expect(() => pendingItems(wanted, [{ arm: 'A', itemId: 'g4-s-2', promptHash: 'old' }])).toThrow(/prompt changed/);
  });
});

// ─── Run files ────────────────────────────────────────────────────────────────

describe('run files', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const smokeArg = 'eval/grade-targeting/runs/smoke';

  afterEach(() => vi.restoreAllMocks());

  it('gives the writer and the reader the same smoke run file for every arm', () => {
    for (const arm of ARMS) {
      const written = runFilePath(runsDir(root, { smoke: true }), arm);
      expect(runFilePath(runsDir(root, { runs: smokeArg }), arm)).toBe(written);
      expect(runFilePath(runsDir(root, { runs: join('eval', 'grade-targeting', 'runs', 'smoke') }), arm)).toBe(written);
      expect(runFilePath(runsDir(root, { runs: join(root, smokeArg) }), arm)).toBe(written);
      expect(isAbsolute(written)).toBe(true);
      expect(written.endsWith(join('eval', 'grade-targeting', 'runs', 'smoke', `arm-${arm}.jsonl`))).toBe(true);
    }
  });

  it('gives the writer and the reader the same pre-registered run file for every arm', () => {
    for (const arm of ARMS) {
      const written = runFilePath(runsDir(root), arm);
      expect(runFilePath(runsDir(root, { runs: null }), arm)).toBe(written);
      expect(runFilePath(runsDir(root, { runs: 'eval/grade-targeting/runs' }), arm)).toBe(written);
      expect(written).toBe(join(root, 'eval', 'grade-targeting', 'runs', runFileName(arm)));
    }
  });

  it('never reads the working directory', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('process.cwd() called');
    });
    for (const arm of ARMS) {
      expect(() => runFilePath(runsDir(root, { smoke: true }), arm)).not.toThrow();
      expect(() => runFilePath(runsDir(root, { runs: smokeArg }), arm)).not.toThrow();
    }
  });
});

// ─── Provenance ───────────────────────────────────────────────────────────────

describe('provenance', () => {
  const prov: RunProvenance = {
    arm: 'A',
    commit: 'a'.repeat(40),
    dirty: false,
    worktreeSha256: null,
    ollamaVersion: '0.35.0',
    model: 'qwen3:4b-instruct-2507-q4_K_M',
    modelDigest: 'd'.repeat(64),
    temperature: 0,
    seed: 42,
    think: false,
    qualityMode: GRADE_QUALITY_MODE,
    nliModel: 'Xenova/nli-deberta-v3-xsmall',
    itemsSha256: 'e'.repeat(64),
  };
  const rec = (itemId: string, provenance: RunProvenance | null = prov) => ({ itemId, provenance });
  /** A different value of the same type for each field. */
  const changed: { [K in keyof RunProvenance]: RunProvenance[K] } = {
    arm: 'C',
    commit: 'b'.repeat(40),
    dirty: true,
    worktreeSha256: 'f'.repeat(64),
    ollamaVersion: '0.36.0',
    model: 'qwen2.5:3b',
    modelDigest: 'c'.repeat(64),
    temperature: 0.7,
    seed: 7,
    think: null,
    qualityMode: 'lite',
    nliModel: 'other/nli',
    itemsSha256: '0'.repeat(64),
  };

  it('covers at least the required fields', () => {
    for (const f of ['commit', 'dirty', 'ollamaVersion', 'model', 'temperature', 'qualityMode', 'itemsSha256', 'arm'] as const) {
      expect(PROVENANCE_FIELDS).toContain(f);
    }
    expect(Object.keys(changed).sort()).toEqual([...PROVENANCE_FIELDS].sort());
  });

  it('appends when the provenance is the same', () => {
    const existing = [rec('g4-s-1'), rec('g4-s-2')];
    expect(planRunFile(existing, { ...prov }, false)).toEqual({ action: 'append', done: existing });
    expect(provenanceMismatches(prov, existing)).toEqual([]);
  });

  it.each(PROVENANCE_FIELDS)('refuses to append when %s differs, naming both values', field => {
    const current = { ...prov, [field]: changed[field] };
    const plan = planRunFile([rec('g4-s-1'), rec('g4-s-2')], current, false);
    expect(plan.action).toBe('refuse');
    if (plan.action !== 'refuse') return;
    expect(plan.mismatches).toEqual([{ field, file: JSON.stringify(prov[field]), current: JSON.stringify(changed[field]) }]);
    const text = formatMismatches(plan.mismatches);
    expect(text).toContain(field);
    expect(text).toContain(`file ${JSON.stringify(prov[field])}`);
    expect(text).toContain(`now ${JSON.stringify(changed[field])}`);
  });

  it('names every differing field against every provenance in the file, each file value once', () => {
    const other = { ...prov, ollamaVersion: '0.34.0' };
    const plan = planRunFile([rec('g4-s-1'), rec('g4-s-2', other), rec('g4-s-3', other)], { ...prov, seed: 7 }, false);
    expect(plan.action === 'refuse' && plan.mismatches).toEqual([
      { field: 'seed', file: '42', current: '7' },
      { field: 'ollamaVersion', file: '"0.34.0"', current: '"0.35.0"' },
    ]);
  });

  it('refuses to extend records that carry no provenance', () => {
    const legacy: Array<ProvenancedRecord & { itemId: string }> = [rec('g4-s-1', null), { itemId: 'g4-s-2' }];
    const plan = planRunFile(legacy, prov, false);
    expect(plan).toEqual({ action: 'refuse', mismatches: [{ field: 'provenance', file: '(not recorded)', current: 'recorded' }] });
  });

  it('starts fresh with --new-run, moving an existing file aside', () => {
    const existing = [rec('g4-s-1', { ...prov, commit: 'b'.repeat(40) })];
    expect(planRunFile(existing, prov, true)).toEqual({ action: 'fresh', archive: true });
    expect(planRunFile(null, prov, true)).toEqual({ action: 'fresh', archive: false });
    expect(supersededFileName('A', '2026-10-24T10:00:00.000Z')).toBe('arm-A.superseded-2026-10-24T10-00-00-000Z.jsonl');
    expect(supersededFileName('A', '2026-10-24T10:00:00.000Z')).not.toBe(runFileName('A'));
  });

  it('starts fresh without a file and appends to an empty one', () => {
    expect(planRunFile(null, prov, false)).toEqual({ action: 'fresh', archive: false });
    expect(planRunFile([], prov, false)).toEqual({ action: 'append', done: [] });
  });

  it('reads dirty files from git status -z, renames included', () => {
    const z = ' M src/a.ts\0?? scripts/new.mjs\0R  docs/new.md\0docs/old.md\0A  path with space.txt\0';
    expect(dirtyFilesFromPorcelain(z)).toEqual(['src/a.ts', 'scripts/new.mjs', 'docs/new.md', 'path with space.txt']);
    expect(dirtyFilesFromPorcelain('')).toEqual([]);
  });
});

describe('provenance in the report', () => {
  const prov = (commit: string): RunProvenance => ({
    arm: 'A', commit, dirty: false, worktreeSha256: null, ollamaVersion: '0.35.0',
    model: 'qwen3:4b-instruct-2507-q4_K_M', modelDigest: 'd'.repeat(64), temperature: 0, seed: 42, think: false,
    qualityMode: GRADE_QUALITY_MODE, nliModel: 'Xenova/nli-deberta-v3-xsmall', itemsSha256: 'e'.repeat(64),
  });
  const one = prov('1111111111112222');
  const two = prov('3333333333334444');

  it('states the commit and model tag of a single-provenance arm, without a warning', () => {
    const groups = provenanceGroups([{ provenance: one }, { provenance: { ...one } }]);
    expect(groups).toEqual([{ provenance: one, count: 2 }]);
    expect(isMixed(groups)).toBe(false);
    const md = provenanceReportLines([{ arm: 'A', groups }]).join('\n');
    expect(md).toContain('`111111111111`');
    expect(md).toContain('`qwen3:4b-instruct-2507-q4_K_M`');
    expect(md).not.toContain('MIXED');
  });

  it('flags a mixed file loudly instead of pooling it', () => {
    const records: ProvenancedRecord[] = [{ provenance: one }, { provenance: two }, { provenance: one }];
    const groups = provenanceGroups(records);
    expect(groups.map(g => g.count)).toEqual([2, 1]);
    expect(isMixed(groups)).toBe(true);
    const md = provenanceReportLines([{ arm: 'A', groups }]).join('\n');
    expect(md).toContain('MIXED PROVENANCE: arm A');
    expect(md).toContain('NOT pooled');
    expect(md).toContain('`111111111111`');
    expect(md).toContain('`333333333333`');
  });

  it('treats records without provenance as their own group', () => {
    const groups = provenanceGroups([{ provenance: one }, {}]);
    expect(isMixed(groups)).toBe(true);
    const legacy = provenanceReportLines([{ arm: 'A', groups: provenanceGroups([{}, { provenance: null }]) }]).join('\n');
    expect(legacy).toContain('carry no provenance');
    expect(legacy).not.toContain('MIXED');
  });
});
