// Daily MTM digest → Telegram.
//
// Run after market close (4 PM ET = 22:00 UTC). For each currently-open
// paper trade:
//   1. Fetch fresh Yahoo daily bars (small N — only currently open tickers).
//   2. Compute MTM using latest close.
//   3. If today >= expectedExitDate, auto-close the trade and fire ✅/❌
//      with realized P&L.
//   4. Otherwise update currentMtmPnL on the trade.
// Then send a single 📊 daily-summary Telegram with totals + per-position
// detail + biggest mover.
//
// No-ops gracefully when paper-trades.json has no open trades — sends a
// "no open trades" digest so the user knows the script ran.

import { promises as fs } from "node:fs";
import path from "node:path";
import { notify } from "../lib/notify";

const SITE_URL = process.env.SITE_URL ?? "https://short-that-shit.vercel.app";
const PAPER_PATH = path.resolve(process.cwd(), "public", "data", "paper-trades.json");
const POSITION_SIZE = 10000; // $10K per paper trade — same as paper-trade-update.ts

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

function snapToBusinessDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.max(
    0,
    Math.round((new Date(b).getTime() - new Date(a).getTime()) / (24 * 3600 * 1000))
  );
}

// Fetch Yahoo daily bars for the last 30 days. Always fresh (no cache) —
// 4-10 tickers per run, fast enough.
async function fetchYahooDaily(ticker: string): Promise<Bar[] | null> {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 60 * 24 * 3600; // 60 days back
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d&events=history`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d&events=history`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36",
          Accept: "application/json",
        },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      const result = data.chart?.result?.[0];
      if (!result) continue;
      const ts: number[] = result.timestamp ?? [];
      const closes: (number | null)[] =
        result.indicators?.adjclose?.[0]?.adjclose ??
        result.indicators?.quote?.[0]?.close ??
        [];
      const bars: Bar[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (c == null) continue;
        bars.push({
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          close: c,
        });
      }
      if (bars.length === 0) continue;
      return bars;
    } catch {
      /* try next mirror */
    }
  }
  return null;
}

async function main() {
  const today = snapToBusinessDay(new Date().toISOString().slice(0, 10));
  const raw = await fs.readFile(PAPER_PATH, "utf8");
  const paper = JSON.parse(raw) as PaperTradeFile;

  const openTrades = paper.trades.filter((t) => t.status === "open");
  if (openTrades.length === 0) {
    const msg = `📊 *Daily summary — ${today}*\nNo open paper trades.\n[Open dashboard](${SITE_URL})`;
    console.log(msg);
    await notify(msg);
    return;
  }

  type EnrichedTrade = {
    trade: PaperTrade;
    entryClose: number;
    todayClose: number;
    yesterdayClose: number | null;
    mtmPnL: number;
    mtmRet: number;
    todayMove: number | null;
    daysHeld: number;
    daysToClose: number;
    closingToday: boolean;
  };

  const enriched: EnrichedTrade[] = [];
  const closedTodayForNotify: Array<{ ticker: string; sector: string; pnl: number; ret: number; entry: string; exit: string }> = [];

  for (const t of openTrades) {
    const bars = await fetchYahooDaily(t.ticker);
    if (!bars || bars.length < 2) {
      console.error(`[daily-summary] skipping ${t.ticker}: no bars`);
      continue;
    }
    // Find entry-date close (or first bar at-or-after) and latest close.
    const entryBar =
      bars.find((b) => b.date >= t.entryDate) ?? bars[0];
    const todayBar = bars[bars.length - 1];
    const yesterdayBar = bars.length >= 2 ? bars[bars.length - 2] : null;
    if (entryBar.close <= 0 || todayBar.close <= 0) continue;

    const ret = (todayBar.close - entryBar.close) / entryBar.close;
    const mtmPnL = -POSITION_SIZE * ret; // single-leg short paper
    const todayMove =
      yesterdayBar && yesterdayBar.close > 0
        ? (todayBar.close - yesterdayBar.close) / yesterdayBar.close
        : null;
    const daysHeld = daysBetween(t.entryDate, today);
    const daysToClose = daysBetween(today, t.expectedExitDate);
    const closingToday = today >= t.expectedExitDate;

    enriched.push({
      trade: t,
      entryClose: entryBar.close,
      todayClose: todayBar.close,
      yesterdayClose: yesterdayBar?.close ?? null,
      mtmPnL,
      mtmRet: ret,
      todayMove,
      daysHeld,
      daysToClose,
      closingToday,
    });

    // Auto-close if past expected exit date
    if (closingToday) {
      t.status = "closed";
      t.exitDate = today;
      t.realizedPnL = mtmPnL;
      t.realizedReturn = ret;
      t.currentMtmPnL = null;
      closedTodayForNotify.push({
        ticker: t.ticker,
        sector: t.sector,
        pnl: mtmPnL,
        ret,
        entry: t.entryDate,
        exit: today,
      });
    } else {
      t.currentMtmPnL = mtmPnL;
    }
  }

  paper.lastUpdated = today;
  await fs.writeFile(PAPER_PATH, JSON.stringify(paper, null, 2) + "\n", "utf8");

  // Fire close-trade Telegrams BEFORE the digest, so they land in order.
  for (const c of closedTodayForNotify) {
    const sign = c.pnl >= 0 ? "✅" : "❌";
    const msg =
      `${sign} paper trade closed: *${c.ticker}* (${c.sector})\n` +
      `entry ${c.entry} → exit ${c.exit}\n` +
      `realized P&L *$${c.pnl.toFixed(0)}* (${(c.ret * 100).toFixed(1)}% stock move)`;
    await notify(msg);
  }

  // Build the digest
  const totalMtm = enriched
    .filter((e) => !e.closingToday) // closed-today are reported separately above
    .reduce((acc, e) => acc + e.mtmPnL, 0);
  const totalSize = enriched.filter((e) => !e.closingToday).length * POSITION_SIZE;
  const totalRet = totalSize > 0 ? totalMtm / totalSize : 0;

  // Find biggest mover today (one-day return)
  const movers = enriched
    .filter((e) => e.todayMove != null)
    .sort((a, b) => Math.abs(b.todayMove!) - Math.abs(a.todayMove!));
  const biggest = movers[0] ?? null;

  const stillOpen = enriched.filter((e) => !e.closingToday);
  const lines: string[] = [];
  lines.push(`📊 *Daily summary — ${today}*`);
  if (stillOpen.length === 0) {
    lines.push(`All ${closedTodayForNotify.length} positions closed today (see above).`);
  } else {
    const sign = totalMtm >= 0 ? "+" : "";
    lines.push(
      `${stillOpen.length} open · total MTM ${sign}$${Math.round(totalMtm).toLocaleString()} (${sign}${(totalRet * 100).toFixed(1)}%)`
    );
    for (const e of stillOpen) {
      const s = e.mtmPnL >= 0 ? "+" : "";
      const moveStr =
        e.todayMove != null ? ` · today ${e.todayMove >= 0 ? "+" : ""}${(e.todayMove * 100).toFixed(1)}%` : "";
      lines.push(
        `• \`${e.trade.ticker}\` ${s}$${Math.round(e.mtmPnL)} (${s}${(e.mtmRet * 100).toFixed(1)}%)${moveStr} · ${e.daysHeld}d held · ${e.daysToClose}d to close`
      );
    }
    if (biggest && biggest.todayMove != null) {
      const sign = biggest.todayMove >= 0 ? "+" : "";
      lines.push(`Biggest mover today: *${biggest.trade.ticker}* ${sign}${(biggest.todayMove * 100).toFixed(1)}%`);
    }
  }
  lines.push(`[Open dashboard](${SITE_URL})`);
  const body = lines.join("\n");
  console.log(body);
  await notify(body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
