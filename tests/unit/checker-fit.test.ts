import { describe, it, expect, vi } from 'vitest';
import fitSource from '../../scripts/checker/fit.mjs?raw';
import libSource from '../../scripts/checker/lib.ts?raw';
import {
  assertTrainingPath, auc, balancedWeights, chooseLambda, chooseThreshold, clusterBootstrap, fitLogistic,
  mulberry32, parsePlainCsv, rates, readTrainingFile, solve, standardiser, stratifiedGroupKFold, toPlainCsv,
  trainModel, predict, TRAINING_FILES, type Item,
} from '../../scripts/checker/lib';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** 40 items in 20 paragraph groups of 2, x = sbert separating the classes with noise. */
function toyItems(seed = 7): Item[] {
  const rand = mulberry32(seed);
  return Array.from({ length: 40 }, (_, i) => {
    const y = (i % 2) as 0 | 1;
    return {
      id: `i${i}`,
      group: `g${Math.floor(i / 2)}`,
      y,
      x: { sbert: (y ? 0.9 : 0.8) + (rand() - 0.5) * 0.12, lenRatio: 0.7 + (rand() - 0.5) * 0.4 },
    };
  });
}

const ROOT = 'C:\\repo';

// ─── Guard: the fit can't read the held-out set ──────────────────────────────

describe('training-file guard', () => {
  it('allows only the calibration features', () => {
    expect(TRAINING_FILES).toEqual(['eval/checker/features_calib.csv']);
    expect(assertTrainingPath(ROOT, 'eval/checker/features_calib.csv')).toBe('C:\\repo/eval/checker/features_calib.csv');
    expect(assertTrainingPath(ROOT, 'C:\\repo\\eval\\checker\\features_calib.csv')).toBe('C:\\repo/eval/checker/features_calib.csv');
  });

  it.each([
    'eval/model-bakeoff/labels_bakeoff.csv',
    'eval/checker/features_bakeoff.csv',
    'eval/model-bakeoff/blind_key.json',
    'eval/checker/../model-bakeoff/labels_bakeoff.csv',
    'C:\\repo\\eval\\model-bakeoff\\labels_bakeoff.csv',
    'D:\\elsewhere\\eval\\checker\\features_calib.csv',
  ])('refuses %s', (path) => {
    expect(() => assertTrainingPath(ROOT, path)).toThrow(/may read only/);
  });

  it('readTrainingFile refuses the bake-off labels before reading anything', async () => {
    const read = vi.fn(async () => 'id\n');
    await expect(readTrainingFile(ROOT, 'eval/model-bakeoff/labels_bakeoff.csv', read)).rejects.toThrow(/may read only/);
    await expect(readTrainingFile(ROOT, 'eval/checker/features_bakeoff.csv', read)).rejects.toThrow(/may read only/);
    expect(read).not.toHaveBeenCalled();
    await readTrainingFile(ROOT, 'eval/checker/features_calib.csv', read);
    expect(read).toHaveBeenCalledWith('C:\\repo/eval/checker/features_calib.csv');
  });

  it('fit.mjs and lib.ts never name the held-out files or the bake-off modules', () => {
    for (const src of [fitSource, libSource]) {
      expect(src).not.toMatch(/model-bakeoff|labels_bakeoff|features_bakeoff|blind_key|\/bakeoff\//);
    }
  });

  it('fit.mjs reads files only through readTrainingFile', () => {
    // One readFile use: the reader handed to readTrainingFile (plus its import)
    expect(fitSource).not.toMatch(/readFileSync|createReadStream|readJsonl/);
    expect(fitSource.match(/\breadFile\(/g)).toHaveLength(1);
    expect(fitSource).toMatch(/readTrainingFile\(ROOT, TRAINING, path => readFile\(path, 'utf8'\)\)/);
  });
});

// ─── Folds ────────────────────────────────────────────────────────────────────

describe('stratifiedGroupKFold', () => {
  it('keeps every group in one fold, covers every item once and is deterministic', () => {
    const items = toyItems();
    const folds = stratifiedGroupKFold(items, 5, 42);
    expect(folds.flat().sort((a, b) => a - b)).toEqual(items.map((_, i) => i));
    for (const fold of folds) {
      const groups = new Set(fold.map(i => items[i].group));
      for (const g of groups) expect(items.filter((it, i) => it.group === g && !fold.includes(i))).toHaveLength(0);
    }
    expect(stratifiedGroupKFold(items, 5, 42)).toEqual(folds);
  });

  it('balances the classes across folds', () => {
    const items = toyItems();
    for (const fold of stratifiedGroupKFold(items, 5, 42)) {
      expect(fold.filter(i => items[i].y === 1)).toHaveLength(4);
      expect(fold.filter(i => items[i].y === 0)).toHaveLength(4);
    }
  });
});

// ─── Logistic regression ──────────────────────────────────────────────────────

describe('logistic regression', () => {
  it('solves a linear system', () => {
    expect(solve([[2, 1], [1, 3]], [3, 5]).map(v => Number(v.toFixed(10)))).toEqual([0.8, 1.4]);
  });

  it('balanced weights give each class half the total weight', () => {
    const w = balancedWeights([1, 1, 1, 0]);
    expect(w).toEqual([4 / 6, 4 / 6, 4 / 6, 2]);
    expect(w[0] * 3).toBeCloseTo(w[3] * 1);
  });

  it('standardiser: population mean and std; a constant column gets std 1', () => {
    const { means, stds } = standardiser([[1, 5], [3, 5]]);
    expect(means).toEqual([2, 5]);
    expect(stds).toEqual([1, 1]);
  });

  it('a symmetric 1-feature problem has bias 0 and a positive weight that shrinks with λ', () => {
    const z = [[-1], [-0.5], [0.5], [1]];
    const y: (0 | 1)[] = [0, 1, 0, 1];
    const [b1, w1] = fitLogistic(z, y, 0.01);
    const [, w2] = fitLogistic(z, y, 1);
    expect(b1).toBeCloseTo(0, 6);
    expect(w1).toBeGreaterThan(w2);
    expect(w2).toBeGreaterThan(0);
  });

  it('meets the optimality condition (gradient 0) of the weighted, penalised objective', () => {
    const z = [[-1.2], [-0.3], [0.1], [0.8], [1.5]];
    const y: (0 | 1)[] = [0, 0, 1, 0, 1];
    const lambda = 0.1;
    const [b, w] = fitLogistic(z, y, lambda);
    const c = balancedWeights(y);
    const total = c.reduce((a, v) => a + v, 0);
    let gb = 0; let gw = lambda * w;
    z.forEach(([x], i) => {
      const p = 1 / (1 + Math.exp(-(b + w * x)));
      gb += (c[i] / total) * (p - y[i]);
      gw += (c[i] / total) * (p - y[i]) * x;
    });
    expect(Math.abs(gb)).toBeLessThan(1e-8);
    expect(Math.abs(gw)).toBeLessThan(1e-8);
  });

  it('a trained model separates the toy set and predicts through the app formula', () => {
    const items = toyItems();
    const model = trainModel(items, ['sbert'], 0.01);
    expect(model.weights[0]).toBeGreaterThan(0);
    const probs = items.map(i => predict(model, i));
    expect(auc(probs, items.map(i => i.y))).toBeGreaterThan(0.9);
    expect(trainModel(items, ['sbert'], 0.01)).toEqual(model);
  });

  it('chooseLambda returns one of the grid', () => {
    expect([0.01, 0.1, 1]).toContain(chooseLambda(toyItems(), ['sbert', 'lenRatio']));
  });
});

// ─── Metrics and threshold ────────────────────────────────────────────────────

describe('metrics', () => {
  it('rates: catch, false-fail and balanced accuracy (fail = not passes)', () => {
    const r = rates([true, false, false, true], [1, 1, 0, 0]);
    expect(r).toMatchObject({ falseFails: 1, caught: 1, falseFail: 0.5, catchRate: 0.5, bacc: 0.5 });
  });

  it('auc: perfect, inverted and ties', () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5], [1, 0])).toBe(0.5);
  });
});

describe('chooseThreshold', () => {
  const y: (0 | 1)[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
  const probs = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.7, 0.55, 0.6, 0.8, 0.9];

  it('takes the lowest false-fail with catch ≥ 90%', () => {
    const t = chooseThreshold(probs, y);
    expect(t.reached).toBe(true);
    // 9 of 10 unfaithful are below 0.525 (catch 90%) and no faithful is
    expect(t.threshold).toBeCloseTo(0.525, 6);
    expect(t.rates.catchRate).toBe(0.9);
    expect(t.rates.falseFail).toBe(0);
  });

  it('a higher catch target costs false-fails', () => {
    const t = chooseThreshold(probs, y, 1);
    expect(t.rates.catchRate).toBe(1);
    expect(t.threshold).toBeCloseTo(0.75, 6);
    expect(t.rates.falseFail).toBe(0.5);
  });

  it('falls back to the best balanced accuracy when the catch target is unreachable', () => {
    const t = chooseThreshold([0.5, 0.5, 0.9], [0, 1, 1], 0.9);
    // Every cut that fails the unfaithful 0.5 also fails the faithful 0.5; catch 100% is reachable
    expect(t.reached).toBe(true);
    const u = chooseThreshold([0.5, 0.5, 0.9], [0, 1, 1], 1.01);
    expect(u.reached).toBe(false);
    expect(u.rates.bacc).toBe(0.75);
  });
});

// ─── Bootstrap and CSV ────────────────────────────────────────────────────────

describe('clusterBootstrap', () => {
  it('is deterministic and brackets the statistic', () => {
    const groups = Array.from({ length: 30 }, (_, i) => `g${i}`);
    const values = groups.map((_, i) => i / 29);
    const mean = (idx: number[]) => idx.reduce((a, i) => a + values[i], 0) / idx.length;
    const ci = clusterBootstrap(groups, mean, 500, 42);
    expect(clusterBootstrap(groups, mean, 500, 42)).toEqual(ci);
    expect(ci[0]).toBeLessThan(0.5);
    expect(ci[1]).toBeGreaterThan(0.5);
  });
});

describe('plain CSV', () => {
  it('round-trips and refuses commas', () => {
    const text = toPlainCsv(['id', 'v'], [['a#real', 0.5], ['b', null]]);
    expect(parsePlainCsv(text)).toEqual([{ id: 'a#real', v: '0.5' }, { id: 'b', v: '' }]);
    expect(() => toPlainCsv(['id'], [['a,b']])).toThrow();
  });
});
