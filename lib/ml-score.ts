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
// 2026-05-03 expansion: per user directive "every possible data point".
// Goes from 8 features to 30+. Heavy regularization handles the
// dimensionality on small samples; expect feature-importance ranking to
// surface 5-10 carrying meaningful signal.
export const ML_NUMERIC_FEATURES = [
  // ── Leverage / balance sheet ──
  "log_de_or_neg",       // log(D/E+1) for positive equity, -1 for neg-eq
  "de_relative_to_avg",  // de / contemporaneous-avg D/E (within-year cohort)
  "neg_eq",              // 0/1
  "liab_growth_yoy",
  "equity_growth_yoy",
  "log_cum_buybacks",    // log(1 + cumulative 5y repurchases)
  // ── Revenue ──
  "yoy_t",
  "yoy_t1",
  "yoy_t2",
  "rev_3y_cagr",
  "log_rev_t",           // size proxy via log of recent revenue
  // ── OCF ──
  "ocf_yoy",
  "ocf_decline_2y",      // 0/1
  "ocf_per_rev",         // cash conversion
  // ── Price action ──
  "trailing_1m",
  "trailing_3m",
  "trailing_6m",
  "trailing_12m",
  "trailing_24m",
  "realized_vol_6m",
  "realized_vol_12m",
  "pct_from_52w_high",
  "pct_from_52w_low",
  // ── Macro / regime ──
  "spy_trailing_6m",
  "spy_trailing_12m",
  "year_centered",       // (year - 2015) / 10  for regime
  // ── Cross-sectional ranks ──
  "yoy_t_pctile",
  "de_pctile",
  // ── Interaction features ──
  "yoy_x_neg_eq",        // yoy_t × neg_eq
  "de_x_yoy",            // log_de × yoy_t
  "trailing6_x_yoy",     // trailing_6m × yoy_t
] as const;

export type FeatureRow = {
  log_de_or_neg: number;
  yoy_t: number;
  yoy_t1: number;
  ocf_yoy: number;
  ocf_decline_2y: number;
  neg_eq: number;
  trailing_6m: number;
  trailing_12m: number;
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
// Returns null only when the absolute minimum (yoy_t, yoy_t1, ocf_yoy)
// is missing; everything else defaults to 0 for "no info" — the model
// learns to weight those as null-equivalent through the missing-data
// indicators (neg_eq, ocf_decline_2y).
export function buildFeatureVector(f: {
  de: number | null;
  negEquity: boolean;
  yoy_t: number | null;
  yoy_t1: number | null;
  yoy_t2?: number | null;
  rev_t?: number | null;
  rev3yCagr?: number | null;
  ocfYoY: number | null;
  ocfDecline2y: boolean;
  ocfPerRev?: number | null;
  liabGrowthYoY?: number | null;
  equityGrowthYoY?: number | null;
  cumRepurchases5y?: number | null;
  deRelativeToAvg?: number | null;
  trailing1m?: number | null;
  trailing3m?: number | null;
  trailing6m?: number | null;
  trailing12m?: number | null;
  trailing24m?: number | null;
  realizedVol6m?: number | null;
  realizedVol12m?: number | null;
  pctFrom52wHigh?: number | null;
  pctFrom52wLow?: number | null;
  spyTrailing6m?: number | null;
  spyTrailing12m?: number | null;
  yearOfTrigger?: number | null;
  yoy_t_pctile?: number | null;
  de_pctile?: number | null;
  sector: Sector;
}): number[] | null {
  if (f.yoy_t == null || f.yoy_t1 == null || f.ocfYoY == null) return null;
  const log_de_or_neg = f.negEquity
    ? -1
    : f.de != null && f.de > 0
      ? Math.log(f.de + 1)
      : 0;
  const log_rev_t =
    f.rev_t != null && f.rev_t > 0 ? Math.log(f.rev_t) : 0;
  const log_cum_buybacks =
    f.cumRepurchases5y != null && f.cumRepurchases5y > 0
      ? Math.log(1 + f.cumRepurchases5y)
      : 0;
  const yearCentered =
    f.yearOfTrigger != null ? (f.yearOfTrigger - 2015) / 10 : 0;
  const yoy = f.yoy_t;
  const negEqFlag = f.negEquity ? 1 : 0;

  const numeric = [
    // Leverage / balance sheet
    log_de_or_neg,
    f.deRelativeToAvg ?? 0,
    negEqFlag,
    f.liabGrowthYoY ?? 0,
    f.equityGrowthYoY ?? 0,
    log_cum_buybacks,
    // Revenue
    yoy,
    f.yoy_t1,
    f.yoy_t2 ?? 0,
    f.rev3yCagr ?? 0,
    log_rev_t,
    // OCF
    f.ocfYoY,
    f.ocfDecline2y ? 1 : 0,
    f.ocfPerRev ?? 0,
    // Price action
    f.trailing1m ?? 0,
    f.trailing3m ?? 0,
    f.trailing6m ?? 0,
    f.trailing12m ?? 0,
    f.trailing24m ?? 0,
    f.realizedVol6m ?? 0,
    f.realizedVol12m ?? 0,
    f.pctFrom52wHigh ?? 0,
    f.pctFrom52wLow ?? 0,
    // Macro
    f.spyTrailing6m ?? 0,
    f.spyTrailing12m ?? 0,
    yearCentered,
    // Cross-sectional ranks
    f.yoy_t_pctile ?? 0.5,
    f.de_pctile ?? 0.5,
    // Interactions
    yoy * negEqFlag,
    log_de_or_neg * yoy,
    (f.trailing6m ?? 0) * yoy,
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
