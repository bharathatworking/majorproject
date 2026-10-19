/**
 * Pure fitting and evaluation code for the combined meaning score
 * (scripts/checker/fit.mjs, test-heldout.mjs), tested in
 * tests/unit/checker-fit.test.ts. No new dependencies: logistic regression,
 * CV, threshold choice, metrics and the bootstrap are written out here.
 *
 * Design decisions:
 *  - Scoring goes through src/lib/quality/checker.ts (standardise,
 *    combinedScore), so the fit, the held-out test and the app run the same
 *    math.
 *  - Positive class = faithful (y = 1). Catch = unfaithful items scored
 *    below the threshold / unfaithful; false-fail = faithful items below it
 *    / faithful. Balanced accuracy = (catch + (1 − false-fail)) / 2.
 *  - Logistic regression: Newton's method with backtracking on
 *    (1/Σc) Σ c_i·logloss_i + (λ/2)‖w‖², intercept not penalised, balanced
 *    class weights c = n / (2·n_class). Features are standardised with the
 *    training fold's mean and population std (std 0 → 1).
 *  - Folds are stratified and grouped (a paragraph's real output and its
 *    injected copy always share a fold), seeded with mulberry32. Groups are
 *    shuffled, then placed largest first into the fold that keeps the class
 *    counts closest to their targets.
 *  - λ ∈ {0.01, 0.1, 1} by inner CV balanced accuracy at p = 0.5; ties go
 *    to the larger λ (simpler model).
 *  - Backward elimination by out-of-fold balanced accuracy at p = 0.5;
 *    the smallest subset of ≤ MAX_FEATURES within SELECTION_TOLERANCE of
 *    the best subset of ≤ MAX_FEATURES wins.
 *  - Threshold: among cut points with catch ≥ MIN_CATCH the lowest
 *    false-fail (then higher catch, then lower cut); if none reaches it, the
 *    best balanced accuracy, and `reached` is false.
 *  - Bootstrap CIs resample whole groups (paragraphs), 2000 times, seed 42,
 *    percentile 2.5–97.5; resamples where a metric is undefined are skipped.
 *  - The fit may read only TRAINING_FILES (readTrainingFile, with the reader
 *    injected so this file stays free of node: imports); any other path,
 *    the held-out set included, throws before anything is read. The stage 7
 *    rescale reads RESCALE_FILES (calibration data only) the same way.
 *  - Stage 7 rescale: the candidate total (score.ts) on the calibration
 *    items under the old meaning part (entity × sbert × nliMin, the
 *    meaningScore before the combined score) and the new one (the FULL
 *    combined score); readability and length are the same in both. The new
 *    QUALITY_THRESHOLD is the quantile match: as many items fall below it
 *    under the new total as fell below the old threshold under the old one.
 */

import { combinedScore, FEATURES, standardise } from '../../src/lib/quality/checker';
import { COMBINED_SCORE_FULL, WEIGHTS } from '../../src/lib/quality/config';
import { lengthScore, readabilityScore } from '../../src/lib/quality/score';
import { toPlainText } from '../../src/lib/render/format-output';
import type { CheckerFeature, CombinedScoreModel } from '../../src/types';

// ─── Config ───────────────────────────────────────────────────────────────────

export const SEED = 42;
export const FOLDS = 5;
export const LAMBDAS = [0.01, 0.1, 1] as const;
export const MAX_FEATURES = 6;
/** Prefer fewer features when within this much balanced accuracy (1 point). */
export const SELECTION_TOLERANCE = 0.01;
export const MIN_CATCH = 0.9;
export const BOOTSTRAP_RESAMPLES = 2000;
/** The only files the fit may read (repo-relative, forward slashes). */
export const TRAINING_FILES: readonly string[] = ['eval/checker/features_calib.csv'];
/**
 * What the stage 7 rescale (scripts/checker/rescale-quality.mjs) may read:
 * the calibration features plus the calibration outputs and originals.
 */
export const RESCALE_FILES: readonly string[] = [
  'eval/checker/features_calib.csv',
  'eval/nli-calibration/paragraph-items.jsonl',
  'eval/nli-calibration/paragraphs.jsonl',
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Item {
  id: string;
  /** Cluster for folds and the bootstrap (the paragraph). */
  group: string;
  /** 1 = faithful, 0 = unfaithful. */
  y: 0 | 1;
  x: Partial<Record<CheckerFeature, number>>;
}

export type FittedModel = Omit<CombinedScoreModel, 'id' | 'threshold'> & { lambda: number };

export interface Rates {
  n: number;
  nFaithful: number;
  nUnfaithful: number;
  /** Faithful items that fail. */
  falseFails: number;
  /** Unfaithful items that fail. */
  caught: number;
  falseFail: number;
  catchRate: number;
  bacc: number;
}

// ─── Guard ────────────────────────────────────────────────────────────────────

/** Forward slashes, no '.' or '..' segments, no leading or trailing slash. */
function normalisePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * The absolute path of a training file; throws unless `path` (absolute, or
 * relative to `root`) is one of `allowed` (TRAINING_FILES) once normalised.
 */
export function assertTrainingPath(root: string, path: string, allowed: readonly string[] = TRAINING_FILES): string {
  const r = normalisePath(root);
  const p = normalisePath(path);
  const absolute = /^(?:[a-zA-Z]:)?[\\/]/.test(path);
  const rel = absolute && p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p;
  if (absolute && rel === p) throw new Error(`[Clarity] this script may read only ${allowed.join(', ')}; refused: ${path}`);
  if (!allowed.includes(rel)) {
    throw new Error(`[Clarity] this script may read only ${allowed.join(', ')}; refused: ${rel}`);
  }
  return `${root.replace(/[\\/]+$/, '')}/${rel}`;
}

/**
 * Reads a training file with `read` (fs.readFile in fit.mjs); any path not
 * in `allowed` (TRAINING_FILES for the fit) is refused before `read` is
 * called (assertTrainingPath).
 */
export async function readTrainingFile(
  root: string,
  path: string,
  read: (absolutePath: string) => Promise<string>,
  allowed: readonly string[] = TRAINING_FILES,
): Promise<string> {
  return read(assertTrainingPath(root, path, allowed));
}

// ─── CSV (plain: no field may hold a comma, quote or line break) ─────────────

export function toPlainCsv(header: readonly string[], rows: readonly (readonly (string | number | boolean | null)[])[]): string {
  const cell = (v: string | number | boolean | null) => {
    const s = v === null ? '' : String(v);
    if (/[",\r\n]/.test(s)) throw new Error(`[Clarity] CSV value may not hold , " or a line break: ${s}`);
    return s;
  };
  return [header, ...rows].map(r => r.map(cell).join(',')).join('\n') + '\n';
}

export function parsePlainCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map(l => {
    const cells = l.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

// ─── Random ───────────────────────────────────────────────────────────────────

/** Deterministic uniform [0, 1) generator (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(array: readonly T[], rand: () => number): T[] {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Folds ────────────────────────────────────────────────────────────────────

/** k folds of item indexes; every group in one fold, class counts kept balanced. */
export function stratifiedGroupKFold(items: readonly Item[], k = FOLDS, seed = SEED): number[][] {
  const byGroup = new Map<string, number[]>();
  items.forEach((it, i) => byGroup.set(it.group, [...(byGroup.get(it.group) ?? []), i]));
  const groups = shuffled([...byGroup.entries()], mulberry32(seed))
    .sort((a, b) => b[1].length - a[1].length);
  const totals = [0, 1].map(c => items.filter(it => it.y === c).length);
  const target = totals.map(t => t / k);
  const counts = Array.from({ length: k }, () => [0, 0]);
  const folds: number[][] = Array.from({ length: k }, () => []);
  for (const [, idx] of groups) {
    const add = [0, 1].map(c => idx.filter(i => items[i].y === c).length);
    let best = 0;
    let bestCost = Infinity;
    for (let f = 0; f < k; f++) {
      // How much adding the group moves this fold's class counts towards (−) or past (+) their targets
      const cost = [0, 1].reduce((s, c) => s + (counts[f][c] + add[c] - target[c]) ** 2 - (counts[f][c] - target[c]) ** 2, 0);
      const size = folds[f].length;
      if (cost < bestCost - 1e-12 || (Math.abs(cost - bestCost) <= 1e-12 && size < folds[best].length)) {
        best = f;
        bestCost = cost;
      }
    }
    folds[best].push(...idx);
    counts[best][0] += add[0];
    counts[best][1] += add[1];
  }
  return folds.map(f => f.sort((a, b) => a - b));
}

// ─── Logistic regression ──────────────────────────────────────────────────────

/** Solves A·x = b (Gaussian elimination with partial pivoting). */
export function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-14) throw new Error('[Clarity] singular matrix in logistic fit');
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let j = c; j <= n; j++) m[r][j] -= f * m[c][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let j = r + 1; j < n; j++) s -= m[r][j] * x[j];
    x[r] = s / m[r][r];
  }
  return x;
}

/** Balanced class weights n / (2·n_class) (1 for a class that is absent). */
export function balancedWeights(y: readonly (0 | 1)[]): number[] {
  const n1 = y.filter(v => v === 1).length;
  const n0 = y.length - n1;
  return y.map(v => (v === 1 ? (n1 ? y.length / (2 * n1) : 1) : (n0 ? y.length / (2 * n0) : 1)));
}

const log1pexp = (t: number) => (t > 0 ? t + Math.log1p(Math.exp(-t)) : Math.log1p(Math.exp(t)));

/**
 * L2 logistic regression on standardised rows `z`; returns [bias, ...weights].
 * Objective in the file header.
 */
export function fitLogistic(z: readonly number[][], y: readonly (0 | 1)[], lambda: number, sampleWeights = balancedWeights(y)): number[] {
  const d = (z[0]?.length ?? 0) + 1;
  const rows = z.map(r => [1, ...r]);
  const total = sampleWeights.reduce((a, b) => a + b, 0);
  const loss = (theta: number[]) => {
    let s = 0;
    rows.forEach((r, i) => {
      const t = r.reduce((acc, v, j) => acc + v * theta[j], 0);
      s += sampleWeights[i] * (y[i] === 1 ? log1pexp(-t) : log1pexp(t));
    });
    return s / total + (lambda / 2) * theta.slice(1).reduce((a, w) => a + w * w, 0);
  };
  let theta = new Array<number>(d).fill(0);
  let current = loss(theta);
  for (let iter = 0; iter < 100; iter++) {
    const g = new Array<number>(d).fill(0);
    const h = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    rows.forEach((r, i) => {
      const t = r.reduce((acc, v, j) => acc + v * theta[j], 0);
      const p = 1 / (1 + Math.exp(-t));
      const c = sampleWeights[i] / total;
      for (let j = 0; j < d; j++) {
        g[j] += c * (p - y[i]) * r[j];
        for (let l = 0; l < d; l++) h[j][l] += c * p * (1 - p) * r[j] * r[l];
      }
    });
    for (let j = 1; j < d; j++) {
      g[j] += lambda * theta[j];
      h[j][j] += lambda;
    }
    h[0][0] += 1e-9;
    const step = solve(h, g);
    let scale = 1;
    let next = theta.map((v, j) => v - step[j]);
    let nextLoss = loss(next);
    while (nextLoss > current + 1e-15 && scale > 1e-8) {
      scale /= 2;
      next = theta.map((v, j) => v - scale * step[j]);
      nextLoss = loss(next);
    }
    const moved = Math.max(...step.map(s => Math.abs(s * scale)));
    theta = next;
    current = nextLoss;
    if (moved < 1e-10) break;
  }
  return theta;
}

/** Column means and population stds (0 → 1) of the rows. */
export function standardiser(x: readonly number[][]): { means: number[]; stds: number[] } {
  const d = x[0]?.length ?? 0;
  const means = Array.from({ length: d }, (_, j) => x.reduce((a, r) => a + r[j], 0) / x.length);
  const stds = means.map((m, j) => {
    const v = x.reduce((a, r) => a + (r[j] - m) ** 2, 0) / x.length;
    return v > 0 ? Math.sqrt(v) : 1;
  });
  return { means, stds };
}

function matrix(items: readonly Item[], features: readonly CheckerFeature[]): number[][] {
  return items.map(it => features.map(f => {
    const v = it.x[f];
    if (v === undefined || Number.isNaN(v)) throw new Error(`[Clarity] ${it.id}: feature ${f} missing`);
    return v;
  }));
}

/** Fits a model on `items` with the given features and λ. */
export function trainModel(items: readonly Item[], features: readonly CheckerFeature[], lambda: number): FittedModel {
  const x = matrix(items, features);
  const { means, stds } = standardiser(x);
  const z = x.map(r => standardise(r, means, stds));
  const [bias, ...weights] = fitLogistic(z, items.map(i => i.y), lambda);
  return { features: [...features], means, stds, weights, bias, lambda };
}

export function predict(model: FittedModel, item: Item): number {
  return combinedScore(model, item.x).score;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

/** Rates of pass verdicts (true = passes) against labels. */
export function rates(passes: readonly boolean[], y: readonly (0 | 1)[]): Rates {
  let nF = 0; let nU = 0; let ff = 0; let caught = 0;
  y.forEach((v, i) => {
    if (v === 1) { nF++; if (!passes[i]) ff++; } else { nU++; if (!passes[i]) caught++; }
  });
  const falseFail = nF ? ff / nF : NaN;
  const catchRate = nU ? caught / nU : NaN;
  return {
    n: y.length, nFaithful: nF, nUnfaithful: nU, falseFails: ff, caught,
    falseFail, catchRate, bacc: (catchRate + (1 - falseFail)) / 2,
  };
}

/** P(score of a faithful item > score of an unfaithful one), ties half (Mann–Whitney). */
export function auc(scores: readonly number[], y: readonly (0 | 1)[]): number {
  const pos = scores.filter((_, i) => y[i] === 1);
  const neg = scores.filter((_, i) => y[i] === 0);
  if (pos.length === 0 || neg.length === 0) return NaN;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

export const baccAt = (probs: readonly number[], y: readonly (0 | 1)[], threshold = 0.5) =>
  rates(probs.map(p => p >= threshold), y).bacc;

// ─── Threshold ────────────────────────────────────────────────────────────────

export interface ThresholdChoice {
  threshold: number;
  /** Catch ≥ minCatch was reachable. */
  reached: boolean;
  rates: Rates;
}

/** The pass threshold on probabilities (rule in the file header). */
export function chooseThreshold(probs: readonly number[], y: readonly (0 | 1)[], minCatch = MIN_CATCH): ThresholdChoice {
  const sorted = [...new Set(probs)].sort((a, b) => a - b);
  const cuts = [
    sorted[0] - 1e-6,
    ...sorted.slice(1).map((p, i) => (p + sorted[i]) / 2),
    sorted[sorted.length - 1] + 1e-6,
  ];
  const options = cuts.map(t => ({ threshold: t, rates: rates(probs.map(p => p >= t), y) }));
  const ok = options.filter(o => o.rates.catchRate >= minCatch - 1e-12);
  if (ok.length > 0) {
    ok.sort((a, b) => a.rates.falseFail - b.rates.falseFail || b.rates.catchRate - a.rates.catchRate || a.threshold - b.threshold);
    return { ...ok[0], reached: true };
  }
  options.sort((a, b) => b.rates.bacc - a.rates.bacc || b.rates.catchRate - a.rates.catchRate || a.threshold - b.threshold);
  return { ...options[0], reached: false };
}

// ─── Cross-validation ─────────────────────────────────────────────────────────

/** Out-of-fold probabilities with a fixed λ or one chosen by inner CV per fold. */
export function oofProbabilities(
  items: readonly Item[],
  features: readonly CheckerFeature[],
  lambda: number | 'inner',
  seed = SEED,
): number[] {
  const probs = new Array<number>(items.length).fill(NaN);
  for (const fold of stratifiedGroupKFold(items, FOLDS, seed)) {
    const inFold = new Set(fold);
    const train = items.filter((_, i) => !inFold.has(i));
    const l = lambda === 'inner' ? chooseLambda(train, features, seed) : lambda;
    const model = trainModel(train, features, l);
    for (const i of fold) probs[i] = predict(model, items[i]);
  }
  return probs;
}

/** λ with the best inner-CV balanced accuracy at p = 0.5; ties → the larger λ. */
export function chooseLambda(items: readonly Item[], features: readonly CheckerFeature[], seed = SEED): number {
  let best: number = LAMBDAS[LAMBDAS.length - 1];
  let bestScore = -Infinity;
  for (const l of [...LAMBDAS].reverse()) {
    const s = baccAt(oofProbabilities(items, features, l, seed), items.map(i => i.y));
    if (s > bestScore + 1e-12) {
      best = l;
      bestScore = s;
    }
  }
  return best;
}

export interface EliminationStep {
  features: CheckerFeature[];
  bacc: number;
  removed: CheckerFeature | null;
}

export interface Selection {
  features: CheckerFeature[];
  bacc: number;
  path: EliminationStep[];
}

/** Backward elimination (rules in the file header). */
export function backwardEliminate(items: readonly Item[], start: readonly CheckerFeature[], seed = SEED): Selection {
  const y = items.map(i => i.y);
  const score = (fs: readonly CheckerFeature[]) => baccAt(oofProbabilities(items, fs, 'inner', seed), y);
  let current = [...start];
  const path: EliminationStep[] = [{ features: [...current], bacc: score(current), removed: null }];
  while (current.length > 1) {
    let bestDrop: CheckerFeature | null = null;
    let bestScore = -Infinity;
    for (const f of current) {
      const s = score(current.filter(g => g !== f));
      if (s > bestScore + 1e-12) {
        bestScore = s;
        bestDrop = f;
      }
    }
    current = current.filter(g => g !== bestDrop);
    path.push({ features: [...current], bacc: bestScore, removed: bestDrop });
  }
  const eligible = path.filter(p => p.features.length <= MAX_FEATURES);
  const top = Math.max(...eligible.map(p => p.bacc));
  const pick = eligible
    .filter(p => p.bacc >= top - SELECTION_TOLERANCE - 1e-12)
    .sort((a, b) => a.features.length - b.features.length || b.bacc - a.bacc)[0];
  return { features: pick.features, bacc: pick.bacc, path };
}

export interface Pipeline {
  model: FittedModel;
  threshold: ThresholdChoice;
  selection: Selection;
  /** Out-of-fold probabilities of the chosen features on these items (threshold source). */
  oof: number[];
}

/** The whole procedure on one training set: select, choose λ, threshold, refit. */
export function fitPipeline(items: readonly Item[], start: readonly CheckerFeature[], seed = SEED): Pipeline {
  const selection = backwardEliminate(items, start, seed);
  const oof = oofProbabilities(items, selection.features, 'inner', seed);
  const threshold = chooseThreshold(oof, items.map(i => i.y));
  const lambda = chooseLambda(items, selection.features, seed);
  return { model: trainModel(items, selection.features, lambda), threshold, selection, oof };
}

export interface NestedResult {
  /** Outer-fold probability and verdict per item (aligned with the items). */
  probs: number[];
  passes: boolean[];
  /** What each outer fold chose. */
  folds: { features: CheckerFeature[]; lambda: number; threshold: number; reached: boolean; test: number[] }[];
}

/** Nested CV: the whole pipeline inside each outer fold, scored on the held-out fold. */
export function nestedCv(items: readonly Item[], start: readonly CheckerFeature[], seed = SEED): NestedResult {
  const probs = new Array<number>(items.length).fill(NaN);
  const passes = new Array<boolean>(items.length).fill(false);
  const folds: NestedResult['folds'] = [];
  for (const fold of stratifiedGroupKFold(items, FOLDS, seed)) {
    const inFold = new Set(fold);
    const p = fitPipeline(items.filter((_, i) => !inFold.has(i)), start, seed);
    for (const i of fold) {
      probs[i] = predict(p.model, items[i]);
      passes[i] = probs[i] >= p.threshold.threshold;
    }
    folds.push({
      features: p.model.features as CheckerFeature[], lambda: p.model.lambda,
      threshold: p.threshold.threshold, reached: p.threshold.reached, test: fold,
    });
  }
  return { probs, passes, folds };
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/** Percentile 95% CI of `stat` over cluster bootstrap resamples (groups with replacement). */
export function clusterBootstrap(
  groups: readonly string[],
  stat: (indexes: number[]) => number,
  resamples = BOOTSTRAP_RESAMPLES,
  seed = SEED,
): [number, number] {
  const byGroup = new Map<string, number[]>();
  groups.forEach((g, i) => byGroup.set(g, [...(byGroup.get(g) ?? []), i]));
  const ids = [...byGroup.keys()];
  const rand = mulberry32(seed);
  const values: number[] = [];
  for (let b = 0; b < resamples; b++) {
    const idx: number[] = [];
    for (let k = 0; k < ids.length; k++) idx.push(...(byGroup.get(ids[Math.floor(rand() * ids.length)]) as number[]));
    const v = stat(idx);
    if (!Number.isNaN(v)) values.push(v);
  }
  values.sort((a, b) => a - b);
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * (values.length - 1))))];
  return [at(0.025), at(0.975)];
}

export interface MetricWithCi {
  value: number;
  ci: [number, number];
}

export interface Evaluation {
  rates: Rates;
  bacc: MetricWithCi;
  catchRate: MetricWithCi;
  falseFail: MetricWithCi;
  auc: MetricWithCi;
}

/** Rates and AUC with cluster-bootstrap CIs; `scores` rank items for the AUC. */
export function evaluate(
  passes: readonly boolean[],
  scores: readonly number[],
  y: readonly (0 | 1)[],
  groups: readonly string[],
  resamples = BOOTSTRAP_RESAMPLES,
  seed = SEED,
): Evaluation {
  const r = rates(passes, y);
  const sub = <T>(xs: readonly T[], idx: number[]) => idx.map(i => xs[i]);
  const ci = (f: (idx: number[]) => number) => clusterBootstrap(groups, f, resamples, seed);
  return {
    rates: r,
    bacc: { value: r.bacc, ci: ci(idx => rates(sub(passes, idx), sub(y, idx)).bacc) },
    catchRate: { value: r.catchRate, ci: ci(idx => rates(sub(passes, idx), sub(y, idx)).catchRate) },
    falseFail: { value: r.falseFail, ci: ci(idx => rates(sub(passes, idx), sub(y, idx)).falseFail) },
    auc: { value: auc(scores, y), ci: ci(idx => auc(sub(scores, idx), sub(y, idx))) },
  };
}

// ─── Stage 7 rescale ──────────────────────────────────────────────────────────

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The stage 7 meaning part before the combined score: entity recall × similarity × minimum entailment. */
export function legacyMeaningPart(x: Partial<Record<CheckerFeature, number>>): number {
  return (x.entity ?? 1) * clamp01(x.sbert ?? 1) * clamp01(x.nliMin ?? 1);
}

export interface Stage7Total {
  id: string;
  /** Total with the old meaning part (legacyMeaningPart). */
  oldTotal: number;
  /** Total with the new meaning part (FULL combined score). */
  newTotal: number;
}

/**
 * The stage 7 total (score.ts scoreCandidate) of every feature row under the
 * old and the new meaning part. `gradeOf` is the node grade of a plain text
 * (estimateNodeGrade with the word set); the grade gap is to the item's
 * target grade, and an empty output scores 0 for readability, as in the app.
 */
export function stage7Totals(
  rows: readonly Record<string, string>[],
  simplifiedById: ReadonlyMap<string, string>,
  targetGradeById: ReadonlyMap<string, number>,
  gradeOf: (plain: string) => number,
): Stage7Total[] {
  return rows.map(r => {
    const simplified = simplifiedById.get(r.id);
    const target = targetGradeById.get(r.id);
    if (simplified === undefined || target === undefined) throw new Error(`[Clarity] ${r.id}: no simplified text or target grade`);
    const x = Object.fromEntries(FEATURES.map(f => [f, Number(r[f])])) as Record<CheckerFeature, number>;
    const plain = toPlainText(simplified);
    const hasWords = plain.trim().split(/\s+/).filter(Boolean).length > 0;
    const rest = WEIGHTS.readability * (hasWords ? readabilityScore(gradeOf(plain) - target) : 0)
      + WEIGHTS.length * lengthScore(x.lenRatio);
    return {
      id: r.id,
      oldTotal: WEIGHTS.meaning * legacyMeaningPart(x) + rest,
      newTotal: WEIGHTS.meaning * combinedScore(COMBINED_SCORE_FULL, x).score + rest,
    };
  });
}

/** Share of totals strictly below `threshold` (the "Extra quality" trigger, total < QUALITY_THRESHOLD). */
export function belowShare(totals: readonly number[], threshold: number): number {
  return totals.length ? totals.filter(t => t < threshold).length / totals.length : NaN;
}

export interface QuantileMatch {
  threshold: number;
  /** Items below the old threshold under the old totals. */
  k: number;
  oldShare: number;
  /** Share below `threshold` under the new totals (equals oldShare unless ties prevent it). */
  newShare: number;
}

/**
 * The new threshold with as many new totals below it as old totals fell
 * below `oldThreshold`: the shortest decimal (1–6 places) in
 * (sortedNew[k−1], sortedNew[k]]. With k = 0 it is the lowest new total; with
 * k = n just above the highest. A tie at the boundary makes an exact match
 * impossible; newShare then says what was reached.
 */
export function quantileMatchThreshold(
  oldTotals: readonly number[],
  newTotals: readonly number[],
  oldThreshold: number,
): QuantileMatch {
  if (oldTotals.length !== newTotals.length || oldTotals.length === 0) throw new Error('[Clarity] quantile match needs two equal, non-empty lists');
  const n = newTotals.length;
  const k = oldTotals.filter(t => t < oldThreshold).length;
  const sorted = [...newTotals].sort((a, b) => a - b);
  const lo = k === 0 ? -Infinity : sorted[k - 1];
  const hi = k === n ? Infinity : sorted[k];
  let threshold: number;
  if (k === 0) threshold = sorted[0];
  else if (k === n) threshold = sorted[n - 1] + 1e-6;
  else {
    const mid = (lo + hi) / 2;
    threshold = mid;
    for (let d = 1; d <= 6; d++) {
      const x = Math.round(mid * 10 ** d) / 10 ** d;
      if (x > lo && x <= hi) { threshold = x; break; }
    }
  }
  return { threshold, k, oldShare: k / n, newShare: belowShare(newTotals, threshold) };
}
