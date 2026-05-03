// Lightweight logistic-regression scoring + training for the screen's ML
// short-conviction signal. Pure functions, no deps. Used by both
// scripts/train-model.ts (offline training) and lib/screen.ts (online
// scoring of current candidates against the persisted model).
//
// Honest about limits: this is a small dataset (low triple-digit events),
// the model is intentionally a 1-layer linear classifier, and feature
// engineering is shallow. Treat the score as a directional ranking signal,
// not a calibrated probability. Always inspect AUC + per-feature coefs
// before trusting the output (model.json carries them).

import type { Sector } from "./universe";

// All sectors. After the sector-exclusion empirical study (Utilities and
// REITs proved to be valid short setups, Financials no worse than already-
// included sectors), the ML model trains on the full universe. Order is
// fixed and persisted into the model so feature vectors line up; if you
// add or reorder, the persisted model.json must be retrained.
export const ML_SECTORS: ReadonlyArray<Sector> = [
  "Technology",
  "Communication Services",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Financials",
  "Health Care",
  "Industrials",
  "Materials",
  "Real Estate",
  "Utilities",
];

// Numeric features in fixed order. Sector one-hot follows.
export const ML_NUMERIC_FEATURES = [
  "log_de_or_neg",   // log(D/E+1) for positive equity, -1 for neg-eq (signed marker)
  "yoy_t",
  "yoy_t1",
  "ocf_yoy",
  "ocf_decline_2y", // 0/1
  "neg_eq",         // 0/1
] as const;

export type FeatureRow = {
  log_de_or_neg: number;
  yoy_t: number;
  yoy_t1: number;
  ocf_yoy: number;
  ocf_decline_2y: number;
  neg_eq: number;
  sector: Sector;
};

export type ModelWeights = {
  // Feature names in order; final entry is the bias term.
  features: string[];
  // For each numeric feature, the mean and std used for standardization at
  // training time. Sector one-hots are not standardized.
  numericMeans: number[];
  numericStds: number[];
  // Coefficient per feature (in `features` order). Bias is the last entry.
  coefs: number[];
  // Training metadata
  trainSize: number;
  testSize: number;
  trainAuc: number;
  testAuc: number;
  trainSplitYearLt: number;
  trainedAt: string;
  positiveLabelDef: string; // e.g. "alpha1y < -0.05"
  notes: string;
};

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

// Build the feature vector in the canonical order the model expects:
//   [...numeric, ...sector_one_hot]
// Returns null when any required numeric feature is missing.
export function buildFeatureVector(f: {
  de: number | null;
  negEquity: boolean;
  yoy_t: number | null;
  yoy_t1: number | null;
  ocfYoY: number | null;
  ocfDecline2y: boolean;
  sector: Sector;
}): number[] | null {
  if (f.yoy_t == null || f.yoy_t1 == null || f.ocfYoY == null) return null;
  const log_de_or_neg = f.negEquity
    ? -1
    : f.de != null && f.de > 0
      ? Math.log(f.de + 1)
      : 0;
  const numeric = [
    log_de_or_neg,
    f.yoy_t,
    f.yoy_t1,
    f.ocfYoY,
    f.ocfDecline2y ? 1 : 0,
    f.negEquity ? 1 : 0,
  ];
  const oneHot = ML_SECTORS.map((s) => (s === f.sector ? 1 : 0));
  return [...numeric, ...oneHot];
}

export function scoreFeatures(
  features: number[],
  model: ModelWeights
): number {
  const numericLen = ML_NUMERIC_FEATURES.length;
  const n = features.length;
  if (n + 1 !== model.coefs.length) {
    // mismatch — guard against stale models
    return 0.5;
  }
  // Standardize numeric features only; sector one-hots pass through.
  const z = new Array(n);
  for (let i = 0; i < numericLen; i++) {
    const std = model.numericStds[i] || 1;
    z[i] = (features[i] - model.numericMeans[i]) / std;
  }
  for (let i = numericLen; i < n; i++) z[i] = features[i];
  let s = model.coefs[n]; // bias is last
  for (let i = 0; i < n; i++) s += z[i] * model.coefs[i];
  return sigmoid(s);
}

// Standardize a column vector. Returns mean, std, and the standardized
// values. Empty column → mean=0, std=1.
export function standardize(col: number[]): {
  mean: number;
  std: number;
  z: number[];
} {
  if (col.length === 0) return { mean: 0, std: 1, z: [] };
  const mean = col.reduce((a, b) => a + b, 0) / col.length;
  const variance =
    col.reduce((a, b) => a + (b - mean) * (b - mean), 0) / col.length;
  const std = Math.sqrt(variance) || 1;
  const z = col.map((v) => (v - mean) / std);
  return { mean, std, z };
}

// Logistic-regression with full-batch GD and L2 regularization. No deps.
// `X` is shape [n, d]; `y` is binary {0, 1}.
export function trainLogReg(
  X: number[][],
  y: number[],
  opts: { l2: number; lr: number; iters: number; onlyRegularizeIdx?: number[] } = {
    l2: 0.05,
    lr: 0.2,
    iters: 800,
  }
): { coefs: number[] } {
  const n = X.length;
  if (n === 0) throw new Error("trainLogReg: empty training set");
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  const regIdx = opts.onlyRegularizeIdx ?? Array.from({ length: d }, (_, i) => i);
  const regSet = new Set(regIdx);
  for (let it = 0; it < opts.iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let s = b;
      for (let j = 0; j < d; j++) s += X[i][j] * w[j];
      const err = sigmoid(s) - y[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) {
      const reg = regSet.has(j) ? opts.l2 * w[j] : 0;
      w[j] -= opts.lr * (gw[j] / n + reg);
    }
    b -= opts.lr * (gb / n);
  }
  return { coefs: [...w, b] };
}

// AUC via the Mann-Whitney U / rank-sum identity. Robust to small N and
// avoids the trapezoid-rule precision loss with ties.
export function computeAuc(scores: number[], labels: number[]): number {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] }));
  pairs.sort((a, b) => a.s - b.s);
  // Average rank for ties
  const ranks = new Array(pairs.length);
  for (let i = 0; i < pairs.length; ) {
    let j = i;
    while (j < pairs.length && pairs[j].s === pairs[i].s) j++;
    const avgRank = (i + j + 1) / 2; // 1-based midpoint
    for (let k = i; k < j; k++) ranks[k] = avgRank;
    i = j;
  }
  const nPos = pairs.filter((p) => p.y === 1).length;
  const nNeg = pairs.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  const sumPosRanks = pairs.reduce(
    (a, p, i) => a + (p.y === 1 ? ranks[i] : 0),
    0
  );
  const u = sumPosRanks - (nPos * (nPos + 1)) / 2;
  return u / (nPos * nNeg);
}
