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
  scoreFeatures,
  type ModelWeights,
} from "../lib/ml-score";
import type { Sector } from "../lib/universe";

// ─── Defaults (overridable in StrategyConfig) ────────────────────────
const STARTING_BALANCE = 10_000;
const ANNUAL_BORROW_COST = 0.02; // 2% annualized
// Average T-bill yield 2010-2025; used to credit idle cash when enabled.
// Closer to actual rates than zero. (3-month T-bill avg over the period
// was ~1.4%, but the 2022-2024 hike phase pushed the trailing avg up.)
const IDLE_CASH_YIELD = 0.02;

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
  alpha1y: number | null;
  ret1y: number | null;
  ret6m: number | null;
};

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
  mlScore: number | null;
  trailing6m: number | null;
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
  barsByTicker: Map<string, Bar[]>
): Promise<StrategyResult> {
  // Pre-enrich each event with ML score + trailing-6m return.
  const enriched = events.map((e) => {
    const fv = buildFeatureVector(e);
    const mlScore = fv && model ? scoreFeatures(fv, model) : null;
    const bars = barsByTicker.get(e.ticker);
    const t6 = bars ? trailing6m(bars, e.filed) : null;
    return { e, mlScore, trailing6m: t6, bars };
  });

  // Apply strategy filter and chronologically order.
  const filtered = enriched
    .filter(({ e, mlScore, trailing6m }) =>
      cfg.filter(e, { mlScore, trailing6m })
    )
    .sort((a, b) => a.e.filed.localeCompare(b.e.filed));

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

  for (const { e, mlScore, trailing6m, bars } of filtered) {
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
  console.log(
    `loaded bars for ${barsByTicker.size}/${tickers.length} tickers; ${allEvents.length} events`
  );
  console.log(`start=$${STARTING_BALANCE}  borrow=${(ANNUAL_BORROW_COST * 100).toFixed(1)}%/yr\n`);

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
    const r = await simulate(allEvents, cfg, model, barsByTicker);
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
    const r = await simulate(allEvents, cfg, model, barsByTicker);
    bySector.push({ sector, ...r });
    console.log(
      sector.padEnd(24) +
        ` | ${r.nFiltered.toString().padStart(5)} | ${r.nTaken.toString().padStart(5)} | ${fmtUSD(r.finalEquity).padStart(9)} | ${fmtPct(r.totalReturn).padStart(7)} | ${fmtPct(r.annualizedReturn).padStart(5)} | ${fmtPct(r.winRate).padStart(5)} | ${fmtPct(r.maxDrawdown).padStart(5)}`
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
        results: results.map((r) => ({
          name: r.name,
          description: r.description,
          config: r.config,
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
        })),
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
