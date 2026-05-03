"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ModelWeights } from "@/lib/ml-score";

type BacktestEvent = {
  ticker: string;
  sector: string;
  endYear: number;
  end: string;
  filed: string;
  de: number | null;
  negEquity: boolean;
  yoy_t: number | null;
  yoy_t1: number | null;
  ocfYoY: number | null;
  ocfDecline2y: boolean;
  ret6m: number | null;
  ret1y: number | null;
  ret2y: number | null;
  alpha6m: number | null;
  alpha1y: number | null;
  alpha2y: number | null;
  spy1y: number | null;
};

type SectorStat = {
  count: number;
  meanAlpha1y: number | null;
  medianAlpha1y: number | null;
  hitRate: number | null;
  hitRateBigMiss: number | null;
};

type BacktestFile = {
  generatedAt: string;
  triggerCount: number;
  triggerCountAllSectors: number;
  excludedSectors: string[];
  aggregates: {
    overall: SectorStat;
    bySector: Record<string, SectorStat>;
    byDeBucket: Record<string, SectorStat>;
    byYear: Record<string, SectorStat>;
  };
  events: BacktestEvent[];
};

type PortfolioStrategyRow = {
  name: string;
  description: string;
  config: {
    positionSize: number;
    maxConcurrent: number;
    holdMonths: number;
    stopLossPct: number | null;
    takeProfitPct: number | null;
  };
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
  maxDrawdown: number;
};

type SectorPortfolioRow = {
  sector: string;
  name: string;
  description: string;
  config: PortfolioStrategyRow["config"];
  nFiltered: number;
  nTaken: number;
  nWon: number;
  finalEquity: number;
  totalReturn: number;
  annualizedReturn: number | null;
  winRate: number;
  meanPnLPerPos: number;
  maxDrawdown: number;
  bestPos: {
    ticker: string;
    entryDate: string;
    pnl: number;
    ret: number;
  } | null;
  worstPos: {
    ticker: string;
    entryDate: string;
    pnl: number;
    ret: number;
  } | null;
};

type PortfolioFile = {
  generatedAt: string;
  startingBalance: number;
  annualBorrowCost: number;
  results: PortfolioStrategyRow[];
  bySector?: SectorPortfolioRow[];
};

const fmtPct = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = n * 100;
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
};
const fmtPctNoSign = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
};
const fmtUSD = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};
const fmtNum = (n: number | null | undefined, dp = 2): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(dp);
};

function alphaColor(n: number | null | undefined, baseDim?: boolean): string {
  if (n == null) return "text-terminal-muted";
  if (n < -0.05) return "text-emerald-400";
  if (n > 0.05) return "text-red-400";
  return baseDim ? "text-terminal-muted" : "text-terminal-fg";
}

export function BacktestReview({
  backtest,
  portfolio,
  model,
}: {
  backtest: BacktestFile | null;
  portfolio: PortfolioFile | null;
  model: ModelWeights | null;
}) {
  return (
    <div className="min-h-screen bg-terminal-bg text-terminal-fg">
      <Header backtest={backtest} portfolio={portfolio} />
      <main className="mx-auto max-w-[1400px] space-y-12 px-6 pb-24">
        {portfolio && <Strategies portfolio={portfolio} />}
        {portfolio?.bySector && portfolio.bySector.length > 0 && (
          <PortfolioBySector portfolio={portfolio} />
        )}
        {backtest && <Sectors backtest={backtest} />}
        {backtest && <DeBuckets backtest={backtest} />}
        {model && <ModelCoefs model={model} />}
        {backtest && <Events backtest={backtest} />}
        <Footer />
      </main>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
function Header({
  backtest,
  portfolio,
}: {
  backtest: BacktestFile | null;
  portfolio: PortfolioFile | null;
}) {
  return (
    <header className="border-b border-terminal-border bg-terminal-panel/40 backdrop-blur">
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        <div className="flex items-baseline justify-between gap-6">
          <div>
            <Link
              href="/"
              className="text-xs uppercase tracking-wider text-terminal-muted hover:text-terminal-fg"
            >
              ← screen
            </Link>
            <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-terminal-fg">
              Backtest review
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-terminal-muted">
              Full historical evaluation: every screen-trigger event, all 25
              portfolio strategies tested against $10K starting capital, ML
              model coefficients, and per-sector / per-D-E hit rates. All
              numbers are downloadable as raw JSON below.
            </p>
          </div>
          <div className="font-data text-right text-xs text-terminal-muted">
            <div>
              backtest{" "}
              {backtest
                ? new Date(backtest.generatedAt).toISOString().slice(0, 19) + "Z"
                : "—"}
            </div>
            <div className="mt-1">
              portfolio{" "}
              {portfolio
                ? new Date(portfolio.generatedAt).toISOString().slice(0, 19) +
                  "Z"
                : "—"}
            </div>
            <div className="mt-2 space-x-2">
              <a
                href="/data/backtest.json"
                className="text-amber-accent hover:underline"
              >
                backtest.json
              </a>
              <span>·</span>
              <a
                href="/data/portfolio-sim.json"
                className="text-amber-accent hover:underline"
              >
                portfolio-sim.json
              </a>
              <span>·</span>
              <a
                href="/data/ml-model.json"
                className="text-amber-accent hover:underline"
              >
                ml-model.json
              </a>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

// ────────────────────────────────────────────────────────────────────────
function Strategies({ portfolio }: { portfolio: PortfolioFile }) {
  type Key =
    | "name"
    | "finalEquity"
    | "totalReturn"
    | "annualizedReturn"
    | "winRate"
    | "maxDrawdown"
    | "nTaken"
    | "holdMonths"
    | "positionSize";
  const [sortKey, setSortKey] = useState<Key>("finalEquity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const sorted = useMemo(() => {
    const rows = [...portfolio.results];
    rows.sort((a, b) => {
      const av =
        sortKey === "name"
          ? a.name
          : sortKey === "holdMonths"
            ? a.config.holdMonths
            : sortKey === "positionSize"
              ? a.config.positionSize
              : (a as any)[sortKey] ?? -Infinity;
      const bv =
        sortKey === "name"
          ? b.name
          : sortKey === "holdMonths"
            ? b.config.holdMonths
            : sortKey === "positionSize"
              ? b.config.positionSize
              : (b as any)[sortKey] ?? -Infinity;
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
  }, [portfolio.results, sortKey, sortDir]);

  function toggle(k: Key) {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir(k === "name" ? "asc" : "desc");
    }
  }

  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Portfolio strategies — ${portfolio.startingBalance.toLocaleString()}{" "}
        starting balance
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        {portfolio.results.length} variants evaluated. Borrow cost{" "}
        {fmtPctNoSign(portfolio.annualBorrowCost)} annualized. Pair-trade
        strategies split position 50/50 between short ticker and long SPY.
        Rows are sortable.
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <Th onClick={() => toggle("name")} active={sortKey === "name"} dir={sortDir}>
                Strategy
              </Th>
              <Th right onClick={() => toggle("positionSize")} active={sortKey === "positionSize"} dir={sortDir}>
                Pos $
              </Th>
              <Th right onClick={() => toggle("holdMonths")} active={sortKey === "holdMonths"} dir={sortDir}>
                Hold
              </Th>
              <Th right onClick={() => toggle("nTaken")} active={sortKey === "nTaken"} dir={sortDir}>
                n
              </Th>
              <Th right onClick={() => toggle("winRate")} active={sortKey === "winRate"} dir={sortDir}>
                Win
              </Th>
              <Th right onClick={() => toggle("finalEquity")} active={sortKey === "finalEquity"} dir={sortDir}>
                Final $
              </Th>
              <Th right onClick={() => toggle("totalReturn")} active={sortKey === "totalReturn"} dir={sortDir}>
                Total
              </Th>
              <Th right onClick={() => toggle("annualizedReturn")} active={sortKey === "annualizedReturn"} dir={sortDir}>
                Annualized
              </Th>
              <Th right onClick={() => toggle("maxDrawdown")} active={sortKey === "maxDrawdown"} dir={sortDir}>
                Max DD
              </Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const profit = r.totalReturn >= 0;
              return (
                <tr key={r.name} className="border-t border-terminal-border/50">
                  <td className="px-3 py-2">
                    <div className="font-data">{r.name}</div>
                    <div className="text-[10px] text-terminal-muted">
                      {r.description}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-data">
                    ${r.config.positionSize}
                  </td>
                  <td className="px-3 py-2 text-right font-data">
                    {r.config.holdMonths}m
                  </td>
                  <td className="px-3 py-2 text-right font-data text-terminal-muted">
                    {r.nTaken}
                  </td>
                  <td className="px-3 py-2 text-right font-data">
                    {fmtPctNoSign(r.winRate)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-data ${profit ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {fmtUSD(r.finalEquity)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-data ${profit ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {fmtPct(r.totalReturn)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-data ${(r.annualizedReturn ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {fmtPct(r.annualizedReturn)}
                  </td>
                  <td className="px-3 py-2 text-right font-data text-red-400">
                    {fmtPct(r.maxDrawdown)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function PortfolioBySector({ portfolio }: { portfolio: PortfolioFile }) {
  const rows = useMemo(() => {
    const r = [...(portfolio.bySector ?? [])];
    r.sort((a, b) => b.finalEquity - a.finalEquity);
    return r;
  }, [portfolio.bySector]);

  const winners = rows.filter((r) => r.totalReturn > 0 && r.nTaken > 0);
  const losers = rows.filter((r) => r.totalReturn < 0 && r.nTaken > 0);
  const empty = rows.filter((r) => r.nTaken === 0);

  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Returns by industry — pair-trade portfolio per sector
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        $10K starting balance, $5K per position (50/50 short / long SPY), 4 max
        concurrent, 12-month hold, 2% borrow. Filter: drop ocfDecline2y +
        only short stocks already in trailing-6m downtrend, then restrict to
        one sector at a time.{" "}
        <span className="text-amber-accent">
          This is the most actionable per-sector view —
        </span>{" "}
        it tells you what $10K would have actually become if you had only
        traded each industry in isolation.
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <th className="px-3 py-2 text-left">Sector</th>
              <th className="px-3 py-2 text-right">n</th>
              <th className="px-3 py-2 text-right">Final $</th>
              <th className="px-3 py-2 text-right">Total return</th>
              <th className="px-3 py-2 text-right">Annualized</th>
              <th className="px-3 py-2 text-right">Win rate</th>
              <th className="px-3 py-2 text-right">Max DD</th>
              <th className="px-3 py-2 text-left">Best position</th>
              <th className="px-3 py-2 text-left">Worst position</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const profit = r.totalReturn > 0;
              const empty = r.nTaken === 0;
              return (
                <tr
                  key={r.sector}
                  className={`border-t border-terminal-border/50 ${empty ? "opacity-40" : ""}`}
                >
                  <td className="px-3 py-2 font-data">{r.sector}</td>
                  <td className="px-3 py-2 text-right font-data text-terminal-muted">
                    {r.nTaken}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-data ${empty ? "text-terminal-muted" : profit ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {fmtUSD(r.finalEquity)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-data ${empty ? "text-terminal-muted" : profit ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {fmtPct(r.totalReturn)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-data ${empty ? "text-terminal-muted" : (r.annualizedReturn ?? 0) > 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {fmtPct(r.annualizedReturn)}
                  </td>
                  <td className="px-3 py-2 text-right font-data">
                    {fmtPctNoSign(r.winRate)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-data ${r.maxDrawdown < 0 ? "text-red-400" : "text-terminal-muted"}`}
                  >
                    {fmtPct(r.maxDrawdown)}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-terminal-muted">
                    {r.bestPos
                      ? `${r.bestPos.ticker} ${r.bestPos.entryDate.slice(0, 7)} (${fmtUSD(r.bestPos.pnl)}, ${fmtPct(r.bestPos.ret)})`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-terminal-muted">
                    {r.worstPos
                      ? `${r.worstPos.ticker} ${r.worstPos.entryDate.slice(0, 7)} (${fmtUSD(r.worstPos.pnl)}, ${fmtPct(r.worstPos.ret)})`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3 text-xs">
        <div className="rounded border border-emerald-700/40 bg-emerald-950/20 p-3">
          <div className="font-data text-[10px] uppercase tracking-wider text-emerald-400">
            Profitable sectors ({winners.length})
          </div>
          <div className="mt-1 leading-relaxed">
            {winners.length === 0
              ? "—"
              : winners
                  .map(
                    (r) =>
                      `${r.sector} ${fmtPct(r.totalReturn)} (n=${r.nTaken})`
                  )
                  .join(" · ")}
          </div>
        </div>
        <div className="rounded border border-red-700/40 bg-red-950/20 p-3">
          <div className="font-data text-[10px] uppercase tracking-wider text-red-400">
            Loss-making sectors ({losers.length})
          </div>
          <div className="mt-1 leading-relaxed">
            {losers.length === 0
              ? "—"
              : losers
                  .map(
                    (r) =>
                      `${r.sector} ${fmtPct(r.totalReturn)} (n=${r.nTaken})`
                  )
                  .join(" · ")}
          </div>
        </div>
        <div className="rounded border border-terminal-border bg-terminal-panel/30 p-3">
          <div className="font-data text-[10px] uppercase tracking-wider text-terminal-muted">
            Insufficient data ({empty.length})
          </div>
          <div className="mt-1 leading-relaxed">
            {empty.length === 0
              ? "—"
              : empty.map((r) => r.sector).join(" · ")}
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-terminal-muted">
        <span className="text-amber-accent">Honest read:</span> the strategy&apos;s
        portfolio-level edge is concentrated in{" "}
        <span className="font-data">Utilities</span> and{" "}
        <span className="font-data">Consumer Staples</span> — sectors with
        regulated or commoditized businesses where revenue declines genuinely
        signal distress (PG&amp;E pre-bankruptcy, AES, regulated electrics
        post-2019; staples names losing share to private label / DTC
        competition). <span className="font-data">Financials</span> is the most
        data-rich sector but a steady portfolio loser — even though per-event
        mean alpha looked benign, the bank-rally years (2012, 2015, 2021,
        2023) wipe out the post-crisis wins. <span className="font-data">Consumer Discretionary</span> is similarly cyclical and tends to mean-revert.
        Sample sizes for individual sectors are small; treat the per-sector
        return numbers as directional, not point estimates.
      </p>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function Sectors({ backtest }: { backtest: BacktestFile }) {
  const rows = Object.entries(backtest.aggregates.bySector)
    .map(([sector, s]) => ({ sector, ...s }))
    .sort((a, b) => (a.meanAlpha1y ?? 0) - (b.meanAlpha1y ?? 0));
  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Sector hit rates
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        Per-sector aggregate of historical screen triggers, sorted by mean
        forward alpha (most-negative = best historical short setups).
        Excluded sectors:{" "}
        {backtest.excludedSectors.length === 0
          ? "none"
          : backtest.excludedSectors.join(", ")}
        .
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <th className="px-3 py-2 text-left">Sector</th>
              <th className="px-3 py-2 text-right">n events</th>
              <th className="px-3 py-2 text-right">Mean α₁y</th>
              <th className="px-3 py-2 text-right">Median α₁y</th>
              <th className="px-3 py-2 text-right">Hit rate (α &lt; -5%)</th>
              <th className="px-3 py-2 text-right">Big miss (α &gt; +20%)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sector} className="border-t border-terminal-border/50">
                <td className="px-3 py-2">{r.sector}</td>
                <td className="px-3 py-2 text-right font-data text-terminal-muted">
                  {r.count}
                </td>
                <td className={`px-3 py-2 text-right font-data ${alphaColor(r.meanAlpha1y)}`}>
                  {fmtPct(r.meanAlpha1y)}
                </td>
                <td className={`px-3 py-2 text-right font-data ${alphaColor(r.medianAlpha1y)}`}>
                  {fmtPct(r.medianAlpha1y)}
                </td>
                <td className="px-3 py-2 text-right font-data">
                  {fmtPctNoSign(r.hitRate)}
                </td>
                <td className="px-3 py-2 text-right font-data text-terminal-muted">
                  {fmtPctNoSign(r.hitRateBigMiss)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-terminal-border bg-terminal-panel/40 font-semibold">
              <td className="px-3 py-2">Overall</td>
              <td className="px-3 py-2 text-right font-data">
                {backtest.aggregates.overall.count}
              </td>
              <td
                className={`px-3 py-2 text-right font-data ${alphaColor(backtest.aggregates.overall.meanAlpha1y)}`}
              >
                {fmtPct(backtest.aggregates.overall.meanAlpha1y)}
              </td>
              <td
                className={`px-3 py-2 text-right font-data ${alphaColor(backtest.aggregates.overall.medianAlpha1y)}`}
              >
                {fmtPct(backtest.aggregates.overall.medianAlpha1y)}
              </td>
              <td className="px-3 py-2 text-right font-data">
                {fmtPctNoSign(backtest.aggregates.overall.hitRate)}
              </td>
              <td className="px-3 py-2 text-right font-data">
                {fmtPctNoSign(backtest.aggregates.overall.hitRateBigMiss)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function DeBuckets({ backtest }: { backtest: BacktestFile }) {
  const order = ["0–2", "2–5", "5–10", "10+", "neg-eq"];
  const rows = order
    .map((b) => ({ bucket: b, ...(backtest.aggregates.byDeBucket[b] ?? null) }))
    .filter((r) => r.count != null);
  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        D/E bucket hit rates
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        How does the strategy perform across different leverage levels?
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <th className="px-3 py-2 text-left">D/E bucket</th>
              <th className="px-3 py-2 text-right">n</th>
              <th className="px-3 py-2 text-right">Mean α₁y</th>
              <th className="px-3 py-2 text-right">Median α₁y</th>
              <th className="px-3 py-2 text-right">Hit rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bucket} className="border-t border-terminal-border/50">
                <td className="px-3 py-2 font-data">{r.bucket}</td>
                <td className="px-3 py-2 text-right font-data text-terminal-muted">
                  {r.count}
                </td>
                <td
                  className={`px-3 py-2 text-right font-data ${alphaColor(r.meanAlpha1y)}`}
                >
                  {fmtPct(r.meanAlpha1y)}
                </td>
                <td
                  className={`px-3 py-2 text-right font-data ${alphaColor(r.medianAlpha1y)}`}
                >
                  {fmtPct(r.medianAlpha1y)}
                </td>
                <td className="px-3 py-2 text-right font-data">
                  {fmtPctNoSign(r.hitRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function ModelCoefs({ model }: { model: ModelWeights }) {
  const items = model.features
    .slice(0, -1)
    .map((name, i) => ({ name, coef: model.coefs[i] }))
    .sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef));
  const bias = model.coefs[model.coefs.length - 1];

  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        ML model coefficients
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        Logistic regression. Target:{" "}
        <span className="font-data">{model.positiveLabelDef}</span>. Walk-forward
        split: train on events with end-year &lt;{" "}
        <span className="font-data">{model.trainSplitYearLt}</span>, test on
        later events. Train AUC {fmtNum(model.trainAuc, 3)} (n={model.trainSize}),
        test AUC {fmtNum(model.testAuc, 3)} (n={model.testSize}).
      </p>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
              <tr>
                <th className="px-3 py-2 text-left">Feature</th>
                <th className="px-3 py-2 text-right">Coefficient</th>
                <th className="px-3 py-2 text-right">|coef|</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr
                  key={f.name}
                  className="border-t border-terminal-border/50"
                >
                  <td className="px-3 py-2 font-data text-[11px]">{f.name}</td>
                  <td
                    className={`px-3 py-2 text-right font-data ${f.coef >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {f.coef >= 0 ? "+" : ""}
                    {fmtNum(f.coef, 3)}
                  </td>
                  <td className="px-3 py-2 text-right font-data text-terminal-muted">
                    {fmtNum(Math.abs(f.coef), 3)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-terminal-border bg-terminal-panel/40">
                <td className="px-3 py-2 font-data">bias</td>
                <td className="px-3 py-2 text-right font-data text-terminal-muted">
                  {bias >= 0 ? "+" : ""}
                  {fmtNum(bias, 3)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <div className="text-xs text-terminal-muted">
          <h4 className="font-display text-sm text-terminal-fg">
            Reading the coefficients
          </h4>
          <p className="mt-2 leading-relaxed">
            Positive coefficient ⇒ the feature pushes the model&apos;s short-success
            probability <em>up</em> (more like historical winning shorts).
            Negative ⇒ down. Sector dummies are in {"{"}0, 1{"}"} space; numeric
            features are standardized to zero-mean unit-variance using the
            training set.
          </p>
          <p className="mt-3 leading-relaxed">
            Standardization parameters (means / stds, used at inference time):
          </p>
          <table className="mt-2 w-full text-[10px]">
            <thead className="uppercase tracking-wider">
              <tr>
                <th className="text-left">Feature</th>
                <th className="text-right">μ (train)</th>
                <th className="text-right">σ (train)</th>
              </tr>
            </thead>
            <tbody>
              {model.numericMeans.map((mean, i) => (
                <tr key={i}>
                  <td className="font-data">{model.features[i]}</td>
                  <td className="text-right font-data">{fmtNum(mean, 3)}</td>
                  <td className="text-right font-data">
                    {fmtNum(model.numericStds[i], 3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 leading-relaxed">
            Trained {new Date(model.trainedAt).toISOString().slice(0, 10)}.
            Notes: {model.notes}
          </p>
        </div>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function Events({ backtest }: { backtest: BacktestFile }) {
  type Key =
    | "ticker"
    | "sector"
    | "filed"
    | "endYear"
    | "de"
    | "yoy_t"
    | "alpha1y"
    | "alpha6m"
    | "alpha2y"
    | "ret1y";
  const [sortKey, setSortKey] = useState<Key>("alpha1y");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [sectorFilter, setSectorFilter] = useState<string>("all");
  const [winnersOnly, setWinnersOnly] = useState<boolean>(false);

  const sectors = useMemo(() => {
    const set = new Set<string>();
    for (const e of backtest.events) set.add(e.sector);
    return [...set].sort();
  }, [backtest.events]);

  const rows = useMemo(() => {
    let r = [...backtest.events];
    if (sectorFilter !== "all") r = r.filter((e) => e.sector === sectorFilter);
    if (winnersOnly)
      r = r.filter((e) => e.alpha1y != null && e.alpha1y < -0.05);
    r.sort((a, b) => {
      const av = (a as any)[sortKey] ?? -Infinity;
      const bv = (b as any)[sortKey] ?? -Infinity;
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return r;
  }, [backtest.events, sortKey, sortDir, sectorFilter, winnersOnly]);

  function toggle(k: Key) {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir(k === "ticker" || k === "sector" || k === "filed" ? "asc" : "desc");
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <h2 className="font-display text-xl text-terminal-fg">
          All historical screen triggers ({backtest.events.length} events)
        </h2>
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-terminal-muted">
          <span>sector</span>
          <select
            value={sectorFilter}
            onChange={(e) => setSectorFilter(e.target.value)}
            className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 font-data text-xs text-terminal-fg focus:border-amber-accent focus:outline-none"
          >
            <option value="all">all</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs uppercase tracking-wider text-terminal-muted">
          <input
            type="checkbox"
            checked={winnersOnly}
            onChange={(e) => setWinnersOnly(e.target.checked)}
            className="accent-amber-accent"
          />
          winners only (α₁y &lt; -5%)
        </label>
        <div className="ml-auto text-xs text-terminal-muted">
          showing <span className="font-data">{rows.length}</span> of{" "}
          {backtest.events.length}
        </div>
      </div>
      <div className="mt-3 overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <Th onClick={() => toggle("ticker")} active={sortKey === "ticker"} dir={sortDir}>
                Ticker
              </Th>
              <Th onClick={() => toggle("sector")} active={sortKey === "sector"} dir={sortDir}>
                Sector
              </Th>
              <Th onClick={() => toggle("filed")} active={sortKey === "filed"} dir={sortDir}>
                Filed
              </Th>
              <Th right onClick={() => toggle("endYear")} active={sortKey === "endYear"} dir={sortDir}>
                FY
              </Th>
              <Th right onClick={() => toggle("de")} active={sortKey === "de"} dir={sortDir}>
                D/E
              </Th>
              <Th right onClick={() => toggle("yoy_t")} active={sortKey === "yoy_t"} dir={sortDir}>
                Rev YoY
              </Th>
              <Th right onClick={() => toggle("ret1y")} active={sortKey === "ret1y"} dir={sortDir}>
                Stock 1y
              </Th>
              <Th right onClick={() => toggle("alpha6m")} active={sortKey === "alpha6m"} dir={sortDir}>
                α₆m
              </Th>
              <Th right onClick={() => toggle("alpha1y")} active={sortKey === "alpha1y"} dir={sortDir}>
                α₁y
              </Th>
              <Th right onClick={() => toggle("alpha2y")} active={sortKey === "alpha2y"} dir={sortDir}>
                α₂y
              </Th>
              <Th>Flags</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr
                key={`${e.ticker}-${e.endYear}-${i}`}
                className="border-t border-terminal-border/50"
              >
                <td className="px-3 py-1.5 font-data font-semibold">
                  <a
                    href={`https://finance.yahoo.com/quote/${encodeURIComponent(e.ticker)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-amber-accent hover:underline"
                  >
                    {e.ticker}
                  </a>
                </td>
                <td className="px-3 py-1.5 text-terminal-muted">{e.sector}</td>
                <td className="px-3 py-1.5 font-data text-[10px] text-terminal-muted">
                  {e.filed}
                </td>
                <td className="px-3 py-1.5 text-right font-data text-terminal-muted">
                  {e.endYear}
                </td>
                <td className="px-3 py-1.5 text-right font-data">
                  {e.negEquity ? (
                    <span className="text-red-400">neg</span>
                  ) : (
                    fmtNum(e.de)
                  )}
                </td>
                <td className="px-3 py-1.5 text-right font-data text-red-400">
                  {fmtPct(e.yoy_t)}
                </td>
                <td className="px-3 py-1.5 text-right font-data text-terminal-muted">
                  {fmtPct(e.ret1y)}
                </td>
                <td className={`px-3 py-1.5 text-right font-data ${alphaColor(e.alpha6m)}`}>
                  {fmtPct(e.alpha6m)}
                </td>
                <td className={`px-3 py-1.5 text-right font-data ${alphaColor(e.alpha1y)}`}>
                  {fmtPct(e.alpha1y)}
                </td>
                <td className={`px-3 py-1.5 text-right font-data ${alphaColor(e.alpha2y)}`}>
                  {fmtPct(e.alpha2y)}
                </td>
                <td className="px-3 py-1.5 text-[10px] text-terminal-muted">
                  {e.ocfDecline2y && (
                    <span className="mr-1 rounded border border-amber-accent/60 px-1 py-0.5 text-amber-accent">
                      ocf↓2y
                    </span>
                  )}
                  {e.negEquity && (
                    <span className="mr-1 rounded border border-red-700 px-1 py-0.5 text-red-400">
                      neg eq
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <section className="border-t border-terminal-border pt-8 text-xs text-terminal-muted">
      <h3 className="font-display text-base text-terminal-fg">
        Methodology + caveats
      </h3>
      <ul className="mt-2 space-y-1">
        <li>
          <span className="font-data text-amber-accent">Trigger date</span> is
          the earliest 10-K filing for the fiscal year (not the most recent
          restatement — restatement dates introduce look-ahead bias).
        </li>
        <li>
          <span className="font-data text-amber-accent">Forward returns</span>{" "}
          are computed from Yahoo monthly adjusted closes (split + dividend
          adjusted), measured from the next bar at-or-after the filing date.
        </li>
        <li>
          <span className="font-data text-amber-accent">Alpha</span> = ticker
          return − SPY return over the same window. Captures relative
          underperformance, immune to market-direction trends.
        </li>
        <li>
          <span className="font-data text-amber-accent">Survivorship bias</span>:
          the universe is current SP500 — companies that went bankrupt aren&apos;t
          in the dataset. This biases hit rates downward (the best historical
          shorts are missing).
        </li>
        <li>
          <span className="font-data text-amber-accent">Strategy selection</span>{" "}
          was done with hindsight on the same dataset that&apos;s reported here.
          Walk-forward retesting (train on events through year T, test on T+1
          onward, repeat) is on the roadmap.
        </li>
        <li>
          <span className="font-data text-amber-accent">Sample size</span>: the
          best portfolio strategies have 9–14 trades over 15 years. Confidence
          intervals on annualized return are wide.
        </li>
      </ul>
      <p className="mt-4">
        Research note. Not investment advice. Trade at your own risk.
      </p>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function Th({
  children,
  onClick,
  active,
  dir,
  right,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  dir?: "asc" | "desc";
  right?: boolean;
}) {
  const arrow = active ? (dir === "asc" ? " ↑" : " ↓") : "";
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 ${right ? "text-right" : "text-left"} ${
        onClick ? "cursor-pointer hover:text-terminal-fg" : ""
      } ${active ? "text-amber-accent" : ""}`}
    >
      {children}
      {arrow}
    </th>
  );
}
