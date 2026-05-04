// Portfolio simulator v2 for the Short That Shit strategy.
// Walks every historical screen-trigger forward through Yahoo monthly bars
// for the ticker, applying stop-loss / take-profit / max-hold logic. Pays
// realistic borrow on actual time-in-trade. Reports final balance, total
// return, annualized return, win rate, max drawdown.
//
// Data sources:
//   - public/data/backtest.json — historical screen triggers
//   - .cache/edgar/yahoo-monthly-{TICKER}.json — monthly bars

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildFeatureVector,
  computeAuc,
  ML_NUMERIC_FEATURES,
  ML_SECTORS,
  scoreFeatures,
  standardize,
  trainLogReg,
  type ModelWeights,
} from "../lib/ml-score";
import type { Sector } from "../lib/universe";

// ─── Defaults (overridable in StrategyConfig) ────────────────────────
const STARTING_BALANCE = 10_000;
const ANNUAL_BORROW_COST = 0.02; // 2% annualized
const IDLE_CASH_YIELD = 0.02;
// Annualized return target. Strategies meeting this bar are tagged in
// the JSON output and drive the "trade signal" UI banner. Kept in sync
// with ANNUALIZED_BAR in lib/run-screen.ts.
const ANNUALIZED_BAR = 0.08;

// ─── Types ───────────────────────────────────────────────────────────
type Bar = { date: string; close: number };

type Event = {
  ticker: string;
  sector: Sector;
  endYear: number;
  filed: string;
  de: number | null;
  negEquity: boolean;
  yoy_t: number | null;
  yoy_t1: number | null;
  ocfYoY: number | null;
  ocfDecline2y: boolean;
  trailing6m?: number | null;
  trailing12m?: number | null;
  alpha1y: number | null;
  ret1y: number | null;
  ret6m: number | null;
  ret2y?: number | null;
};

// ─── Walk-forward ML scoring ─────────────────────────────────────────
// For each event, train a fresh logistic regression on events filed at
// least 1y BEFORE the target event (so labels are realized). This is the
// honest out-of-sample test of whether ML adds value: the persisted
// model trains on these very events and is therefore data-leaking.
//
// Optimization: cluster events by training-cutoff year (event.filed.year-1)
// and train one model per cutoff. With ~15 distinct years, we do ~15 fits
// instead of ~150.
function trainWalkForwardModels(
  events: Event[],
  buildFV: (e: Event) => number[] | null,
  l2: number = 0.1
): Map<number, ModelWeights> {
  const out = new Map<number, ModelWeights>();
  // Distinct years that need a model (the year of any event - 1)
  const cutoffYears = [
    ...new Set(events.map((e) => Number(e.filed.slice(0, 4)) - 1)),
  ].sort();
  for (const cutYear of cutoffYears) {
    const cutoffIso = `${cutYear}-12-31`;
    const trainEvents = events.filter(
      (e) => e.filed <= cutoffIso && e.alpha1y != null
    );
    if (trainEvents.length < 30) continue; // not enough to train
    const Xraw = trainEvents
      .map((e) => buildFV(e))
      .filter((v): v is number[] => v != null);
    const yLabels = trainEvents
      .filter((e) => buildFV(e) != null)
      .map((e) => (e.alpha1y! < -0.05 ? 1 : 0));
    if (Xraw.length !== yLabels.length || Xraw.length < 30) continue;
    if (yLabels.every((v) => v === yLabels[0])) continue; // all same class

    const numericLen = ML_NUMERIC_FEATURES.length;
    const totalDim = Xraw[0].length;
    const numericMeans: number[] = [];
    const numericStds: number[] = [];
    const X = Xraw.map((r) => r.slice());
    for (let i = 0; i < numericLen; i++) {
      const col = X.map((r) => r[i]);
      const { mean, std } = standardize(col);
      numericMeans.push(mean);
      numericStds.push(std);
      for (const r of X) r[i] = (r[i] - mean) / (std || 1);
    }
    const { coefs } = trainLogReg(X, yLabels, {
      l2,
      lr: 0.3,
      iters: 1500,
    });
    const featureNames = [
      ...ML_NUMERIC_FEATURES,
      ...ML_SECTORS.map((s) => `sector_${s.replace(/\s+/g, "_")}`),
      "bias",
    ];
    out.set(cutYear, {
      features: featureNames,
      numericMeans,
      numericStds,
      coefs,
      trainSize: Xraw.length,
      testSize: 0,
      trainAuc: 0,
      testAuc: 0,
      trainSplitYearLt: cutYear + 1,
      trainedAt: new Date().toISOString(),
      positiveLabelDef: "alpha1y < -0.05",
      notes: `walk-forward: trained on events through end of ${cutYear}`,
    });
  }
  return out;
}

function walkForwardScore(
  e: Event,
  models: Map<number, ModelWeights>,
  buildFV: (e: Event) => number[] | null
): number | null {
  const cutYear = Number(e.filed.slice(0, 4)) - 1;
  const model = models.get(cutYear);
  if (!model) return null;
  const fv = buildFV(e);
  if (!fv) return null;
  return scoreFeatures(fv, model);
}

// ─── Walk-forward AUC summary (out-of-sample evaluation of WF model) ─
function summarizeWalkForwardAuc(
  events: Event[],
  models: Map<number, ModelWeights>,
  buildFV: (e: Event) => number[] | null
): { n: number; auc: number; oos: Array<{ score: number; label: number }> } {
  const oos: Array<{ score: number; label: number }> = [];
  for (const e of events) {
    if (e.alpha1y == null) continue;
    const score = walkForwardScore(e, models, buildFV);
    if (score == null) continue;
    oos.push({ score, label: e.alpha1y < -0.05 ? 1 : 0 });
  }
  if (oos.length < 10) return { n: oos.length, auc: 0.5, oos };
  const auc = computeAuc(
    oos.map((x) => x.score),
    oos.map((x) => x.label)
  );
  return { n: oos.length, auc, oos };
}

type Position = {
  ticker: string;
  sector: Sector;
  entryDate: string;
  exitDate: string;
  daysHeld: number;
  size: number;
  ret: number;
  pnl: number;
  exitReason: "stop_loss" | "take_profit" | "time" | "no_data_left";
  mlScore: number | null;
  trailing6m: number | null;
};

type StrategyConfig = {
  name: string;
  description: string;
  positionSize: number;
  maxConcurrent: number;
  holdMonths: 6 | 12 | 24;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  pairTrade?: boolean;
  // Compounding: when set, position size at trigger time scales with the
  // running realized equity. e.g. 0.5 → 50% of current equity per trigger
  // (overrides positionSize). Realized equity = starting + sum of closed
  // P&L through that date.
  compoundFraction?: number | null;
  // Leverage on the pair trade: 1 = unleveraged ($size/2 short + $size/2
  // long), 2 = $size short + $size long for $size capital (portfolio-margin
  // style). Borrow cost scales with the short notional.
  pairLeverage?: number;
  // If true, accumulate IDLE_CASH_YIELD on the cash not deployed. Adds a
  // risk-free return floor.
  idleCashYield?: boolean;
  filter: (e: Event, ctx: StrategyCtx) => boolean;
};

type StrategyCtx = {
  mlScore: number | null;       // persisted model score (data-leaks; use cautiously)
  wfMlScore: number | null;     // walk-forward LR score (honest out-of-sample)
  // Mean α₁y of prior same-sector events filed at least 1y before this
  // event's filing date. Null if < 3 prior events. Non-parametric "follow
  // the sector trend" predictor — fewer dof than logistic regression so
  // less overfitting on small samples.
  sectorPriorAlpha: number | null;
  sectorPriorN: number;
  trailing6m: number | null;
};

type StrategyMetrics = {
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  informationRatio: number | null;
  yearlyPnL: Record<string, number>;
  bestYear: { year: string; pnl: number } | null;
  worstYear: { year: string; pnl: number } | null;
  longestWinStreak: number;
  longestLossStreak: number;
  pnlMean: number;
  pnlStd: number;
  pnlSkew: number;
  bootstrapCI95Lo: number | null;
  bootstrapCI95Hi: number | null;
  // ─── New (2026-05-03): mark-to-market interim risk + tax/cost adj ─
  // Interim peak-to-trough drawdown using monthly mark-to-market on open
  // positions. Different from the exit-only `maxDrawdown` because it
  // captures intra-trade swings that could trigger margin calls.
  interimMaxDrawdown: number | null;
  // Worst monthly equity drop across the simulation (for sizing margin
  // requirement intuition).
  worstMonthlyMtmReturn: number | null;
  // Post-tax annualized return at three federal-marginal-rate scenarios.
  // Short-sale P&L is always short-term gain (Section 1233) so taxed at
  // ordinary income. Pair-trade SPY long held 12m = also short-term.
  postTaxAnnReturn22pct: number | null;
  postTaxAnnReturn32pct: number | null;
  postTaxAnnReturn37pct: number | null;
};

type StrategyResult = {
  name: string;
  description: string;
  config: Pick<StrategyConfig, "positionSize" | "maxConcurrent" | "holdMonths" | "stopLossPct" | "takeProfitPct">;
  nFiltered: number;
  nTaken: number;
  nWon: number;
  nStoppedOut: number;
  nTakeProfit: number;
  finalEquity: number;
  totalReturn: number;
  annualizedReturn: number | null;
  winRate: number;
  meanPnLPerPos: number;
  bestPos: Position | null;
  worstPos: Position | null;
  maxDrawdown: number;
  positions: Position[];
  metrics: StrategyMetrics;
};

// ─── Helpers ─────────────────────────────────────────────────────────
function addMonths(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.max(
    0,
    Math.round(
      (new Date(b).getTime() - new Date(a).getTime()) / (24 * 3600 * 1000)
    )
  );
}

function yearsBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / (365.25 * 24 * 3600 * 1000);
}

// Build a monthly equity-curve snapshot from a position list. Positions
// are held at entry size (no MTM during life) and book P&L on the exit
// month. Returns array of (date, equity) pairs from first entry through
// last exit, monthly resolution.
function buildEquityCurve(
  positions: Position[],
  startBalance: number
): Array<{ date: string; equity: number }> {
  if (positions.length === 0) return [];
  const sorted = [...positions].sort((a, b) =>
    a.exitDate.localeCompare(b.exitDate)
  );
  const startMonth = sorted[0].entryDate.slice(0, 7); // "YYYY-MM"
  const endMonth = sorted[sorted.length - 1].exitDate.slice(0, 7);
  const out: Array<{ date: string; equity: number }> = [];
  let equity = startBalance;
  let pIdx = 0;
  // Iterate months from start to end inclusive
  let cur = new Date(`${startMonth}-01`);
  const last = new Date(`${endMonth}-01`);
  while (cur <= last) {
    const ym = cur.toISOString().slice(0, 7);
    while (pIdx < sorted.length && sorted[pIdx].exitDate.slice(0, 7) <= ym) {
      equity += sorted[pIdx].pnl;
      pIdx++;
    }
    out.push({ date: ym + "-01", equity });
    cur = new Date(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1);
  }
  return out;
}

function monthlyReturns(curve: Array<{ equity: number }>): number[] {
  const r: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    if (curve[i - 1].equity <= 0) {
      r.push(0);
      continue;
    }
    r.push((curve[i].equity - curve[i - 1].equity) / curve[i - 1].equity);
  }
  return r;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function downsideDeviation(xs: number[], mar: number): number {
  if (xs.length === 0) return 0;
  const downside = xs
    .map((x) => Math.min(0, x - mar))
    .map((d) => d * d);
  return Math.sqrt(downside.reduce((a, b) => a + b, 0) / xs.length);
}

function skewness(xs: number[]): number {
  if (xs.length < 3) return 0;
  const m = mean(xs);
  const s = stdDev(xs);
  if (s === 0) return 0;
  const n = xs.length;
  return (
    (n / ((n - 1) * (n - 2))) *
    xs.reduce((a, b) => a + Math.pow((b - m) / s, 3), 0)
  );
}

const RF_ANNUAL = 0.04;
const RF_MONTHLY = RF_ANNUAL / 12;

// Walk monthly bars and mark each open position to market. Captures
// intra-trade equity swings that the exit-only equity curve misses —
// critical for understanding margin-call risk on leveraged strategies.
function markToMarketCurve(
  positions: Position[],
  startBalance: number,
  barsByTicker: Map<string, Bar[]>,
  spyBars: Bar[] | undefined,
  isPairTrade: boolean,
  pairLev: number
): { interimMaxDD: number; worstMonthlyRet: number } {
  if (positions.length === 0 || !spyBars) {
    return { interimMaxDD: 0, worstMonthlyRet: 0 };
  }
  const sorted = [...positions].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const startMonth = sorted[0].entryDate.slice(0, 7);
  const endMonth = sorted.reduce(
    (a, p) => (p.exitDate > a ? p.exitDate.slice(0, 7) : a),
    sorted[0].exitDate.slice(0, 7)
  );

  let peak = startBalance;
  let maxDD = 0;
  let worstMonthlyRet = 0;
  let prevEquity = startBalance;

  let cur = new Date(`${startMonth}-01`);
  const last = new Date(`${endMonth}-01`);
  while (cur <= last) {
    const ym = cur.toISOString().slice(0, 10);
    let equity = startBalance;

    for (const p of sorted) {
      if (p.exitDate <= ym) {
        // Position has closed — book realized P&L.
        equity += p.pnl;
        continue;
      }
      if (p.entryDate > ym) continue; // not yet open

      // Position is open this month — mark to market using ticker price
      // change since entry.
      const tickerBars = barsByTicker.get(p.ticker);
      if (!tickerBars) continue;
      const entryBar = priceAtOrAfter(tickerBars, p.entryDate);
      const curBar = priceClosestBefore(tickerBars, ym) ?? priceAtOrAfter(tickerBars, ym);
      if (!entryBar || !curBar) continue;
      const tickerRet = entryBar.close > 0 ? (curBar.close - entryBar.close) / entryBar.close : 0;

      if (isPairTrade) {
        const spyEntry = priceAtOrAfter(spyBars, p.entryDate);
        const spyCur = priceClosestBefore(spyBars, ym) ?? priceAtOrAfter(spyBars, ym);
        if (!spyEntry || !spyCur) continue;
        const spyRet = spyEntry.close > 0 ? (spyCur.close - spyEntry.close) / spyEntry.close : 0;
        const halfSize = (p.size / 2) * pairLev;
        equity += halfSize * (-tickerRet + spyRet);
      } else {
        equity += -p.size * tickerRet;
      }
    }

    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (equity - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;

    if (prevEquity > 0) {
      const monthRet = (equity - prevEquity) / prevEquity;
      if (monthRet < worstMonthlyRet) worstMonthlyRet = monthRet;
    }
    prevEquity = equity;
    cur = new Date(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1);
  }
  return { interimMaxDD: maxDD, worstMonthlyRet };
}

function computeMetrics(
  positions: Position[],
  startBalance: number,
  spyBars?: Bar[],
  barsByTicker?: Map<string, Bar[]>,
  isPairTrade: boolean = false,
  pairLev: number = 1
): StrategyMetrics {
  if (positions.length === 0) {
    return {
      sharpeRatio: null,
      sortinoRatio: null,
      calmarRatio: null,
      informationRatio: null,
      yearlyPnL: {},
      bestYear: null,
      worstYear: null,
      longestWinStreak: 0,
      longestLossStreak: 0,
      pnlMean: 0,
      pnlStd: 0,
      pnlSkew: 0,
      bootstrapCI95Lo: null,
      bootstrapCI95Hi: null,
      interimMaxDrawdown: null,
      worstMonthlyMtmReturn: null,
      postTaxAnnReturn22pct: null,
      postTaxAnnReturn32pct: null,
      postTaxAnnReturn37pct: null,
    };
  }
  const curve = buildEquityCurve(positions, startBalance);
  const rets = monthlyReturns(curve);
  const meanR = mean(rets);
  const stdR = stdDev(rets);
  const sharpe =
    stdR > 0 ? ((meanR - RF_MONTHLY) / stdR) * Math.sqrt(12) : null;
  const downStd = downsideDeviation(rets, RF_MONTHLY);
  const sortino =
    downStd > 0 ? ((meanR - RF_MONTHLY) / downStd) * Math.sqrt(12) : null;
  // Annualized return from final equity (matches what's in StrategyResult)
  const finalEquity = curve.length > 0 ? curve[curve.length - 1].equity : startBalance;
  const totalReturn = (finalEquity - startBalance) / startBalance;
  const totalYears =
    (new Date(curve[curve.length - 1].date).getTime() -
      new Date(curve[0].date).getTime()) /
    (365.25 * 24 * 3600 * 1000);
  const annReturn =
    totalYears > 0 && 1 + totalReturn > 0
      ? Math.pow(1 + totalReturn, 1 / totalYears) - 1
      : 0;
  // Max drawdown for Calmar
  let peak = startBalance;
  let maxDD = 0;
  for (const c of curve) {
    if (c.equity > peak) peak = c.equity;
    const dd = peak > 0 ? (c.equity - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }
  const calmar = maxDD < 0 ? annReturn / Math.abs(maxDD) : null;

  // Information ratio: excess return / tracking error vs SPY benchmark.
  let infoRatio: number | null = null;
  if (spyBars && spyBars.length > 0) {
    // Build monthly SPY returns aligned with our equity curve
    const spyByMonth = new Map<string, number>();
    for (const b of spyBars) spyByMonth.set(b.date.slice(0, 7), b.close);
    const months = curve.map((c) => c.date.slice(0, 7));
    const spyVals = months.map((m) => spyByMonth.get(m) ?? null);
    const spyRets: Array<number | null> = [];
    for (let i = 1; i < spyVals.length; i++) {
      const a = spyVals[i - 1];
      const b = spyVals[i];
      spyRets.push(a != null && b != null && a !== 0 ? (b - a) / a : null);
    }
    const excessRets: number[] = [];
    for (let i = 0; i < rets.length; i++) {
      const s = spyRets[i];
      if (s != null) excessRets.push(rets[i] - s);
    }
    const stdEx = stdDev(excessRets);
    const meanEx = mean(excessRets);
    if (stdEx > 0) {
      infoRatio = (meanEx / stdEx) * Math.sqrt(12);
    }
  }

  // Yearly P&L: bucket positions by exitDate year
  const yearlyPnL: Record<string, number> = {};
  for (const p of positions) {
    const y = p.exitDate.slice(0, 4);
    yearlyPnL[y] = (yearlyPnL[y] ?? 0) + p.pnl;
  }
  let bestYear: { year: string; pnl: number } | null = null;
  let worstYear: { year: string; pnl: number } | null = null;
  for (const [y, v] of Object.entries(yearlyPnL)) {
    if (!bestYear || v > bestYear.pnl) bestYear = { year: y, pnl: v };
    if (!worstYear || v < worstYear.pnl) worstYear = { year: y, pnl: v };
  }

  // Win/loss streaks (chronological)
  const chrono = [...positions].sort((a, b) =>
    a.exitDate.localeCompare(b.exitDate)
  );
  let longestWin = 0;
  let longestLoss = 0;
  let curWin = 0;
  let curLoss = 0;
  for (const p of chrono) {
    if (p.pnl > 0) {
      curWin++;
      curLoss = 0;
      if (curWin > longestWin) longestWin = curWin;
    } else if (p.pnl < 0) {
      curLoss++;
      curWin = 0;
      if (curLoss > longestLoss) longestLoss = curLoss;
    } else {
      curWin = 0;
      curLoss = 0;
    }
  }

  // P&L distribution
  const pnls = positions.map((p) => p.pnl);
  const pnlMean = mean(pnls);
  const pnlStd = stdDev(pnls);
  const pnlSkew = skewness(pnls);

  // Bootstrap CI on annualized return (resample positions with replacement)
  const bootstrapAnn: number[] = [];
  const N = positions.length;
  const ITERS = 1000;
  for (let it = 0; it < ITERS; it++) {
    let bootEquity = startBalance;
    for (let i = 0; i < N; i++) {
      const p = positions[Math.floor(Math.random() * N)];
      bootEquity += p.pnl;
    }
    if (bootEquity > 0 && totalYears > 0) {
      bootstrapAnn.push(
        Math.pow(bootEquity / startBalance, 1 / totalYears) - 1
      );
    }
  }
  bootstrapAnn.sort((a, b) => a - b);
  const lo =
    bootstrapAnn.length > 0
      ? bootstrapAnn[Math.floor(bootstrapAnn.length * 0.05)]
      : null;
  const hi =
    bootstrapAnn.length > 0
      ? bootstrapAnn[Math.floor(bootstrapAnn.length * 0.95)]
      : null;

  // Mark-to-market interim drawdown (margin-call risk proxy)
  const mtm =
    barsByTicker != null && spyBars != null
      ? markToMarketCurve(
          positions,
          startBalance,
          barsByTicker,
          spyBars,
          isPairTrade,
          pairLev
        )
      : { interimMaxDD: maxDD, worstMonthlyRet: 0 };

  // Post-tax annualized at three federal-marginal-rate scenarios. Short-
  // sale gains are always short-term (Section 1233) → ordinary income.
  // Pair-trade SPY long held exactly 12m is also short-term. Both legs
  // taxed at marginal rate.
  const postTaxAnn = (rate: number): number | null => {
    if (totalYears <= 0) return null;
    const postTaxFinal = startBalance + totalReturn * startBalance * (1 - rate);
    if (postTaxFinal <= 0) return null;
    return Math.pow(postTaxFinal / startBalance, 1 / totalYears) - 1;
  };

  return {
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    calmarRatio: calmar,
    informationRatio: infoRatio,
    yearlyPnL,
    bestYear,
    worstYear,
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
    pnlMean,
    pnlStd,
    pnlSkew,
    bootstrapCI95Lo: lo,
    bootstrapCI95Hi: hi,
    interimMaxDrawdown: mtm.interimMaxDD,
    worstMonthlyMtmReturn: mtm.worstMonthlyRet,
    postTaxAnnReturn22pct: postTaxAnn(0.22),
    postTaxAnnReturn32pct: postTaxAnn(0.32),
    postTaxAnnReturn37pct: postTaxAnn(0.37),
  };
}

// Total return from `from` to `to` using monthly closes.
function returnBetween(bars: Bar[], fromIso: string, toIso: string): number | null {
  const a = priceAtOrAfter(bars, fromIso);
  if (!a) return null;
  const b = priceClosestBefore(bars, toIso) ?? priceAtOrAfter(bars, toIso);
  if (!b) return null;
  if (a.date > toIso) return null;
  return a.close > 0 ? (b.close - a.close) / a.close : null;
}

function priceAtOrAfter(bars: Bar[], dateIso: string): Bar | null {
  for (const b of bars) if (b.date >= dateIso) return b;
  return null;
}
function priceClosestBefore(bars: Bar[], dateIso: string): Bar | null {
  let best: Bar | null = null;
  for (const b of bars) {
    if (b.date <= dateIso) best = b;
    else break;
  }
  return best;
}

// Trailing-6m total return ending on the bar at-or-before the entry date.
// Used for the anti-momentum filter ("don't short stocks that have been
// ripping").
function trailing6m(bars: Bar[], entryDate: string): number | null {
  const entry = priceAtOrAfter(bars, entryDate);
  if (!entry) return null;
  const past = priceClosestBefore(bars, addMonths(entryDate, -6));
  if (!past) return null;
  return (entry.close - past.close) / past.close;
}

// Walk bars forward from entry, applying stop-loss / take-profit / max-hold.
// Returns the realized return and exit metadata. Returns null only if there
// is no entry bar at all.
function realizePosition(
  bars: Bar[],
  entryDate: string,
  holdMonths: number,
  stopLossPct: number | null,
  takeProfitPct: number | null
): { ret: number; exitDate: string; reason: Position["exitReason"] } | null {
  const entry = priceAtOrAfter(bars, entryDate);
  if (!entry) return null;
  const maxHoldDate = addMonths(entryDate, holdMonths);

  let lastBar = entry;
  for (const b of bars) {
    if (b.date < entry.date) continue;
    lastBar = b;
    if (b.date === entry.date) continue; // entry bar — skip
    if (b.date > maxHoldDate) {
      // Exit at the last bar within the hold window (or first bar after).
      // Using `b` here is fine: it's the first bar past the window and
      // approximates "close at end of hold window" for monthly granularity.
      return {
        ret: (b.close - entry.close) / entry.close,
        exitDate: b.date,
        reason: "time",
      };
    }
    const r = (b.close - entry.close) / entry.close;
    if (stopLossPct != null && r >= stopLossPct) {
      return { ret: r, exitDate: b.date, reason: "stop_loss" };
    }
    if (takeProfitPct != null && r <= -takeProfitPct) {
      return { ret: r, exitDate: b.date, reason: "take_profit" };
    }
  }
  // Bars ran out before max-hold: use last available
  return {
    ret: (lastBar.close - entry.close) / entry.close,
    exitDate: lastBar.date,
    reason: "no_data_left",
  };
}

async function loadBars(ticker: string): Promise<Bar[] | null> {
  try {
    const file = path.resolve(
      process.cwd(),
      `.cache/edgar/yahoo-monthly-${ticker}.json`
    );
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { data: Bar[] };
    if (!Array.isArray(parsed.data)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

// ─── Simulation core ─────────────────────────────────────────────────
async function simulate(
  events: Event[],
  cfg: StrategyConfig,
  model: ModelWeights | null,
  barsByTicker: Map<string, Bar[]>,
  wfModels: Map<number, ModelWeights> | null = null,
  spyBars: Bar[] | null = null
): Promise<StrategyResult> {
  // Build event→features helper that uses on-disk trailing returns if
  // present (added in 2026-05-03 backtest schema), otherwise falls back to
  // computing from cached Yahoo bars at sim time.
  const buildFV = (e: Event) => {
    const t6 = e.trailing6m ?? (barsByTicker.get(e.ticker) ? trailing6m(barsByTicker.get(e.ticker)!, e.filed) : null);
    const t12 = e.trailing12m ?? null;
    return buildFeatureVector({
      de: e.de,
      negEquity: e.negEquity,
      yoy_t: e.yoy_t,
      yoy_t1: e.yoy_t1,
      ocfYoY: e.ocfYoY,
      ocfDecline2y: e.ocfDecline2y,
      trailing6m: t6,
      trailing12m: t12,
      sector: e.sector,
    });
  };

  // Pre-enrich each event with ML score (persisted + walk-forward),
  // sector-prior alpha (non-parametric sector predictor), and trailing-6m.
  // Sort first so sectorPriorAlpha can use only chronologically-prior data.
  const sortedEvents = [...events].sort((a, b) => a.filed.localeCompare(b.filed));
  const enriched = sortedEvents.map((e) => {
    const fv = buildFV(e);
    const mlScore = fv && model ? scoreFeatures(fv, model) : null;
    const wfMlScore =
      wfModels != null ? walkForwardScore(e, wfModels, buildFV) : null;
    const bars = barsByTicker.get(e.ticker);
    const t6 = e.trailing6m ?? (bars ? trailing6m(bars, e.filed) : null);

    // Sector-prior: mean α₁y of same-sector events filed ≥1y before this one.
    const cutoffMs =
      new Date(e.filed).getTime() - 365 * 24 * 3600 * 1000;
    const priors = sortedEvents.filter(
      (p) =>
        p.sector === e.sector &&
        p.alpha1y != null &&
        new Date(p.filed).getTime() <= cutoffMs
    );
    const sectorPriorAlpha =
      priors.length >= 3
        ? priors.reduce((a, p) => a + p.alpha1y!, 0) / priors.length
        : null;
    const sectorPriorN = priors.length;

    return {
      e,
      mlScore,
      wfMlScore,
      sectorPriorAlpha,
      sectorPriorN,
      trailing6m: t6,
      bars,
    };
  });

  // Apply strategy filter (events already chronological from sortedEvents).
  const filtered = enriched.filter(
    ({ e, mlScore, wfMlScore, sectorPriorAlpha, sectorPriorN, trailing6m }) =>
      cfg.filter(e, {
        mlScore,
        wfMlScore,
        sectorPriorAlpha,
        sectorPriorN,
        trailing6m,
      })
  );

  const positions: Position[] = [];
  const openExits: Array<{ exitDate: string; pnl: number }> = [];
  // Realized equity = starting + sum of closed P&L. Used for compounding
  // size and idle-cash yield computation.
  let realizedEquity = STARTING_BALANCE;
  const pairLev = cfg.pairLeverage ?? 1;

  // Helper: position size at trigger
  function sizeFor(): number {
    if (cfg.compoundFraction != null) {
      return Math.max(0, realizedEquity * cfg.compoundFraction);
    }
    return cfg.positionSize;
  }

  for (const { e, mlScore, wfMlScore, trailing6m, bars } of filtered as any) {
    // Close any positions whose exit dates have passed; their P&L lands in
    // realizedEquity (FIFO).
    while (openExits.length > 0 && openExits[0].exitDate <= e.filed) {
      const closed = openExits.shift()!;
      realizedEquity += closed.pnl;
    }
    if (openExits.length >= cfg.maxConcurrent) continue;

    const positionSize = sizeFor();
    if (positionSize <= 0) continue;

    if (cfg.pairTrade) {
      // Long-short pair using precomputed alpha. Position split 50/50
      // between short-ticker and long-SPY. Borrow cost only on the short
      // half. No bar-level stop-loss for pairs (would need pair P&L
      // tracking; the alpha endpoints are precomputed at 6m/1y/2y).
      const alpha =
        cfg.holdMonths === 6
          ? e.alpha1y // alpha6m available too, but we use alpha1y as primary
          : cfg.holdMonths === 24
            ? e.alpha1y // alpha2y available too, similar reasoning
            : e.alpha1y;
      // For now, restrict pair trades to 1y hold so we use the most
      //-validated alpha number in backtest.json.
      if (cfg.holdMonths !== 12 || alpha == null) continue;

      // pairLeverage = 1 → $size/2 short + $size/2 long
      // pairLeverage = 2 → $size short + $size long for $size capital
      const halfSize = (positionSize / 2) * pairLev;
      const days = 365;
      const costPct = ANNUAL_BORROW_COST * (days / 365.25);
      const pnl = halfSize * -alpha - halfSize * costPct;
      const exitDate = addMonths(e.filed, 12);

      positions.push({
        ticker: e.ticker,
        sector: e.sector,
        entryDate: e.filed,
        exitDate,
        daysHeld: days,
        size: positionSize,
        ret: alpha,
        pnl,
        exitReason: "time",
        mlScore,
        trailing6m,
      });
      openExits.push({ exitDate, pnl });
      openExits.sort((a, b) => a.exitDate.localeCompare(b.exitDate));
      continue;
    }

    if (!bars) continue;

    const realized = realizePosition(
      bars,
      e.filed,
      cfg.holdMonths,
      cfg.stopLossPct,
      cfg.takeProfitPct
    );
    if (!realized) continue;

    const days = daysBetween(e.filed, realized.exitDate);
    const costPct = ANNUAL_BORROW_COST * (days / 365.25);
    const pnl = -positionSize * realized.ret - positionSize * costPct;

    positions.push({
      ticker: e.ticker,
      sector: e.sector,
      entryDate: e.filed,
      exitDate: realized.exitDate,
      daysHeld: days,
      size: positionSize,
      ret: realized.ret,
      pnl,
      exitReason: realized.reason,
      mlScore,
      trailing6m,
    });
    openExits.push({ exitDate: realized.exitDate, pnl });
    openExits.sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  }

  // Drain remaining open positions (their exit P&L lands in realizedEquity)
  for (const c of openExits) realizedEquity += c.pnl;
  openExits.length = 0;

  // Idle-cash yield: approximation that credits IDLE_CASH_YIELD over the
  // strategy lifetime on the average undeployed cash. With monthly-bar
  // granularity and no continuous mark-to-market, this is reasonable.
  if (cfg.idleCashYield && positions.length > 0) {
    const startDate = positions[0].entryDate;
    const endDate = positions.reduce(
      (a, p) => (p.exitDate > a ? p.exitDate : a),
      positions[0].exitDate
    );
    const yrs = yearsBetween(startDate, endDate);
    // Average gross deployed: sum of per-position (size*days) / total days.
    const totalSpan =
      (new Date(endDate).getTime() - new Date(startDate).getTime()) /
        (1000 * 60 * 60 * 24) || 1;
    let weightedDeployed = 0;
    for (const p of positions) {
      // Only the SHORT side requires capital under unleveraged margin; for
      // pair trades that's halfSize. Approximate gross deployed = size for
      // naked shorts, halfSize × pairLev × 2 (short + long) for pairs.
      const gross = cfg.pairTrade ? p.size * pairLev : p.size;
      weightedDeployed += gross * p.daysHeld;
    }
    const avgDeployed = weightedDeployed / totalSpan;
    const avgIdle = Math.max(0, STARTING_BALANCE - avgDeployed);
    const idleYield = avgIdle * IDLE_CASH_YIELD * yrs;
    realizedEquity += idleYield;
  }

  // Stats
  if (positions.length === 0) {
    return {
      name: cfg.name,
      description: cfg.description,
      config: {
        positionSize: cfg.positionSize,
        maxConcurrent: cfg.maxConcurrent,
        holdMonths: cfg.holdMonths,
        stopLossPct: cfg.stopLossPct,
        takeProfitPct: cfg.takeProfitPct,
      },
      nFiltered: filtered.length,
      nTaken: 0,
      nWon: 0,
      nStoppedOut: 0,
      nTakeProfit: 0,
      finalEquity: STARTING_BALANCE,
      totalReturn: 0,
      annualizedReturn: 0,
      winRate: 0,
      meanPnLPerPos: 0,
      bestPos: null,
      worstPos: null,
      maxDrawdown: 0,
      positions: [],
      metrics: computeMetrics(
        [],
        STARTING_BALANCE,
        spyBars ?? undefined,
        barsByTicker,
        cfg.pairTrade ?? false,
        pairLev
      ),
    };
  }

  const totalPnL = positions.reduce((a, p) => a + p.pnl, 0);
  // realizedEquity already includes total P&L + idle cash yield (if enabled).
  const finalEquity = realizedEquity;
  const totalReturn = (finalEquity - STARTING_BALANCE) / STARTING_BALANCE;

  const firstEntry = positions[0].entryDate;
  const lastExit = positions.reduce(
    (a, p) => (p.exitDate > a ? p.exitDate : a),
    positions[0].exitDate
  );
  const years = yearsBetween(firstEntry, lastExit);
  let annualized: number | null = null;
  if (1 + totalReturn > 0 && years > 0) {
    annualized = Math.pow(1 + totalReturn, 1 / years) - 1;
  }

  // Equity curve & max drawdown by exit-date order
  const closes = positions
    .map((p) => ({ date: p.exitDate, pnl: p.pnl }))
    .sort((a, b) => a.date.localeCompare(b.date));
  let equity = STARTING_BALANCE;
  let peak = STARTING_BALANCE;
  let maxDD = 0;
  for (const c of closes) {
    equity += c.pnl;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (equity - peak) / peak : -1;
    if (dd < maxDD) maxDD = dd;
  }

  const wins = positions.filter((p) => p.pnl > 0).length;
  const stops = positions.filter((p) => p.exitReason === "stop_loss").length;
  const takes = positions.filter((p) => p.exitReason === "take_profit").length;
  const sorted = [...positions].sort((a, b) => b.pnl - a.pnl);

  return {
    name: cfg.name,
    description: cfg.description,
    config: {
      positionSize: cfg.positionSize,
      maxConcurrent: cfg.maxConcurrent,
      holdMonths: cfg.holdMonths,
      stopLossPct: cfg.stopLossPct,
      takeProfitPct: cfg.takeProfitPct,
    },
    nFiltered: filtered.length,
    nTaken: positions.length,
    nWon: wins,
    nStoppedOut: stops,
    nTakeProfit: takes,
    finalEquity,
    totalReturn,
    annualizedReturn: annualized,
    winRate: wins / positions.length,
    meanPnLPerPos: totalPnL / positions.length,
    bestPos: sorted[0],
    worstPos: sorted[sorted.length - 1],
    maxDrawdown: maxDD,
    positions,
    metrics: computeMetrics(
      positions,
      STARTING_BALANCE,
      spyBars ?? undefined,
      barsByTicker,
      cfg.pairTrade ?? false,
      pairLev
    ),
  };
}

// ─── Strategy zoo ────────────────────────────────────────────────────
const LOSER_SECTORS: Sector[] = [
  "Industrials",
  "Consumer Discretionary",
  "Financials",
];
const isWinningSector = (s: Sector) => !LOSER_SECTORS.includes(s);

const STRATEGIES: StrategyConfig[] = [
  // ─── Iteration 1: do stops fix the blowup problem? ─────────────────
  {
    name: "[01] baseline + stop25",
    description: "all matches, 1y hold, $1K size, stop-loss at +25%",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: null,
    filter: () => true,
  },
  {
    name: "[02] baseline + stop25 + take50",
    description: "+ take-profit at -50% (lock in big winners)",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: 0.5,
    filter: () => true,
  },
  // ─── Iteration 2: smaller position sizes ───────────────────────────
  {
    name: "[03] baseline $500 size",
    description: "5% of capital per position, no stops",
    positionSize: 500,
    maxConcurrent: 20,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    filter: () => true,
  },
  {
    name: "[04] $500 + stop25",
    description: "5% size + stop25",
    positionSize: 500,
    maxConcurrent: 20,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: null,
    filter: () => true,
  },
  // ─── Iteration 3: anti-momentum filter ─────────────────────────────
  {
    name: "[05] anti-momentum (skip if 6m up >10%)",
    description: "don't short stocks that have been ripping; $1K + stop25",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: null,
    filter: (_e, ctx) => ctx.trailing6m == null || ctx.trailing6m <= 0.1,
  },
  {
    name: "[06] strong anti-momentum (skip if 6m up >0%)",
    description: "only short stocks already in downtrend; $1K + stop25",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: null,
    filter: (_e, ctx) => ctx.trailing6m == null || ctx.trailing6m <= 0,
  },
  // ─── Iteration 4: combine sector + anti-momentum + stops ───────────
  {
    name: "[07] sector + anti-momentum + stop25",
    description: "drop loser sectors + anti-momentum + stop25",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: null,
    filter: (e, ctx) =>
      isWinningSector(e.sector) && (ctx.trailing6m == null || ctx.trailing6m <= 0.1),
  },
  {
    name: "[08] kitchen sink",
    description:
      "winning sectors + anti-mom (≤0%) + stop25 + take50 + no ocf-decline-2y",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: 0.5,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  // ─── Iteration 5: ML overlay ───────────────────────────────────────
  {
    name: "[09] ML > 0.55 + stop25",
    description: "in-sample bias caveat; baseline + stop25 + ML filter",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: null,
    filter: (_e, ctx) => ctx.mlScore != null && ctx.mlScore > 0.55,
  },
  {
    name: "[10] ML > 0.55 + anti-mom + stop25",
    description: "ML + anti-momentum + stop25",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: null,
    filter: (_e, ctx) =>
      ctx.mlScore != null &&
      ctx.mlScore > 0.55 &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0.1),
  },
  // ─── Iteration 6: hold-period sweep on best combo ──────────────────
  {
    name: "[11] kitchen sink, 6m hold",
    description: "best combo at half the hold period",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 6,
    stopLossPct: 0.25,
    takeProfitPct: 0.5,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[12] kitchen sink, 24m hold",
    description: "best combo at double the hold period",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 24,
    stopLossPct: 0.25,
    takeProfitPct: 0.5,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  // ─── Iteration 7: pair trades — short ticker + long SPY ────────────
  // The structural problem with naked shorts: markets go up over time.
  // Pair trades capture only the *relative* underperformance (alpha),
  // which is what the screen actually predicts.
  {
    name: "[13] pair trade — all matches",
    description: "$1K/pos = $500 short + $500 long SPY, 1y hold",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: () => true,
  },
  {
    name: "[14] pair trade + sectors",
    description: "drop loser sectors, pair trade",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e) => isWinningSector(e.sector),
  },
  {
    name: "[15] pair trade + anti-mom",
    description: "anti-momentum (≤+10%) + pair trade",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (_e, ctx) => ctx.trailing6m == null || ctx.trailing6m <= 0.1,
  },
  {
    name: "[16] pair trade kitchen sink",
    description: "winning sectors + anti-mom (≤0%) + no ocf2y, pair trade",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  // ─── Iteration 8: deploy more capital — $5K/pos for the best filter ─
  {
    name: "[17] $5K pair trade kitchen sink",
    description:
      "scale up pair trade to $5K/pos (heavy concentration on best filter)",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  // ─── Iteration 9: tight stops + pair trade hybrid ──────────────────
  {
    name: "[18] tight stop15 (winning sector)",
    description: "tight 15% stop, winning sectors only",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.15,
    takeProfitPct: 0.4,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[19] strong downtrend filter",
    description: "only short stocks already down ≥10% in trailing 6m",
    positionSize: 1000,
    maxConcurrent: 15,
    holdMonths: 12,
    stopLossPct: 0.25,
    takeProfitPct: 0.5,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      ctx.trailing6m != null &&
      ctx.trailing6m <= -0.1,
  },
  // ─── Iteration 10: more granular pair trade sweeps ─────────────────
  {
    name: "[20] $3K pair kitchen sink",
    description: "intermediate size, pair trade kitchen sink",
    positionSize: 3000,
    maxConcurrent: 6,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[21] $2K pair sectors only",
    description: "broader filter, smaller size, more trades",
    positionSize: 2000,
    maxConcurrent: 8,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e) => isWinningSector(e.sector),
  },
  {
    name: "[22] $5K pair, EXCLUDE FY2019",
    description: "robustness check — strip COVID-period events",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      e.endYear !== 2019 &&
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[23] $5K pair, post-2018 only",
    description: "out-of-sample-ish test (kitchen sink filter was selected on full data, but at least the test window is later)",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      e.endYear >= 2018 &&
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[24] $5K pair + ML > 0.5",
    description: "combine kitchen sink filter with model agreement (ML > 0.5)",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0) &&
      ctx.mlScore != null &&
      ctx.mlScore > 0.5,
  },
  {
    name: "[25] $5K pair + neg-eq filter",
    description: "kitchen sink without high D/E (D/E ≤ 5) — may avoid bank-like blowup risk",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      isWinningSector(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0) &&
      (e.de == null || e.de <= 5),
  },
  // ─── Iteration 11: improving annualized returns ────────────────────
  // Goal: beat the 5.3% annualized of the original kitchen sink. The
  // four big levers are (a) winning-sectors-only, (b) compounding,
  // (c) leverage, (d) idle-cash yield.
  {
    name: "[26] WINNING SECTORS ONLY (Util+CS+RE)",
    description:
      "narrow filter to per-sector portfolio winners: Utilities, Consumer Staples, Real Estate. $5K pair, 1y hold.",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[27] WINNERS + compounding 50%",
    description: "winning sectors only, position size = 50% of running equity",
    positionSize: 5000, // overridden by compound
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 0.5,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[28] WINNERS + compounding 70%",
    description: "winning sectors only, position size = 70% of running equity",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 0.7,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[29] WINNERS + 2x leverage",
    description: "winning sectors only, pair leverage 2 ($size short + $size long)",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[30] WINNERS + 2x lev + compound 50%",
    description: "leverage AND compounding, winning sectors",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    compoundFraction: 0.5,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[31] WINNERS + idle cash @ 2%",
    description: "winning sectors + earn 2% on undeployed cash",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    idleCashYield: true,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[32] FULL STACK",
    description:
      "winning sectors + 2x leverage + compound 50% + idle cash 2%",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    compoundFraction: 0.5,
    idleCashYield: true,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[33] FULL STACK + Util + CS only (no RE)",
    description: "tighter winning sectors, full stack",
    positionSize: 5000,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    compoundFraction: 0.5,
    idleCashYield: true,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  // ─── Iteration 12: STRICT UNLEVERAGED (no margin, no portfolio leverage) ─
  // Constraint: peak position × max concurrent ≤ starting balance.
  // No pairLeverage > 1. compoundFraction ≤ 1/maxConcurrent.
  {
    name: "[34] U: $2.5K × 4 conc, winning sectors",
    description: "unleveraged 1x, winning sectors (Util/CS/RE), 4 max concurrent",
    positionSize: 2500,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[35] U: compound 25% × 4 conc, winning sectors",
    description: "unleveraged 1x with compounding (max 25% × 4 = 100%), winning sectors",
    positionSize: 2500,
    maxConcurrent: 4,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 0.25,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[36] U: $5K × 2 conc, winning sectors",
    description: "concentrated unleveraged: $5K/pos with only 2 max concurrent",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[37] U: compound 50% × 2 conc, winning sectors",
    description: "unleveraged 1x with compounding (50% × 2 = 100%), winning sectors",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 0.5,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[38] U: $10K × 1 conc, winning sectors",
    description: "fully concentrated unleveraged: one trade at a time",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[39] U: compound 100% × 1 conc, winning sectors",
    description: "all-in compounding: each trade is 100% of equity, 1 at a time",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[40] U: compound 100% × 1 conc, Util+CS only",
    description: "all-in compounding, tightest sector filter",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[41] U: compound 50% × 2 conc + idle cash",
    description: "balanced unleveraged: 2 concurrent + idle cash yield",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 0.5,
    idleCashYield: true,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  // ─── Iteration 13: WALK-FORWARD ML overlays (honest out-of-sample) ─
  // These strategies use wfMlScore (model trained only on events filed
  // before each trade), unlike earlier strategies which used the data-
  // leaking persisted score.
  {
    name: "[42] WF-ML > 0.55, broad sectors, $5K × 2 conc",
    description:
      "walk-forward ML > 0.55, all sectors, no ocf2y, anti-mom; unleveraged",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      ctx.wfMlScore != null &&
      ctx.wfMlScore > 0.55 &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[43] WF-ML > 0.6, broad sectors, $5K × 2 conc",
    description: "tighter walk-forward ML > 0.6 threshold",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      ctx.wfMlScore != null &&
      ctx.wfMlScore > 0.6 &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[44] WF-ML > 0.55, all events (no ocf/mom filter), $5K × 2",
    description:
      "let WF-ML do all the heavy lifting — no rule-based filters except the score",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (_e, ctx) => ctx.wfMlScore != null && ctx.wfMlScore > 0.55,
  },
  {
    name: "[45] WF-ML > 0.55 + winning sectors + compound 50% × 2",
    description:
      "winning sectors + walk-forward ML threshold + compounding (1x peak)",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 0.5,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0) &&
      ctx.wfMlScore != null &&
      ctx.wfMlScore > 0.55,
  },
  {
    name: "[46] WF-ML > 0.6 + Util+CS only + compound 100% × 1",
    description:
      "tightest filter: WF-ML + most-profitable sectors + concentrated",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0) &&
      ctx.wfMlScore != null &&
      ctx.wfMlScore > 0.6,
  },
  {
    name: "[47] WF-ML > 0.5 + winning sectors + compound 100% × 1",
    description:
      "looser ML threshold for more trades, single-position concentration",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0) &&
      ctx.wfMlScore != null &&
      ctx.wfMlScore > 0.5,
  },
  // ─── Iteration 14: SECTOR-PRIOR (non-parametric ML alternative) ────
  // Predict α₁y for an event as the mean α₁y of prior same-sector events.
  // Only requires 3 prior events per sector. Less overfitting than logreg
  // because there's no parameter to fit — it's just a sector lookup that
  // adapts as new data arrives.
  {
    name: "[48] Sector-prior α < -5%, broad",
    description:
      "take trade only if prior same-sector events averaged α₁y < -5%; $5K × 2",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      ctx.sectorPriorAlpha != null &&
      ctx.sectorPriorAlpha < -0.05 &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[49] Sector-prior α < -10%, broad",
    description: "stricter sector prior threshold",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    filter: (e, ctx) =>
      ctx.sectorPriorAlpha != null &&
      ctx.sectorPriorAlpha < -0.1 &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[50] Sector-prior α < -5% + compound 50% × 2",
    description: "non-parametric sector predictor + unleveraged compounding",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 0.5,
    filter: (e, ctx) =>
      ctx.sectorPriorAlpha != null &&
      ctx.sectorPriorAlpha < -0.05 &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[51] Sector-prior α < -5% + compound 100% × 1",
    description: "single position, full compounding, sector-prior filter",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ctx.sectorPriorAlpha != null &&
      ctx.sectorPriorAlpha < -0.05 &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[52] Sector-prior α < -3% + idle cash + compound 50% × 2",
    description:
      "looser sector-prior threshold for more trades, plus T-bill yield on idle",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 0.5,
    idleCashYield: true,
    filter: (e, ctx) =>
      ctx.sectorPriorAlpha != null &&
      ctx.sectorPriorAlpha < -0.03 &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  // ─── Iteration 16: tightest filters trying to clear 12% bar ────────
  {
    name: "[53] FULL DEPLOY: Consumer Staples only, $10K × 1, compound 100%",
    description:
      "highest-α sector only (CS hit 73% in backtest), full-portfolio concentration",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      e.sector === "Consumer Staples" &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[54] FULL DEPLOY: CS + sector-prior < -10%, $10K × 1",
    description:
      "consumer staples only, plus require historical sector α < -10%",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      e.sector === "Consumer Staples" &&
      ctx.sectorPriorAlpha != null &&
      ctx.sectorPriorAlpha < -0.10 &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[55] FULL DEPLOY: stronger downtrend ≤ -10%, $10K × 1",
    description:
      "winning sectors + only short stocks already down ≥10% in trailing 6m",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      ctx.trailing6m != null &&
      ctx.trailing6m <= -0.1,
  },
  {
    name: "[56] FULL DEPLOY: 2y hold, winning sectors, $10K × 1",
    description:
      "longer hold captures multi-year decline; full deployment",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 24,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[57] FULL DEPLOY: WF-ML > 0.65 + winning sectors + $10K × 1",
    description:
      "high-ML-conviction filter + concentration; tests if ML threshold can pick winners despite low overall AUC",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0) &&
      ctx.wfMlScore != null &&
      ctx.wfMlScore > 0.65,
  },
  // ─── Iteration 17: leveraged variants targeting the 8% bar ─────────
  {
    name: "[58] 2x lev + Util+CS only + compound 100% × 1",
    description: "leveraged single-position concentration in winning sectors",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[59] 2x lev + winning sectors + compound 100% × 1",
    description: "leveraged single-position, winning sectors (Util/CS/RE)",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[60] 2x lev + CS only + idle cash + compound 100% × 1",
    description:
      "highest-α sector + portfolio leverage + T-bill yield on idle, fully compounded",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    compoundFraction: 1.0,
    idleCashYield: true,
    filter: (e, ctx) =>
      e.sector === "Consumer Staples" &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[61] 2x lev + delisted-strong-decline filter + compound 100%",
    description:
      "include all sectors but require strong revenue decline (yoy_t < -10%)",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      e.yoy_t != null &&
      e.yoy_t < -0.10 &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  {
    name: "[62] 2x lev + winning sectors + compound 50% × 2",
    description: "balanced 2-position leveraged compound — moderate concentration",
    positionSize: 5000,
    maxConcurrent: 2,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    compoundFraction: 0.5,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0),
  },
  // ─── Iteration 15: ML-WEIGHTED SIZING (use score as size multiplier) ─
  // Don't filter on score — instead use it as a size weight. Even a noisy
  // signal can add value if positions are sized roughly by conviction.
  // BUT: since walk-forward AUC is ~0.48 on this dataset, sizing should
  // probably stay flat. Listed for reference.
];

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const btRaw = await fs.readFile(
    path.resolve(process.cwd(), "public/data/backtest.json"),
    "utf8"
  );
  const data = JSON.parse(btRaw) as { events: Event[] };
  const allEvents = data.events;

  let model: ModelWeights | null = null;
  try {
    const mlRaw = await fs.readFile(
      path.resolve(process.cwd(), "public/data/ml-model.json"),
      "utf8"
    );
    model = JSON.parse(mlRaw) as ModelWeights;
  } catch {
    console.warn("no ml-model.json — ML strategies will be skipped");
  }

  // Load bars for every ticker that has at least one event.
  const tickers = [...new Set(allEvents.map((e) => e.ticker))];
  const barsByTicker = new Map<string, Bar[]>();
  for (const t of tickers) {
    const bars = await loadBars(t);
    if (bars) barsByTicker.set(t, bars);
  }
  // SPY bars are needed for the Information Ratio computation in metrics.
  const spyBars = await loadBars("SPY");
  console.log(
    `loaded bars for ${barsByTicker.size}/${tickers.length} tickers; ${allEvents.length} events`
  );
  console.log(`start=$${STARTING_BALANCE}  borrow=${(ANNUAL_BORROW_COST * 100).toFixed(1)}%/yr`);

  // Train walk-forward models (one per cutoff year). Honest out-of-sample
  // ML evaluation; the persisted ml-model.json data-leaks across the sim.
  const buildFV = (e: Event) => {
    const t6 = e.trailing6m ?? (barsByTicker.get(e.ticker) ? trailing6m(barsByTicker.get(e.ticker)!, e.filed) : null);
    const t12 = e.trailing12m ?? null;
    return buildFeatureVector({
      de: e.de,
      negEquity: e.negEquity,
      yoy_t: e.yoy_t,
      yoy_t1: e.yoy_t1,
      ocfYoY: e.ocfYoY,
      ocfDecline2y: e.ocfDecline2y,
      trailing6m: t6,
      trailing12m: t12,
      sector: e.sector,
    });
  };
  // Train a few WF model variants with different regularization strengths
  // and pick the one with best out-of-sample AUC. Heavy regularization can
  // generalize better on tiny samples by shrinking toward the bias term.
  const l2Variants = [0.1, 0.5, 2.0, 5.0];
  let bestWfAuc = 0;
  let bestL2 = 0.1;
  let wfModels = new Map<number, ModelWeights>();
  console.log(`walk-forward sweep over L2 regularization:`);
  for (const l2 of l2Variants) {
    const candidates = trainWalkForwardModels(allEvents, buildFV, l2);
    const auc = summarizeWalkForwardAuc(allEvents, candidates, buildFV);
    console.log(
      `  L2=${l2.toFixed(1)}: ${candidates.size} models, OOS AUC=${auc.auc.toFixed(3)} (n=${auc.n})`
    );
    if (auc.auc > bestWfAuc) {
      bestWfAuc = auc.auc;
      bestL2 = l2;
      wfModels = candidates;
    }
  }
  console.log(
    `→ using L2=${bestL2}, OOS AUC=${bestWfAuc.toFixed(3)}\n`
  );

  const fmtPct = (n: number | null) =>
    n == null ? "  N/A" : `${(n * 100).toFixed(1)}%`;
  const fmtUSD = (n: number) => `$${n.toFixed(0)}`;

  const header =
    "Strategy".padEnd(46) +
    "size  conc  hold  stop  take  | nFilt  nTake | final     | total   | ann   | win   | DD    | stop% TP%";
  console.log(header);
  console.log("-".repeat(header.length));

  const results: StrategyResult[] = [];
  for (const cfg of STRATEGIES) {
    const r = await simulate(allEvents, cfg, model, barsByTicker, wfModels, spyBars);
    results.push(r);
    const stopRate = r.nTaken > 0 ? r.nStoppedOut / r.nTaken : 0;
    const tpRate = r.nTaken > 0 ? r.nTakeProfit / r.nTaken : 0;
    console.log(
      cfg.name.padEnd(46) +
        `$${cfg.positionSize.toString().padStart(4)} ${cfg.maxConcurrent.toString().padStart(4)}  ${cfg.holdMonths.toString().padStart(2)}m  ${cfg.stopLossPct != null ? (cfg.stopLossPct * 100).toFixed(0).padStart(3) + "%" : " — "}  ${cfg.takeProfitPct != null ? (cfg.takeProfitPct * 100).toFixed(0).padStart(3) + "%" : " — "}  | ${r.nFiltered.toString().padStart(5)}  ${r.nTaken.toString().padStart(5)} | ${fmtUSD(r.finalEquity).padStart(9)} | ${fmtPct(r.totalReturn).padStart(7)} | ${fmtPct(r.annualizedReturn).padStart(5)} | ${fmtPct(r.winRate).padStart(5)} | ${fmtPct(r.maxDrawdown).padStart(5)} | ${fmtPct(stopRate).padStart(5)} ${fmtPct(tpRate).padStart(5)}`
    );
  }

  // Leaderboard
  console.log("\n=== leaderboard (by final equity) ===");
  const ranked = [...results].sort((a, b) => b.finalEquity - a.finalEquity);
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    console.log(
      `${(i + 1).toString().padStart(2)}. ${r.name.padEnd(46)} → $${r.finalEquity.toFixed(0).padStart(7)}  (${fmtPct(r.totalReturn)}, ann ${fmtPct(r.annualizedReturn)}, n=${r.nTaken}, win ${fmtPct(r.winRate)})`
    );
  }

  const best = ranked[0];
  console.log(`\n=== best: ${best.name} ===`);
  console.log(`  ${best.description}`);
  console.log(
    `  cfg: $${best.config.positionSize}/pos, ${best.config.maxConcurrent} conc, ${best.config.holdMonths}m hold, stop=${best.config.stopLossPct ?? "—"}, take=${best.config.takeProfitPct ?? "—"}`
  );
  console.log(`  positions taken: ${best.nTaken} of ${best.nFiltered} filtered`);
  console.log(
    `  final equity:    $${best.finalEquity.toFixed(0)}  (start $${STARTING_BALANCE})`
  );
  console.log(
    `  total return:    ${fmtPct(best.totalReturn)}  (annualized ${fmtPct(best.annualizedReturn)})`
  );
  console.log(`  win rate:        ${fmtPct(best.winRate)}`);
  console.log(`  max drawdown:    ${fmtPct(best.maxDrawdown)}`);
  console.log(
    `  stop-outs:       ${best.nStoppedOut} / ${best.nTaken} (${fmtPct(best.nStoppedOut / Math.max(1, best.nTaken))})`
  );
  console.log(
    `  take-profits:    ${best.nTakeProfit} / ${best.nTaken} (${fmtPct(best.nTakeProfit / Math.max(1, best.nTaken))})`
  );

  if (best.bestPos)
    console.log(
      `  best pos:        ${best.bestPos.ticker} (${best.bestPos.sector}) ${best.bestPos.entryDate} → exit ${best.bestPos.exitDate} (${best.bestPos.exitReason}), P&L ${fmtUSD(best.bestPos.pnl)}, ret ${fmtPct(best.bestPos.ret)}`
    );
  if (best.worstPos)
    console.log(
      `  worst pos:       ${best.worstPos.ticker} (${best.worstPos.sector}) ${best.worstPos.entryDate} → exit ${best.worstPos.exitDate} (${best.worstPos.exitReason}), P&L ${fmtUSD(best.worstPos.pnl)}, ret ${fmtPct(best.worstPos.ret)}`
    );

  // ─── Per-sector breakdown ──────────────────────────────────────────
  // Apply the pair-trade kitchen-sink template (minus the sector filter)
  // to each sector independently. Answers: "what would $10K do if you
  // ONLY ran the screen on this one sector?"
  // Per-sector breakdown also uses wfModels for ML scoring (in case any
  // strategy variant inside the sector run consults wfMlScore).
  console.log("\n=== per-sector breakdown (pair trade, kitchen sink without sector filter) ===");
  const SECTORS_FOR_BREAKDOWN: Sector[] = [
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
  console.log(
    "Sector".padEnd(24) +
      " | nFilt | nTake | final     | total   | ann   | win   | DD"
  );
  console.log("-".repeat(85));
  const bySector: Array<StrategyResult & { sector: string }> = [];
  for (const sector of SECTORS_FOR_BREAKDOWN) {
    const cfg: StrategyConfig = {
      name: `[sec] ${sector}`,
      description: `pair trade, no ocf2y, anti-mom (≤0%), ${sector} only`,
      positionSize: 5000,
      maxConcurrent: 4,
      holdMonths: 12,
      stopLossPct: null,
      takeProfitPct: null,
      pairTrade: true,
      filter: (e, ctx) =>
        e.sector === sector &&
        !e.ocfDecline2y &&
        (ctx.trailing6m == null || ctx.trailing6m <= 0),
    };
    const r = await simulate(allEvents, cfg, model, barsByTicker, wfModels, spyBars);
    bySector.push({ sector, ...r });
    console.log(
      sector.padEnd(24) +
        ` | ${r.nFiltered.toString().padStart(5)} | ${r.nTaken.toString().padStart(5)} | ${fmtUSD(r.finalEquity).padStart(9)} | ${fmtPct(r.totalReturn).padStart(7)} | ${fmtPct(r.annualizedReturn).padStart(5)} | ${fmtPct(r.winRate).padStart(5)} | ${fmtPct(r.maxDrawdown).padStart(5)}`
    );
  }

  // ─── Ablation, sensitivity, and benchmark studies ────────────────
  // Pick the best-by-equity strategy and run targeted variations.
  const headlineCfg = STRATEGIES.find((s) =>
    /\[59\] 2x lev \+ winning sectors/.test(s.name)
  ) ?? STRATEGIES[0];

  console.log("\n=== ablation: drop one rule from the headline strategy ===");
  type Ablation = {
    name: string;
    description: string;
    finalEquity: number;
    annualizedReturn: number | null;
    nTaken: number;
    delta: number; // delta vs headline
  };
  const ablations: Ablation[] = [];
  const headlineResult = await simulate(allEvents, headlineCfg, model, barsByTicker, wfModels, spyBars);
  const headlineAnn = headlineResult.annualizedReturn ?? 0;

  const ablationVariants: Array<{ name: string; description: string; mod: (cfg: StrategyConfig) => StrategyConfig }> = [
    {
      name: "drop sector filter",
      description: "remove winning-sectors restriction",
      mod: (c) => ({
        ...c,
        filter: (e, ctx) => !e.ocfDecline2y && (ctx.trailing6m == null || ctx.trailing6m <= 0),
      }),
    },
    {
      name: "drop ocf-2y filter",
      description: "remove 'no ocfDecline2y' rule",
      mod: (c) => ({
        ...c,
        filter: (e, ctx) =>
          ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
          (ctx.trailing6m == null || ctx.trailing6m <= 0),
      }),
    },
    {
      name: "drop anti-momentum",
      description: "remove trailing-6m ≤ 0% requirement",
      mod: (c) => ({
        ...c,
        filter: (e) =>
          ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
          !e.ocfDecline2y,
      }),
    },
    {
      name: "drop leverage (1x)",
      description: "set pair leverage to 1",
      mod: (c) => ({ ...c, pairLeverage: 1 }),
    },
    {
      name: "drop compounding (fixed $10K)",
      description: "remove compoundFraction; use fixed positionSize",
      mod: (c) => ({ ...c, compoundFraction: null }),
    },
  ];
  for (const v of ablationVariants) {
    const modCfg = v.mod(headlineCfg);
    const res = await simulate(allEvents, modCfg, model, barsByTicker, wfModels, spyBars);
    const ann = res.annualizedReturn ?? 0;
    ablations.push({
      name: v.name,
      description: v.description,
      finalEquity: res.finalEquity,
      annualizedReturn: ann,
      nTaken: res.nTaken,
      delta: ann - headlineAnn,
    });
    console.log(
      `  ${v.name.padEnd(34)} → $${res.finalEquity.toFixed(0).padStart(7)}  ann ${(ann * 100).toFixed(1).padStart(5)}%  Δ ${(((ann - headlineAnn) * 100) >= 0 ? "+" : "")}${((ann - headlineAnn) * 100).toFixed(1)}pp`
    );
  }

  // ─── Subperiod robustness ─────────────────────────────────────────
  // Split events into 5-year buckets, run headline strategy on each
  // independently. Tests whether alpha is concentrated in one regime or
  // robust across periods.
  console.log("\n=== subperiod robustness ===");
  type SubperiodResult = {
    label: string;
    yearStart: number;
    yearEnd: number;
    nEvents: number;
    nTaken: number;
    finalEquity: number;
    annualizedReturn: number | null;
    winRate: number;
  };
  const subperiods: SubperiodResult[] = [];
  const periodDefs: Array<{ label: string; from: number; to: number }> = [
    { label: "2010-2014", from: 2010, to: 2014 },
    { label: "2015-2019", from: 2015, to: 2019 },
    { label: "2020-2025", from: 2020, to: 2025 },
  ];
  for (const pd of periodDefs) {
    const subEvents = allEvents.filter((e) => {
      const y = Number(e.filed.slice(0, 4));
      return y >= pd.from && y <= pd.to;
    });
    const subResult = await simulate(
      subEvents,
      headlineCfg,
      model,
      barsByTicker,
      wfModels,
      spyBars
    );
    subperiods.push({
      label: pd.label,
      yearStart: pd.from,
      yearEnd: pd.to,
      nEvents: subEvents.length,
      nTaken: subResult.nTaken,
      finalEquity: subResult.finalEquity,
      annualizedReturn: subResult.annualizedReturn,
      winRate: subResult.winRate,
    });
    console.log(
      `  ${pd.label}: events=${subEvents.length}, taken=${subResult.nTaken}, final=$${subResult.finalEquity.toFixed(0)}, ann ${((subResult.annualizedReturn ?? 0) * 100).toFixed(1)}%, win ${((subResult.winRate ?? 0) * 100).toFixed(0)}%`
    );
  }

  // ─── VaR / CVaR ───────────────────────────────────────────────────
  // Compute Value-at-Risk and Conditional VaR from per-position returns.
  // VaR_95 = 5th percentile (single-trade); CVaR_95 = average return below
  // VaR_95. Tells us the realistic worst-case downside.
  console.log("\n=== VaR / CVaR ===");
  const positionRets = headlineResult.positions
    .map((p) => p.pnl / Math.max(1, p.size))
    .sort((a, b) => a - b);
  const var95 =
    positionRets.length > 0
      ? positionRets[Math.floor(positionRets.length * 0.05)]
      : 0;
  const var99 =
    positionRets.length > 0
      ? positionRets[Math.floor(positionRets.length * 0.01)]
      : 0;
  const cvar95Slice = positionRets.filter((r) => r <= var95);
  const cvar95 =
    cvar95Slice.length > 0
      ? cvar95Slice.reduce((a, b) => a + b, 0) / cvar95Slice.length
      : 0;
  const cvar99Slice = positionRets.filter((r) => r <= var99);
  const cvar99 =
    cvar99Slice.length > 0
      ? cvar99Slice.reduce((a, b) => a + b, 0) / cvar99Slice.length
      : 0;
  console.log(
    `  95% VaR (per-trade):    ${(var95 * 100).toFixed(1)}%  (5th percentile of position returns)`
  );
  console.log(
    `  95% CVaR:               ${(cvar95 * 100).toFixed(1)}%  (mean of returns below VaR)`
  );
  console.log(
    `  99% VaR:                ${(var99 * 100).toFixed(1)}%`
  );
  console.log(
    `  99% CVaR:               ${(cvar99 * 100).toFixed(1)}%`
  );
  const tailRisk = { var95, var99, cvar95, cvar99 };

  // ─── Walk-forward parameter optimization ──────────────────────────
  // For each test year, optimize parameters using ONLY events filed in
  // earlier years (no hindsight), then deploy those parameters on the
  // test year. This is the most-honest out-of-sample test: every
  // parameter choice is made with knowledge available at decision time.
  console.log("\n=== walk-forward parameter optimization ===");
  type WfYear = {
    testYear: number;
    trainNEvents: number;
    bestParamsLabel: string;
    trainAnnReturn: number;
    testNTrades: number;
    testPnL: number;
    testEquityEnd: number;
  };
  const wfYearly: WfYear[] = [];

  // Compact parameter grid: 12 combinations covering the headline-strategy
  // dimensions that ablation flagged as most load-bearing.
  const paramGrid: Array<{
    label: string;
    sectors: Sector[];
    trailingMax: number;
    holdMonths: 6 | 12 | 24;
  }> = [];
  const sectorOptions: Array<{ name: string; arr: Sector[] }> = [
    { name: "Util+CS+RE", arr: ["Utilities", "Consumer Staples", "Real Estate"] },
    { name: "Util+CS", arr: ["Utilities", "Consumer Staples"] },
    { name: "CS+RE", arr: ["Consumer Staples", "Real Estate"] },
    { name: "CS only", arr: ["Consumer Staples"] },
  ];
  for (const sec of sectorOptions) {
    for (const tt of [-0.10, 0, 0.10]) {
      paramGrid.push({
        label: `${sec.name}, trail≤${(tt * 100).toFixed(0)}%`,
        sectors: sec.arr,
        trailingMax: tt,
        holdMonths: 12,
      });
    }
  }

  let wfRunningEquity = STARTING_BALANCE;
  for (let yr = 2014; yr <= 2026; yr++) {
    const trainCutoff = `${yr}-01-01`;
    const trainEvents = allEvents.filter((e) => e.filed < trainCutoff);
    const testEvents = allEvents.filter(
      (e) => e.filed >= trainCutoff && e.filed < `${yr + 1}-01-01`
    );
    if (trainEvents.length < 20) continue;

    let best: { params: typeof paramGrid[number]; ann: number; n: number } | null = null;
    for (const params of paramGrid) {
      const cfg: StrategyConfig = {
        name: `wf-${params.label}`,
        description: "",
        positionSize: 10000,
        maxConcurrent: 1,
        holdMonths: params.holdMonths,
        stopLossPct: null,
        takeProfitPct: null,
        pairTrade: true,
        pairLeverage: 2,
        compoundFraction: 1.0,
        filter: (e, ctx) =>
          (params.sectors as readonly string[]).includes(e.sector) &&
          !e.ocfDecline2y &&
          (ctx.trailing6m == null || ctx.trailing6m <= params.trailingMax),
      };
      const r = await simulate(trainEvents, cfg, model, barsByTicker, wfModels, spyBars);
      const ann = r.annualizedReturn ?? -1;
      if (!best || ann > best.ann) {
        best = { params, ann, n: r.nTaken };
      }
    }
    if (!best) continue;

    // Deploy best params on the test year
    const cfg: StrategyConfig = {
      name: `wf-deploy-${yr}`,
      description: "",
      positionSize: 10000,
      maxConcurrent: 1,
      holdMonths: best.params.holdMonths,
      stopLossPct: null,
      takeProfitPct: null,
      pairTrade: true,
      pairLeverage: 2,
      compoundFraction: 1.0,
      filter: (e, ctx) =>
        (best!.params.sectors as readonly string[]).includes(e.sector) &&
        !e.ocfDecline2y &&
        (ctx.trailing6m == null || ctx.trailing6m <= best!.params.trailingMax),
    };
    const testResult = await simulate(
      testEvents,
      cfg,
      model,
      barsByTicker,
      wfModels,
      spyBars
    );
    const testPnL = testResult.finalEquity - STARTING_BALANCE;
    wfRunningEquity += testPnL;
    wfYearly.push({
      testYear: yr,
      trainNEvents: trainEvents.length,
      bestParamsLabel: best.params.label,
      trainAnnReturn: best.ann,
      testNTrades: testResult.nTaken,
      testPnL,
      testEquityEnd: wfRunningEquity,
    });
    console.log(
      `  ${yr}: train n=${String(trainEvents.length).padStart(3)} → best="${best.params.label}" trainAnn=${(best.ann * 100).toFixed(1).padStart(5)}% | test n=${testResult.nTaken} pnl=$${testPnL.toFixed(0).padStart(5)} cumEquity=$${wfRunningEquity.toFixed(0)}`
    );
  }
  const wfYears =
    wfYearly.length > 0
      ? wfYearly[wfYearly.length - 1].testYear - wfYearly[0].testYear + 1
      : 0;
  const wfTotalReturn =
    (wfRunningEquity - STARTING_BALANCE) / STARTING_BALANCE;
  const wfAnn =
    wfYears > 0 && 1 + wfTotalReturn > 0
      ? Math.pow(1 + wfTotalReturn, 1 / wfYears) - 1
      : 0;
  console.log(
    `  WALK-FORWARD TOTAL: $${wfRunningEquity.toFixed(0)} (${(wfTotalReturn * 100).toFixed(1)}%, ann ${(wfAnn * 100).toFixed(1)}% over ${wfYears}y)`
  );
  const walkForward = {
    yearly: wfYearly,
    finalEquity: wfRunningEquity,
    totalReturn: wfTotalReturn,
    annualizedReturn: wfAnn,
    yearsCovered: wfYears,
  };

  // ─── Loosen-filter analysis ───────────────────────────────────────
  // Sweep variants from strict (headline) → loose (more trades, lower
  // per-event quality). Show whether alpha persists or collapses with
  // broader inclusion.
  console.log("\n=== loosen-filter analysis ===");
  type LooseRow = {
    label: string;
    description: string;
    nTrades: number;
    annualizedReturn: number | null;
    winRate: number;
    maxDrawdown: number;
    finalEquity: number;
  };
  const looseVariants: Array<{
    label: string;
    desc: string;
    cfg: StrategyConfig;
  }> = [
    {
      label: "headline (strict)",
      desc: "winning sectors + no-ocf2y + anti-mom (≤0%)",
      cfg: headlineCfg,
    },
    {
      label: "drop anti-mom",
      desc: "no anti-momentum filter",
      cfg: {
        ...headlineCfg,
        filter: (e) =>
          ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
          !e.ocfDecline2y,
      },
    },
    {
      label: "anti-mom ≤+10%",
      desc: "loosen trailing-6m threshold to +10%",
      cfg: {
        ...headlineCfg,
        filter: (e, ctx) =>
          ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
          !e.ocfDecline2y &&
          (ctx.trailing6m == null || ctx.trailing6m <= 0.10),
      },
    },
    {
      label: "+ Tech & Comm",
      desc: "expand sector list to include Technology & Communication Services",
      cfg: {
        ...headlineCfg,
        filter: (e, ctx) =>
          [
            "Utilities",
            "Consumer Staples",
            "Real Estate",
            "Technology",
            "Communication Services",
          ].includes(e.sector) &&
          !e.ocfDecline2y &&
          (ctx.trailing6m == null || ctx.trailing6m <= 0),
      },
    },
    {
      label: "all sectors",
      desc: "no sector filter",
      cfg: {
        ...headlineCfg,
        filter: (e, ctx) =>
          !e.ocfDecline2y &&
          (ctx.trailing6m == null || ctx.trailing6m <= 0),
      },
    },
    {
      label: "all sectors + drop ocf2y",
      desc: "only anti-momentum filter remains",
      cfg: {
        ...headlineCfg,
        filter: (_e, ctx) => ctx.trailing6m == null || ctx.trailing6m <= 0,
      },
    },
    {
      label: "broadest reasonable",
      desc: "expanded sectors, no-ocf2y, allow trail-6m ≤ +10%",
      cfg: {
        ...headlineCfg,
        filter: (e, ctx) =>
          [
            "Utilities",
            "Consumer Staples",
            "Real Estate",
            "Technology",
            "Communication Services",
            "Materials",
          ].includes(e.sector) &&
          !e.ocfDecline2y &&
          (ctx.trailing6m == null || ctx.trailing6m <= 0.10),
      },
    },
    {
      label: "no filter (gross)",
      desc: "every base-screen trigger taken — quality test",
      cfg: { ...headlineCfg, filter: () => true },
    },
  ];
  const looseResults: LooseRow[] = [];
  for (const v of looseVariants) {
    const r = await simulate(
      allEvents,
      v.cfg,
      model,
      barsByTicker,
      wfModels,
      spyBars
    );
    looseResults.push({
      label: v.label,
      description: v.desc,
      nTrades: r.nTaken,
      annualizedReturn: r.annualizedReturn,
      winRate: r.winRate,
      maxDrawdown: r.maxDrawdown,
      finalEquity: r.finalEquity,
    });
    console.log(
      `  ${v.label.padEnd(28)} n=${String(r.nTaken).padStart(3)}  ann ${((r.annualizedReturn ?? 0) * 100).toFixed(1).padStart(5)}%  win ${((r.winRate ?? 0) * 100).toFixed(0).padStart(3)}%  DD ${(r.maxDrawdown * 100).toFixed(1).padStart(5)}%  final $${r.finalEquity.toFixed(0)}`
    );
  }

  // ─── 2026 YTD P&L ────────────────────────────────────────────────
  // Show positions the headline strategy would have opened in 2026, with
  // current mark-to-market for any still open. Useful to see the "live"
  // bleeding edge of the backtest.
  console.log("\n=== 2026 YTD P&L (headline strategy) ===");
  const today = new Date().toISOString().slice(0, 10);
  type YtdEntry = {
    ticker: string;
    sector: string;
    entryDate: string;
    expectedExitDate: string;
    daysOpen: number;
    size: number;
    realized: boolean;
    realizedPnL: number | null;
    realizedRet: number | null;
    unrealizedMtmPnL: number | null;
    unrealizedMtmRet: number | null;
    pnlAsOfToday: number;
  };
  // Track ALL 2026 P&L: positions opened in 2026 (still open) + positions
  // that EXITED in 2026 (opened in earlier years, P&L lands in 2026).
  // Earlier we only tracked opened-in-2026, hiding the CCI 2025→2026 exit
  // that contributed +$9,327 to the calendar year.
  const ytd2026Opened: YtdEntry[] = [];
  const ytd2026Exited: YtdEntry[] = [];
  const ytd2026: YtdEntry[] = [];
  let total2026PnL = 0;
  for (const p of headlineResult.positions) {
    const openedIn2026 = p.entryDate.startsWith("2026");
    const exitedIn2026 = p.exitDate.startsWith("2026");
    if (!openedIn2026 && !exitedIn2026) continue;
    const realized = p.exitDate <= today;
    let unrealizedPnL: number | null = null;
    let unrealizedRet: number | null = null;
    if (!realized) {
      // Compute MTM as of today using current Yahoo bar
      const tickerBars = barsByTicker.get(p.ticker);
      if (tickerBars && spyBars) {
        const entryT = priceAtOrAfter(tickerBars, p.entryDate);
        const entryS = priceAtOrAfter(spyBars, p.entryDate);
        const curT = priceClosestBefore(tickerBars, today);
        const curS = priceClosestBefore(spyBars, today);
        if (entryT && entryS && curT && curS) {
          const tickerRet = (curT.close - entryT.close) / entryT.close;
          const spyRet = (curS.close - entryS.close) / entryS.close;
          const halfSize = (p.size / 2) * (headlineCfg.pairLeverage ?? 1);
          unrealizedPnL = halfSize * (-tickerRet + spyRet);
          unrealizedRet = (-tickerRet + spyRet);
        }
      }
    }
    const pnlAsOfToday = realized ? p.pnl : unrealizedPnL ?? 0;
    // For total 2026 P&L: count exits booked in 2026 + MTM of 2026-opened
    // positions (still open). Don't double-count cross-year positions.
    if (exitedIn2026) total2026PnL += p.pnl;
    if (openedIn2026 && !exitedIn2026) total2026PnL += pnlAsOfToday;

    const entry: YtdEntry = {
      ticker: p.ticker,
      sector: p.sector,
      entryDate: p.entryDate,
      expectedExitDate: p.exitDate,
      daysOpen: realized ? p.daysHeld : Math.round(
        (new Date(today).getTime() - new Date(p.entryDate).getTime()) /
          (24 * 3600 * 1000)
      ),
      size: p.size,
      realized,
      realizedPnL: realized ? p.pnl : null,
      realizedRet: realized ? p.ret : null,
      unrealizedMtmPnL: unrealizedPnL,
      unrealizedMtmRet: unrealizedRet,
      pnlAsOfToday,
    };
    if (openedIn2026) ytd2026Opened.push(entry);
    if (exitedIn2026) ytd2026Exited.push(entry);
    ytd2026.push(entry); // legacy field kept for backward-compat
  }
  // Also collect 2026 candidate events that DID trigger the screen but
  // failed the headline filter — helpful for transparency on why the
  // strategy is in cash.
  type YtdCandidate = {
    ticker: string;
    sector: string;
    filed: string;
    de: number | null;
    yoy_t: number | null;
    trailing6m: number | null;
    ocfDecline2y: boolean;
    inWinningSector: boolean;
    failedFilters: string[];
    matchesHeadline: boolean;
  };
  const ytd2026Candidates: YtdCandidate[] = [];
  const winningSectors = ["Utilities", "Consumer Staples", "Real Estate"];
  for (const e of allEvents) {
    if (!e.filed.startsWith("2026")) continue;
    const failedFilters: string[] = [];
    if (!winningSectors.includes(e.sector)) failedFilters.push("not in winning sectors");
    if (e.ocfDecline2y) failedFilters.push("ocf-decline-2y");
    if (e.trailing6m != null && e.trailing6m > 0) failedFilters.push("trailing-6m > 0%");
    ytd2026Candidates.push({
      ticker: e.ticker,
      sector: e.sector,
      filed: e.filed,
      de: e.de,
      yoy_t: e.yoy_t,
      trailing6m: e.trailing6m ?? null,
      ocfDecline2y: e.ocfDecline2y,
      inWinningSector: winningSectors.includes(e.sector),
      failedFilters,
      matchesHeadline: failedFilters.length === 0,
    });
  }
  console.log(
    `  ${ytd2026Candidates.length} candidates triggered the base screen in 2026; ${ytd2026Candidates.filter((c) => c.matchesHeadline).length} passed the headline filter`
  );

  if (ytd2026.length === 0) {
    console.log("  No headline positions opened in 2026 (yet).");
  } else {
    for (const y of ytd2026) {
      const status = y.realized ? "closed" : "open";
      const pnlPct = y.size > 0 ? (y.pnlAsOfToday / y.size) * 100 : 0;
      console.log(
        `  ${y.ticker.padEnd(8)} ${y.sector.slice(0, 14).padEnd(14)} entry ${y.entryDate} ${status.padEnd(7)} P&L $${y.pnlAsOfToday.toFixed(0).padStart(5)} (${pnlPct.toFixed(1)}% on size)`
      );
    }
    console.log(`  TOTAL 2026 P&L: $${total2026PnL.toFixed(0)}`);
  }

  // ─── Regime-conditional analysis ──────────────────────────────────
  // Bucket events by SPY trailing-12m at trigger date. Compare strategy
  // performance in bull (SPY > +10%) vs bear (SPY < -10%) vs sideways.
  console.log("\n=== regime-conditional analysis ===");
  type RegimeStat = {
    label: string;
    nEvents: number;
    nTaken: number;
    finalEquity: number;
    annualizedReturn: number | null;
    winRate: number;
  };
  const regimes: RegimeStat[] = [];
  const regimeDefs: Array<{ label: string; pred: (e: Event) => boolean }> = [
    {
      label: "bull (SPY 12m > +10%)",
      pred: (e) =>
        (e.trailing12m == null && (() => false)()) ||
        ((spyBars &&
          (() => {
            const spy12 = returnBetween(spyBars, addMonths(e.filed, -12), e.filed);
            return spy12 != null && spy12 > 0.10;
          })()) ||
          false),
    },
    {
      label: "sideways (SPY 12m -10% to +10%)",
      pred: (e) => {
        if (!spyBars) return false;
        const spy12 = returnBetween(spyBars, addMonths(e.filed, -12), e.filed);
        return spy12 != null && spy12 >= -0.10 && spy12 <= 0.10;
      },
    },
    {
      label: "bear (SPY 12m < -10%)",
      pred: (e) => {
        if (!spyBars) return false;
        const spy12 = returnBetween(spyBars, addMonths(e.filed, -12), e.filed);
        return spy12 != null && spy12 < -0.10;
      },
    },
  ];
  for (const rd of regimeDefs) {
    const subEvents = allEvents.filter(rd.pred);
    const subResult = await simulate(
      subEvents,
      headlineCfg,
      model,
      barsByTicker,
      wfModels,
      spyBars
    );
    regimes.push({
      label: rd.label,
      nEvents: subEvents.length,
      nTaken: subResult.nTaken,
      finalEquity: subResult.finalEquity,
      annualizedReturn: subResult.annualizedReturn,
      winRate: subResult.winRate,
    });
    console.log(
      `  ${rd.label.padEnd(34)} n=${String(subEvents.length).padStart(3)} taken=${subResult.nTaken} final=$${subResult.finalEquity.toFixed(0).padStart(6)} ann ${(((subResult.annualizedReturn ?? 0) * 100)).toFixed(1).padStart(5)}% win ${((subResult.winRate ?? 0) * 100).toFixed(0)}%`
    );
  }

  // ─── ML-weighted position sizing (variant) ────────────────────────
  // Instead of equal weight or full size, scale position size by ML score.
  // High-conviction trades (score > 0.65) get full $10K; medium (0.5-0.65)
  // get $5K; low (<0.5) get nothing.
  console.log("\n=== ML-weighted sizing strategy ===");
  const mlSizingCfg: StrategyConfig = {
    name: "ML-weighted sizing",
    description: "size = $10K × clamp(score-0.4, 0, 0.6)/0.6 — high-conviction trades scale up",
    positionSize: 10000,
    maxConcurrent: 1,
    holdMonths: 12,
    stopLossPct: null,
    takeProfitPct: null,
    pairTrade: true,
    pairLeverage: 2,
    compoundFraction: 1.0,
    filter: (e, ctx) =>
      ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
      !e.ocfDecline2y &&
      (ctx.trailing6m == null || ctx.trailing6m <= 0) &&
      ctx.wfMlScore != null &&
      ctx.wfMlScore > 0.4,
  };
  const mlSizingResult = await simulate(
    allEvents,
    mlSizingCfg,
    model,
    barsByTicker,
    wfModels,
    spyBars
  );
  console.log(
    `  ML > 0.4 + headline filter: n=${mlSizingResult.nTaken} final=$${mlSizingResult.finalEquity.toFixed(0)} ann ${((mlSizingResult.annualizedReturn ?? 0) * 100).toFixed(1)}% win ${((mlSizingResult.winRate ?? 0) * 100).toFixed(0)}%`
  );

  // ─── ML calibration curve ─────────────────────────────────────────
  // For each event, score with walk-forward ML, bucket by score, compute
  // empirical hit rate (fraction with α₁y < -5%) per bucket. A
  // well-calibrated model has higher hit rates in higher score buckets.
  console.log("\n=== ML calibration ===");
  type CalibBin = {
    bucket: string;
    minScore: number;
    maxScore: number;
    n: number;
    actualHitRate: number | null;
    meanScore: number;
  };
  const wfScores: Array<{ score: number; hit: number }> = [];
  for (const e of allEvents) {
    if (e.alpha1y == null) continue;
    const score = walkForwardScore(e, wfModels, buildFV);
    if (score == null) continue;
    wfScores.push({ score, hit: e.alpha1y < -0.05 ? 1 : 0 });
  }
  const calibBuckets: CalibBin[] = [];
  for (let lo = 0; lo < 1.0; lo += 0.2) {
    const hi = lo + 0.2;
    const inBucket = wfScores.filter((s) => s.score >= lo && s.score < hi);
    if (inBucket.length === 0) {
      calibBuckets.push({
        bucket: `${lo.toFixed(1)}–${hi.toFixed(1)}`,
        minScore: lo,
        maxScore: hi,
        n: 0,
        actualHitRate: null,
        meanScore: (lo + hi) / 2,
      });
      continue;
    }
    const avgScore = inBucket.reduce((a, b) => a + b.score, 0) / inBucket.length;
    const hitRate =
      inBucket.reduce((a, b) => a + b.hit, 0) / inBucket.length;
    calibBuckets.push({
      bucket: `${lo.toFixed(1)}–${hi.toFixed(1)}`,
      minScore: lo,
      maxScore: hi,
      n: inBucket.length,
      actualHitRate: hitRate,
      meanScore: avgScore,
    });
    console.log(
      `  ${lo.toFixed(1)}–${hi.toFixed(1)}: n=${String(inBucket.length).padStart(3)}  meanScore=${avgScore.toFixed(2)}  actualHitRate=${(hitRate * 100).toFixed(0)}%`
    );
  }

  // ─── p-value vs random portfolio ──────────────────────────────────
  // Generate N random "strategies" that draw n trades from the full event
  // pool (any trigger with α₁y data, no filter). Apply the same
  // pair/leverage/compound structure. Where does our headline land in
  // the distribution? p = fraction of random portfolios that beat us.
  console.log("\n=== p-value test (vs random short portfolios) ===");
  const eventsWithAlpha = allEvents.filter(
    (e) => e.alpha1y != null && e.sector != null
  );
  const ourAnn = headlineResult.annualizedReturn ?? 0;
  const headlineN = headlineResult.positions.length;
  const RANDOM_ITERS = 5000;
  const randomAnns: number[] = [];
  let beatUs = 0;
  for (let it = 0; it < RANDOM_ITERS; it++) {
    let bootEquity = STARTING_BALANCE;
    for (let i = 0; i < headlineN; i++) {
      const e = eventsWithAlpha[Math.floor(Math.random() * eventsWithAlpha.length)];
      const lev = headlineCfg.pairLeverage ?? 1;
      const halfSize = (10000 / 2) * lev; // approximate position size
      const costPct = ANNUAL_BORROW_COST;
      const pnl = halfSize * -e.alpha1y! - halfSize * costPct;
      bootEquity += pnl;
    }
    if (bootEquity > 0) {
      const totalRet = (bootEquity - STARTING_BALANCE) / STARTING_BALANCE;
      const ann =
        Math.pow(1 + totalRet, 1 / Math.max(1, headlineN)) - 1;
      randomAnns.push(ann);
      if (ann >= ourAnn) beatUs++;
    }
  }
  randomAnns.sort((a, b) => a - b);
  const pValue = beatUs / Math.max(1, randomAnns.length);
  const randomMean = randomAnns.length
    ? randomAnns.reduce((a, b) => a + b, 0) / randomAnns.length
    : 0;
  const randomP05 = randomAnns.length
    ? randomAnns[Math.floor(randomAnns.length * 0.05)]
    : 0;
  const randomP95 = randomAnns.length
    ? randomAnns[Math.floor(randomAnns.length * 0.95)]
    : 0;
  console.log(
    `  random ${RANDOM_ITERS} portfolios of ${headlineN} trades each:`
  );
  console.log(
    `    mean ann ${(randomMean * 100).toFixed(1)}%  p5 ${(randomP05 * 100).toFixed(1)}%  p95 ${(randomP95 * 100).toFixed(1)}%`
  );
  console.log(
    `    p-value (random ≥ ours): ${pValue.toFixed(3)} (${beatUs}/${randomAnns.length} random portfolios beat us)`
  );
  const pValueResult = {
    iters: RANDOM_ITERS,
    n: headlineN,
    randomMean,
    randomP05,
    randomP95,
    ourAnnualizedReturn: ourAnn,
    pValue,
  };

  // ─── Hyperparameter sensitivity grid ──────────────────────────────
  console.log("\n=== hyperparameter sensitivity ===");
  type HpSweep = {
    knob: string;
    value: string;
    finalEquity: number;
    annualizedReturn: number | null;
    nTaken: number;
  };
  const hpSensitivities: HpSweep[] = [];
  // Trailing-6m threshold sweep
  for (const thr of [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2]) {
    const cfg: StrategyConfig = {
      ...headlineCfg,
      filter: (e, ctx) =>
        ["Utilities", "Consumer Staples", "Real Estate"].includes(e.sector) &&
        !e.ocfDecline2y &&
        (ctx.trailing6m == null || ctx.trailing6m <= thr),
    };
    const r = await simulate(allEvents, cfg, model, barsByTicker, wfModels, spyBars);
    hpSensitivities.push({
      knob: "trailing6m_max",
      value: thr.toFixed(2),
      finalEquity: r.finalEquity,
      annualizedReturn: r.annualizedReturn,
      nTaken: r.nTaken,
    });
  }
  // Sector-list permutations
  const sectorCombos: Array<{ name: string; sectors: string[] }> = [
    { name: "Util only", sectors: ["Utilities"] },
    { name: "CS only", sectors: ["Consumer Staples"] },
    { name: "RE only", sectors: ["Real Estate"] },
    { name: "Util+CS", sectors: ["Utilities", "Consumer Staples"] },
    { name: "Util+RE", sectors: ["Utilities", "Real Estate"] },
    { name: "CS+RE", sectors: ["Consumer Staples", "Real Estate"] },
    { name: "Util+CS+RE", sectors: ["Utilities", "Consumer Staples", "Real Estate"] },
  ];
  for (const sc of sectorCombos) {
    const cfg: StrategyConfig = {
      ...headlineCfg,
      filter: (e, ctx) =>
        sc.sectors.includes(e.sector) &&
        !e.ocfDecline2y &&
        (ctx.trailing6m == null || ctx.trailing6m <= 0),
    };
    const r = await simulate(allEvents, cfg, model, barsByTicker, wfModels, spyBars);
    hpSensitivities.push({
      knob: "sector_list",
      value: sc.name,
      finalEquity: r.finalEquity,
      annualizedReturn: r.annualizedReturn,
      nTaken: r.nTaken,
    });
  }
  // Hold-period sweep
  for (const hold of [6, 12, 24] as const) {
    const cfg: StrategyConfig = { ...headlineCfg, holdMonths: hold };
    const r = await simulate(allEvents, cfg, model, barsByTicker, wfModels, spyBars);
    hpSensitivities.push({
      knob: "hold_months",
      value: `${hold}m`,
      finalEquity: r.finalEquity,
      annualizedReturn: r.annualizedReturn,
      nTaken: r.nTaken,
    });
  }
  for (const r of hpSensitivities) {
    console.log(
      `  ${r.knob.padEnd(18)} ${r.value.padEnd(14)} → $${r.finalEquity.toFixed(0).padStart(7)}  ann ${(((r.annualizedReturn ?? 0) * 100)).toFixed(1).padStart(5)}%  n=${r.nTaken}`
    );
  }

  // ─── Dividend-cost modeling ───────────────────────────────────────
  console.log("\n=== dividend-cost modeling (sector-yield approximation) ===");
  // Approximate trailing-12m dividend yield by sector. Short pays the
  // long's dividend, so this is incremental cost on the short notional.
  const SECTOR_DIV_YIELD: Record<string, number> = {
    Utilities: 0.035,
    "Consumer Staples": 0.025,
    "Real Estate": 0.035, // REITs distribute more
    Financials: 0.022,
    Industrials: 0.020,
    "Consumer Discretionary": 0.015,
    "Health Care": 0.015,
    Technology: 0.010,
    Energy: 0.030,
    Materials: 0.020,
    "Communication Services": 0.020,
  };
  let divAdjustedFinal = STARTING_BALANCE;
  let totalDivCost = 0;
  for (const p of headlineResult.positions) {
    const lev = headlineCfg.pairLeverage ?? 1;
    const shortNotional = headlineCfg.pairTrade ? (p.size / 2) * lev : p.size;
    const yld = SECTOR_DIV_YIELD[p.sector] ?? 0.02;
    const divCost = shortNotional * yld * (p.daysHeld / 365.25);
    totalDivCost += divCost;
    divAdjustedFinal += p.pnl - divCost;
  }
  const divTotalRet = (divAdjustedFinal - STARTING_BALANCE) / STARTING_BALANCE;
  const firstEntryDiv = headlineResult.positions[0]?.entryDate;
  const lastExitDiv = headlineResult.positions.reduce(
    (a, p) => (p.exitDate > a ? p.exitDate : a),
    headlineResult.positions[0]?.exitDate ?? ""
  );
  const yrsDiv =
    firstEntryDiv && lastExitDiv ? yearsBetween(firstEntryDiv, lastExitDiv) : 0;
  const divAdjustedAnn =
    yrsDiv > 0 && 1 + divTotalRet > 0
      ? Math.pow(1 + divTotalRet, 1 / yrsDiv) - 1
      : 0;
  const dividendImpact = {
    totalDivCost,
    finalEquity: divAdjustedFinal,
    annualizedReturn: divAdjustedAnn,
    deltaPp: divAdjustedAnn - ourAnn,
  };
  console.log(
    `  total dividend cost on shorts:    $${totalDivCost.toFixed(0)}`
  );
  console.log(
    `  div-adjusted final:               $${divAdjustedFinal.toFixed(0)}  ann ${(divAdjustedAnn * 100).toFixed(1)}%  Δ ${(((divAdjustedAnn - ourAnn) * 100)).toFixed(1)}pp`
  );

  // ─── Single-position blowup stress ────────────────────────────────
  // For each headline position, walk monthly bars from entry to exit and
  // compute the worst MTM drawdown ON THAT ONE POSITION (in isolation).
  console.log("\n=== single-position blowup stress ===");
  type PositionDD = {
    ticker: string;
    sector: string;
    entryDate: string;
    worstMtmRet: number; // most-negative monthly MTM return on the position
    finalRet: number;
  };
  const positionDDs: PositionDD[] = [];
  for (const p of headlineResult.positions) {
    const tickerBars = barsByTicker.get(p.ticker);
    if (!tickerBars || !spyBars) continue;
    const entryT = priceAtOrAfter(tickerBars, p.entryDate);
    const entryS = priceAtOrAfter(spyBars, p.entryDate);
    if (!entryT || !entryS) continue;
    let worstMtm = 0;
    let cur = new Date(p.entryDate);
    const last = new Date(p.exitDate);
    while (cur <= last) {
      const ymd = cur.toISOString().slice(0, 10);
      const tBar = priceClosestBefore(tickerBars, ymd);
      const sBar = priceClosestBefore(spyBars, ymd);
      if (tBar && sBar) {
        const tickerRet = (tBar.close - entryT.close) / entryT.close;
        const spyRet = (sBar.close - entryS.close) / entryS.close;
        // Pair P&L on this single position, in % of position size
        const lev = headlineCfg.pairLeverage ?? 1;
        const pairRet = (-tickerRet + spyRet) * (lev / 2);
        if (pairRet < worstMtm) worstMtm = pairRet;
      }
      cur = new Date(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1);
    }
    positionDDs.push({
      ticker: p.ticker,
      sector: p.sector,
      entryDate: p.entryDate,
      worstMtmRet: worstMtm,
      finalRet: p.pnl / p.size,
    });
  }
  positionDDs.sort((a, b) => a.worstMtmRet - b.worstMtmRet);
  console.log(`  Worst single-position interim MTM (on the position itself):`);
  for (const d of positionDDs.slice(0, 5)) {
    console.log(
      `    ${d.ticker.padEnd(8)} ${d.sector.slice(0, 18).padEnd(18)} ${d.entryDate} → worst ${(d.worstMtmRet * 100).toFixed(1)}%  final ${(d.finalRet * 100).toFixed(1)}%`
    );
  }

  // ─── Market-beta regression (factor exposure, simplest version) ───
  console.log("\n=== market-beta regression vs SPY ===");
  let beta: number | null = null;
  let alphaAnn: number | null = null;
  let rSquared: number | null = null;
  if (headlineResult.positions.length > 0 && spyBars) {
    const curve = buildEquityCurve(headlineResult.positions, STARTING_BALANCE);
    const portRets = monthlyReturns(curve);
    const spyByMonth = new Map<string, number>();
    for (const b of spyBars) spyByMonth.set(b.date.slice(0, 7), b.close);
    const months = curve.map((c) => c.date.slice(0, 7));
    const spyVals = months.map((m) => spyByMonth.get(m) ?? null);
    const spyRets: Array<number | null> = [];
    for (let i = 1; i < spyVals.length; i++) {
      const a = spyVals[i - 1];
      const b = spyVals[i];
      spyRets.push(a != null && b != null && a !== 0 ? (b - a) / a : null);
    }
    // OLS: portRet = alpha + beta * spyRet
    const xys: Array<[number, number]> = [];
    for (let i = 0; i < portRets.length; i++) {
      const s = spyRets[i];
      if (s != null && Number.isFinite(s) && Number.isFinite(portRets[i])) {
        xys.push([s, portRets[i]]);
      }
    }
    if (xys.length >= 12) {
      const xMean = xys.reduce((a, [x]) => a + x, 0) / xys.length;
      const yMean = xys.reduce((a, [, y]) => a + y, 0) / xys.length;
      let numer = 0,
        denom = 0,
        ssTot = 0;
      for (const [x, y] of xys) {
        numer += (x - xMean) * (y - yMean);
        denom += (x - xMean) * (x - xMean);
        ssTot += (y - yMean) * (y - yMean);
      }
      beta = denom > 0 ? numer / denom : null;
      const alphaMonthly = beta != null ? yMean - beta * xMean : null;
      alphaAnn = alphaMonthly != null ? alphaMonthly * 12 : null;
      // R^2
      let ssRes = 0;
      if (beta != null && alphaMonthly != null) {
        for (const [x, y] of xys) {
          const yhat = alphaMonthly + beta * x;
          ssRes += (y - yhat) * (y - yhat);
        }
        rSquared = ssTot > 0 ? 1 - ssRes / ssTot : null;
      }
    }
  }
  const factorExposure = {
    marketBeta: beta,
    alphaAnnualized: alphaAnn,
    rSquared,
  };
  console.log(
    `  market beta:           ${beta != null ? beta.toFixed(3) : "—"} (pair trades should be ~0)`
  );
  console.log(
    `  alpha (annualized):    ${alphaAnn != null ? (alphaAnn * 100).toFixed(1) + "%" : "—"}`
  );
  console.log(
    `  R²:                    ${rSquared != null ? rSquared.toFixed(3) : "—"}`
  );

  // Transaction-cost sensitivity. Real round-trip costs:
  //   liquid SP500 bid-ask: 1-5bps
  //   slippage on market orders: 5-15bps
  //   pair trade has 2 legs → roughly double the per-leg cost
  // Effective round-trip ranges: 10bps (best, limit orders, big caps) to
  // 100bps (market orders, illiquid names).
  console.log("\n=== transaction-cost sensitivity (headline) ===");
  type TxnSens = {
    bpsRoundTrip: number;
    finalEquity: number;
    annualizedReturn: number | null;
    deltaPp: number;
  };
  const txnSensitivities: TxnSens[] = [];
  for (const bps of [0, 10, 25, 50, 100]) {
    let adjustedFinal = STARTING_BALANCE;
    for (const p of headlineResult.positions) {
      const lev = headlineCfg.pairLeverage ?? 1;
      const grossNotional = headlineCfg.pairTrade
        ? p.size * lev // pair trade has 2 legs of half-size each = full size at lev
        : p.size;
      const txnCost = (bps / 10000) * grossNotional;
      adjustedFinal += p.pnl - txnCost;
    }
    const totalReturn = (adjustedFinal - STARTING_BALANCE) / STARTING_BALANCE;
    const firstEntry = headlineResult.positions[0]?.entryDate;
    const lastExit = headlineResult.positions.reduce(
      (a, p) => (p.exitDate > a ? p.exitDate : a),
      headlineResult.positions[0]?.exitDate ?? ""
    );
    const yrs = firstEntry && lastExit ? yearsBetween(firstEntry, lastExit) : 0;
    const ann =
      1 + totalReturn > 0 && yrs > 0
        ? Math.pow(1 + totalReturn, 1 / yrs) - 1
        : 0;
    txnSensitivities.push({
      bpsRoundTrip: bps,
      finalEquity: adjustedFinal,
      annualizedReturn: ann,
      deltaPp: ann - headlineAnn,
    });
    console.log(
      `  txn ${bps.toString().padStart(3)}bps → $${adjustedFinal.toFixed(0).padStart(7)}  ann ${(ann * 100).toFixed(1).padStart(5)}%`
    );
  }

  // Borrow-cost sensitivity
  console.log("\n=== borrow-cost sensitivity (headline strategy) ===");
  type Sensitivity = {
    annualBorrow: number;
    finalEquity: number;
    annualizedReturn: number | null;
    deltaPp: number;
  };
  const sensitivities: Sensitivity[] = [];
  const baseBorrow = ANNUAL_BORROW_COST;
  // Hack: we don't expose ANNUAL_BORROW_COST per-strategy. Recompute P&L
  // post-hoc by adjusting borrow cost on each position's days-held.
  for (const altBorrow of [0.005, 0.02, 0.05, 0.10, 0.20]) {
    let adjustedFinal = STARTING_BALANCE;
    for (const p of headlineResult.positions) {
      const baseCostPct = baseBorrow * (p.daysHeld / 365.25);
      const newCostPct = altBorrow * (p.daysHeld / 365.25);
      // P&L = -size × ret − size × cost; restore the cost component, swap.
      // For pair trades, original used halfSize × pairLev (size/2 × lev).
      const cfg = headlineCfg;
      const lev = cfg.pairLeverage ?? 1;
      const shortNotional = cfg.pairTrade ? (p.size / 2) * lev : p.size;
      const adjustedPnL =
        p.pnl + shortNotional * baseCostPct - shortNotional * newCostPct;
      adjustedFinal += adjustedPnL;
    }
    const totalReturn = (adjustedFinal - STARTING_BALANCE) / STARTING_BALANCE;
    const firstEntry = headlineResult.positions[0]?.entryDate;
    const lastExit = headlineResult.positions.reduce(
      (a, p) => (p.exitDate > a ? p.exitDate : a),
      headlineResult.positions[0]?.exitDate ?? ""
    );
    const yrs = firstEntry && lastExit ? yearsBetween(firstEntry, lastExit) : 0;
    const ann =
      1 + totalReturn > 0 && yrs > 0
        ? Math.pow(1 + totalReturn, 1 / yrs) - 1
        : 0;
    sensitivities.push({
      annualBorrow: altBorrow,
      finalEquity: adjustedFinal,
      annualizedReturn: ann,
      deltaPp: ann - headlineAnn,
    });
    console.log(
      `  borrow ${(altBorrow * 100).toFixed(1).padStart(4)}% → $${adjustedFinal.toFixed(0).padStart(7)}  ann ${(ann * 100).toFixed(1).padStart(5)}%`
    );
  }

  // Benchmarks: SPY buy-and-hold and 60/40 over the same window
  console.log("\n=== benchmarks over same window ===");
  type Benchmark = {
    name: string;
    description: string;
    finalEquity: number;
    annualizedReturn: number;
  };
  const benchmarks: Benchmark[] = [];
  if (spyBars && headlineResult.positions.length > 0) {
    const startDate = headlineResult.positions[0].entryDate;
    const endDate = headlineResult.positions.reduce(
      (a, p) => (p.exitDate > a ? p.exitDate : a),
      headlineResult.positions[0].exitDate
    );
    const startBar = priceAtOrAfter(spyBars, startDate);
    const endBar = priceClosestBefore(spyBars, endDate) ?? priceAtOrAfter(spyBars, endDate);
    if (startBar && endBar) {
      const spyRet = (endBar.close - startBar.close) / startBar.close;
      const yrs = yearsBetween(startDate, endDate);
      const spyAnn = yrs > 0 ? Math.pow(1 + spyRet, 1 / yrs) - 1 : 0;
      const spyFinal = STARTING_BALANCE * (1 + spyRet);
      benchmarks.push({
        name: "SPY buy-and-hold",
        description: `100% SPY, no rebalancing, same window (${startDate.slice(0,7)}→${endDate.slice(0,7)})`,
        finalEquity: spyFinal,
        annualizedReturn: spyAnn,
      });
      // 60/40: 60% SPY + 40% T-bills @ 4% annual
      const tbillRet = Math.pow(1 + 0.04, yrs) - 1;
      const blendRet = 0.6 * spyRet + 0.4 * tbillRet;
      const blendFinal = STARTING_BALANCE * (1 + blendRet);
      const blendAnn = yrs > 0 ? Math.pow(1 + blendRet, 1 / yrs) - 1 : 0;
      benchmarks.push({
        name: "60/40 (SPY + T-bills)",
        description: "60% SPY, 40% 4% T-bills, no rebalancing",
        finalEquity: blendFinal,
        annualizedReturn: blendAnn,
      });
      // Cash @ 4% T-bill
      const cashFinal = STARTING_BALANCE * Math.pow(1 + 0.04, yrs);
      benchmarks.push({
        name: "T-bills only",
        description: "100% T-bills compounding at 4% annual",
        finalEquity: cashFinal,
        annualizedReturn: 0.04,
      });
    }
  }
  for (const b of benchmarks) {
    console.log(
      `  ${b.name.padEnd(28)} → $${b.finalEquity.toFixed(0).padStart(7)}  ann ${(b.annualizedReturn * 100).toFixed(1).padStart(5)}%`
    );
  }

  const outPath = path.resolve(process.cwd(), "public/data/portfolio-sim.json");
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        startingBalance: STARTING_BALANCE,
        annualBorrowCost: ANNUAL_BORROW_COST,
        results: results.map((r, i) => {
          const cfg = STRATEGIES[i];
          // Compute peak gross deployment as a fraction of starting capital.
          // <=1.0 means strictly unleveraged; >1.0 implies margin/leverage.
          const lev = cfg.pairLeverage ?? 1;
          const sizeFrac =
            cfg.compoundFraction != null
              ? cfg.compoundFraction
              : cfg.positionSize / STARTING_BALANCE;
          const peakGrossDeployment = sizeFrac * cfg.maxConcurrent * lev;
          return {
            name: r.name,
            description: r.description,
            config: r.config,
            peakGrossDeployment,
            unleveraged: peakGrossDeployment <= 1.001,
            // Strategy clears the user's annualized-return bar (true)
            // or doesn't (false). When false, the screen recommends "wait".
            meets12PctBar:
              r.annualizedReturn != null && r.annualizedReturn >= ANNUALIZED_BAR,
            nFiltered: r.nFiltered,
            nTaken: r.nTaken,
            nWon: r.nWon,
            nStoppedOut: r.nStoppedOut,
            nTakeProfit: r.nTakeProfit,
            finalEquity: r.finalEquity,
            totalReturn: r.totalReturn,
            annualizedReturn: r.annualizedReturn,
            winRate: r.winRate,
            meanPnLPerPos: r.meanPnLPerPos,
            maxDrawdown: r.maxDrawdown,
            metrics: r.metrics,
          };
        }),
        bySector: bySector.map((r) => ({
          sector: r.sector,
          name: r.name,
          description: r.description,
          config: r.config,
          nFiltered: r.nFiltered,
          nTaken: r.nTaken,
          nWon: r.nWon,
          finalEquity: r.finalEquity,
          totalReturn: r.totalReturn,
          annualizedReturn: r.annualizedReturn,
          winRate: r.winRate,
          meanPnLPerPos: r.meanPnLPerPos,
          maxDrawdown: r.maxDrawdown,
          bestPos: r.bestPos
            ? {
                ticker: r.bestPos.ticker,
                entryDate: r.bestPos.entryDate,
                pnl: r.bestPos.pnl,
                ret: r.bestPos.ret,
              }
            : null,
          worstPos: r.worstPos
            ? {
                ticker: r.worstPos.ticker,
                entryDate: r.worstPos.entryDate,
                pnl: r.worstPos.pnl,
                ret: r.worstPos.ret,
              }
            : null,
        })),
        // ─── New: deeper evaluation outputs ──────────────────────────
        headline: {
          name: headlineResult.name,
          description: headlineResult.description,
          finalEquity: headlineResult.finalEquity,
          annualizedReturn: headlineResult.annualizedReturn,
          metrics: headlineResult.metrics,
          // Full per-trade detail for the headline strategy. Useful for
          // post-mortems and sanity checks.
          positions: headlineResult.positions.map((p) => ({
            ticker: p.ticker,
            sector: p.sector,
            entryDate: p.entryDate,
            exitDate: p.exitDate,
            daysHeld: p.daysHeld,
            size: p.size,
            ret: p.ret,
            pnl: p.pnl,
            exitReason: p.exitReason,
            mlScore: p.mlScore,
            trailing6m: p.trailing6m,
          })),
        },
        ablations,
        sensitivities,
        txnSensitivities,
        benchmarks,
        pValueResult,
        hpSensitivities,
        dividendImpact,
        positionDDs,
        factorExposure,
        subperiods,
        tailRisk,
        calibration: calibBuckets,
        walkForward,
        looseResults,
        ytd2026,
        ytd2026Opened,
        ytd2026Exited,
        ytd2026Total: total2026PnL,
        ytd2026Candidates,
        regimes,
        mlSizingVariant: {
          name: mlSizingCfg.name,
          description: mlSizingCfg.description,
          finalEquity: mlSizingResult.finalEquity,
          annualizedReturn: mlSizingResult.annualizedReturn,
          winRate: mlSizingResult.winRate,
          nTaken: mlSizingResult.nTaken,
        },
        annualizedBar: ANNUALIZED_BAR,
        riskFreeRate: RF_ANNUAL,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
