// Monthly maintenance for the live paper-trade tracker.
//
// 1. Read public/data/screen.json — current matched names from the live
//    base screen + headline-strategy filter status.
// 2. Read public/data/paper-trades.json — existing trades.
// 3. For each currently-matched name not yet in the tracker, append a
//    new "open" entry with today's entry date and expected 12m exit.
// 4. For each existing OPEN trade, mark-to-market using cached Yahoo
//    bars (or skip if bars missing).
// 5. For each trade past its expectedExitDate, close it and record
//    realized P&L.
// 6. Write back paper-trades.json.
//
// This is intentionally additive — never deletes prior trades — so the
// forward record accumulates over real time. After ~12 months we'll have
// a real out-of-sample track record that's independent of the in-sample
// backtest.

import { promises as fs } from "node:fs";
import path from "node:path";
import { readCache } from "../lib/cache";
import { notify } from "../lib/notify";
import type { ScreenResult } from "../lib/types";

const SITE_URL = process.env.SITE_URL ?? "https://short-that-shit.vercel.app";

type Bar = { date: string; close: number };

type PaperTrade = {
  ticker: string;
  entityName: string;
  sector: string;
  entryDate: string;
  expectedExitDate: string;
  matchesHeadline: boolean;
  matchedFilter: string;
  matchExclusions: string[];
  deAtEntry: number | null;
  yoy_t_atEntry: number | null;
  status: "open" | "closed";
  currentMtmPnL: number | null;
  realizedPnL: number | null;
  realizedReturn: number | null;
  exitDate: string | null;
  notes: string;
};

type PaperTradeFile = {
  _doc?: string;
  trackingSince: string;
  lastUpdated: string;
  trades: PaperTrade[];
};

const SCREEN_PATH = path.resolve(process.cwd(), "public/data/screen.json");
const PAPER_PATH = path.resolve(process.cwd(), "public/data/paper-trades.json");
const POSITION_SIZE = 5_000; // $5K notional per leg for unleveraged paper trades

function addMonths(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

// Markets are closed on weekends — pull weekend dates back to the prior
// Friday so paper-trade entry/exit dates always match a real trading day.
function snapToBusinessDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function loadBars(ticker: string): Promise<Bar[] | null> {
  try {
    const cached = await readCache<Bar[]>(`yahoo-monthly-${ticker}`);
    if (Array.isArray(cached)) return cached;
  } catch {}
  return null;
}

function priceClosestBefore(bars: Bar[], iso: string): Bar | null {
  let best: Bar | null = null;
  for (const b of bars) {
    if (b.date <= iso) best = b;
    else break;
  }
  return best;
}

function priceAtOrAfter(bars: Bar[], iso: string): Bar | null {
  for (const b of bars) if (b.date >= iso) return b;
  return null;
}

async function main() {
  const todayRaw = new Date().toISOString().slice(0, 10);
  const today = snapToBusinessDay(todayRaw);

  const screenRaw = await fs.readFile(SCREEN_PATH, "utf8");
  const screen = JSON.parse(screenRaw) as ScreenResult;
  const paperRaw = await fs.readFile(PAPER_PATH, "utf8");
  const paper = JSON.parse(paperRaw) as PaperTradeFile;

  const existingOpenByTicker = new Map<string, PaperTrade>();
  for (const t of paper.trades) {
    if (t.status === "open") existingOpenByTicker.set(t.ticker, t);
  }

  // Step 1: add new matches not already in tracker
  const matched = screen.rows.filter((r) => r.matched);
  let added = 0;
  const newTradesForNotify: Array<{ ticker: string; sector: string; matchesHeadline: boolean; de: number | null; yoy: number | null }> = [];
  for (const r of matched) {
    if (existingOpenByTicker.has(r.ticker)) continue;
    const matchesHeadline = !!r.matched && !r.regimeExcluded && !r.sectorIneligible;
    const exclusions: string[] = [];
    if (r.regimeExcluded) exclusions.push(`regime-excluded (${r.regimeExclusionReason ?? ""})`);
    if (r.sectorIneligible) exclusions.push("sector ineligible");
    paper.trades.push({
      ticker: r.ticker,
      entityName: r.entityName,
      sector: r.sector ?? "Unknown",
      entryDate: today,
      expectedExitDate: snapToBusinessDay(addMonths(today, 12)),
      matchesHeadline,
      matchedFilter: matchesHeadline ? "headline" : "base-screen",
      matchExclusions: exclusions,
      deAtEntry: r.debtToEquity,
      yoy_t_atEntry: r.yoy_t,
      status: "open",
      currentMtmPnL: null,
      realizedPnL: null,
      realizedReturn: null,
      exitDate: null,
      notes: `Surfaced ${today} from screen.`,
    });
    added++;
    newTradesForNotify.push({
      ticker: r.ticker,
      sector: r.sector ?? "Unknown",
      matchesHeadline,
      de: r.debtToEquity,
      yoy: r.yoy_t,
    });
  }

  // Step 2: mark open trades to market + auto-close at expected exit
  let marked = 0;
  let closed = 0;
  const closedForNotify: Array<{ ticker: string; sector: string; pnl: number; ret: number; entry: string; exit: string }> = [];
  for (const t of paper.trades) {
    if (t.status !== "open") continue;
    const bars = await loadBars(t.ticker);
    if (!bars || bars.length === 0) continue;

    const entryBar = priceAtOrAfter(bars, t.entryDate);
    if (!entryBar) continue;
    const targetExit = t.expectedExitDate;
    const shouldClose = today >= targetExit;
    const cur = priceClosestBefore(bars, today);
    if (!cur) continue;
    const ret = entryBar.close > 0 ? (cur.close - entryBar.close) / entryBar.close : 0;
    // Naive single-leg short P&L (paper-only; no SPY hedge for tracker).
    const mtmPnL = -POSITION_SIZE * ret;

    if (shouldClose) {
      t.status = "closed";
      t.exitDate = today;
      t.realizedPnL = mtmPnL;
      t.realizedReturn = ret;
      t.currentMtmPnL = null;
      closed++;
      closedForNotify.push({
        ticker: t.ticker,
        sector: t.sector,
        pnl: mtmPnL,
        ret,
        entry: t.entryDate,
        exit: today,
      });
    } else {
      t.currentMtmPnL = mtmPnL;
      marked++;
    }
  }

  paper.lastUpdated = today;
  await fs.writeFile(PAPER_PATH, JSON.stringify(paper, null, 2) + "\n", "utf8");

  console.log(
    `[paper-trade-update] ${added} added, ${marked} marked, ${closed} closed (lastUpdated ${today})`
  );
  console.log(
    `  open: ${paper.trades.filter((t) => t.status === "open").length}`
  );
  console.log(
    `  closed: ${paper.trades.filter((t) => t.status === "closed").length}`
  );

  // Telegram notifications: one message per new trigger (high-signal),
  // one message per closed trade (realized P&L). Keep these terse.
  for (const n of newTradesForNotify) {
    const dePart = n.de != null ? ` D/E ${n.de.toFixed(1)}` : "";
    const yoyPart = n.yoy != null ? `, YoY ${(n.yoy * 100).toFixed(1)}%` : "";
    const tag = n.matchesHeadline ? "🎯 *HEADLINE*" : "📋 base-screen";
    const url = `${SITE_URL}`;
    const msg =
      `${tag} new short trigger\n` +
      `*${n.ticker}* (${n.sector})${dePart}${yoyPart}\n` +
      `[Open dashboard](${url}) · [Yahoo](https://finance.yahoo.com/quote/${encodeURIComponent(n.ticker)})`;
    await notify(msg);
  }
  for (const c of closedForNotify) {
    const sign = c.pnl >= 0 ? "✅" : "❌";
    const msg =
      `${sign} paper trade closed: *${c.ticker}* (${c.sector})\n` +
      `entry ${c.entry} → exit ${c.exit}\n` +
      `realized P&L *$${c.pnl.toFixed(0)}* (${(c.ret * 100).toFixed(1)}% stock move)`;
    await notify(msg);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
