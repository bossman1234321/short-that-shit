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
  peakGrossDeployment?: number;
  unleveraged?: boolean;
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
  interimMaxDrawdown?: number | null;
  worstMonthlyMtmReturn?: number | null;
  postTaxAnnReturn22pct?: number | null;
  postTaxAnnReturn32pct?: number | null;
  postTaxAnnReturn37pct?: number | null;
};

type HeadlineSummary = {
  name: string;
  description: string;
  finalEquity: number;
  annualizedReturn: number | null;
  metrics: StrategyMetrics;
  positions: Array<{
    ticker: string;
    sector: string;
    entryDate: string;
    exitDate: string;
    daysHeld: number;
    size: number;
    ret: number;
    pnl: number;
    exitReason: string;
    mlScore: number | null;
    trailing6m: number | null;
  }>;
};

type AblationRow = {
  name: string;
  description: string;
  finalEquity: number;
  annualizedReturn: number | null;
  nTaken: number;
  delta: number;
};

type SensitivityRow = {
  annualBorrow: number;
  finalEquity: number;
  annualizedReturn: number | null;
  deltaPp: number;
};

type TxnSensitivityRow = {
  bpsRoundTrip: number;
  finalEquity: number;
  annualizedReturn: number | null;
  deltaPp: number;
};

type BenchmarkRow = {
  name: string;
  description: string;
  finalEquity: number;
  annualizedReturn: number;
};

type PortfolioFile = {
  generatedAt: string;
  startingBalance: number;
  annualBorrowCost: number;
  annualizedBar?: number;
  riskFreeRate?: number;
  results: PortfolioStrategyRow[];
  bySector?: SectorPortfolioRow[];
  headline?: HeadlineSummary;
  ablations?: AblationRow[];
  sensitivities?: SensitivityRow[];
  txnSensitivities?: TxnSensitivityRow[];
  benchmarks?: BenchmarkRow[];
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
        {portfolio?.headline && (
          <HeadlineEvaluation portfolio={portfolio} />
        )}
        {portfolio?.headline && <RealWorldRisks portfolio={portfolio} />}
        {portfolio?.benchmarks && portfolio.benchmarks.length > 0 && (
          <Benchmarks portfolio={portfolio} />
        )}
        {portfolio?.ablations && portfolio.ablations.length > 0 && (
          <Ablations portfolio={portfolio} />
        )}
        {portfolio?.sensitivities && portfolio.sensitivities.length > 0 && (
          <SensitivityTable portfolio={portfolio} />
        )}
        {portfolio?.headline && (
          <PerTradeDetail portfolio={portfolio} />
        )}
        <CaveatsAndOperational />
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
function HeadlineEvaluation({ portfolio }: { portfolio: PortfolioFile }) {
  const h = portfolio.headline!;
  const m = h.metrics;
  const startBal = portfolio.startingBalance;
  const fmtRatio = (n: number | null) => (n == null ? "—" : n.toFixed(2));
  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Headline strategy: full evaluation
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        <span className="font-data text-amber-accent">{h.name}</span> — {h.description}
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="rounded border border-terminal-border bg-terminal-panel/30 p-3">
          <div className="text-[10px] uppercase tracking-wider text-terminal-muted">
            Headline P&amp;L
          </div>
          <div className="mt-1 font-data text-2xl text-amber-accent">
            {fmtUSD(h.finalEquity)}
          </div>
          <div className="text-[11px] text-terminal-muted">
            from {fmtUSD(startBal)} starting · ann{" "}
            {fmtPct(h.annualizedReturn)}
          </div>
          {m.bootstrapCI95Lo != null && m.bootstrapCI95Hi != null && (
            <div className="mt-2 text-[11px] text-terminal-muted">
              <span className="font-data text-amber-accent">95% CI</span>{" "}
              (bootstrap, n={h.positions.length}):{" "}
              <span className="font-data">
                {fmtPct(m.bootstrapCI95Lo)} → {fmtPct(m.bootstrapCI95Hi)}
              </span>
              <div className="mt-1 text-[10px] leading-relaxed">
                Wide CIs reflect the small sample. The point estimate
                ({fmtPct(h.annualizedReturn)}) is fragile if your real-world
                runs draw from the lower end of the distribution.
              </div>
            </div>
          )}
        </div>
        <div className="rounded border border-terminal-border bg-terminal-panel/30 p-3">
          <div className="text-[10px] uppercase tracking-wider text-terminal-muted">
            Risk-adjusted return ratios
          </div>
          <table className="mt-1 w-full text-xs">
            <tbody>
              <tr>
                <td className="py-0.5">Sharpe</td>
                <td className="py-0.5 text-right font-data">
                  {fmtRatio(m.sharpeRatio)}
                </td>
                <td className="py-0.5 pl-2 text-[10px] text-terminal-muted">
                  excess / vol
                </td>
              </tr>
              <tr>
                <td className="py-0.5">Sortino</td>
                <td className="py-0.5 text-right font-data">
                  {fmtRatio(m.sortinoRatio)}
                </td>
                <td className="py-0.5 pl-2 text-[10px] text-terminal-muted">
                  excess / downside vol
                </td>
              </tr>
              <tr>
                <td className="py-0.5">Calmar</td>
                <td className="py-0.5 text-right font-data">
                  {fmtRatio(m.calmarRatio)}
                </td>
                <td className="py-0.5 pl-2 text-[10px] text-terminal-muted">
                  ann ret / |max DD|
                </td>
              </tr>
              <tr>
                <td className="py-0.5">Info ratio</td>
                <td className="py-0.5 text-right font-data">
                  {fmtRatio(m.informationRatio)}
                </td>
                <td className="py-0.5 pl-2 text-[10px] text-terminal-muted">
                  vs SPY
                </td>
              </tr>
            </tbody>
          </table>
          <div className="mt-2 text-[10px] leading-relaxed text-terminal-muted">
            Sharpe ≥ 1 is publishable; ≥ 2 is exceptional. Rates use 4%
            annual T-bill as risk-free baseline.
          </div>
        </div>
        <div className="rounded border border-terminal-border bg-terminal-panel/30 p-3">
          <div className="text-[10px] uppercase tracking-wider text-terminal-muted">
            P&amp;L distribution + streaks
          </div>
          <table className="mt-1 w-full text-xs">
            <tbody>
              <tr>
                <td className="py-0.5">Mean P&amp;L / pos</td>
                <td className="py-0.5 text-right font-data">{fmtUSD(m.pnlMean)}</td>
              </tr>
              <tr>
                <td className="py-0.5">Std dev</td>
                <td className="py-0.5 text-right font-data">{fmtUSD(m.pnlStd)}</td>
              </tr>
              <tr>
                <td className="py-0.5">Skewness</td>
                <td className="py-0.5 text-right font-data">{fmtNum(m.pnlSkew)}</td>
              </tr>
              <tr>
                <td className="py-0.5">Longest win streak</td>
                <td className="py-0.5 text-right font-data">{m.longestWinStreak}</td>
              </tr>
              <tr>
                <td className="py-0.5">Longest loss streak</td>
                <td className="py-0.5 text-right font-data">{m.longestLossStreak}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      {Object.keys(m.yearlyPnL).length > 0 && (
        <div className="mt-4 rounded border border-terminal-border bg-terminal-panel/30 p-3">
          <div className="text-[10px] uppercase tracking-wider text-terminal-muted">
            Year-by-year P&amp;L
          </div>
          <table className="mt-2 w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
              <tr>
                <th className="text-left">Year</th>
                <th className="text-right">P&amp;L</th>
                <th className="px-3 text-left">Bar (relative)</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(m.yearlyPnL)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([y, pnl]) => {
                  const maxAbs = Math.max(
                    ...Object.values(m.yearlyPnL).map((v) => Math.abs(v)),
                    1
                  );
                  const widthPct = (Math.abs(pnl) / maxAbs) * 100;
                  return (
                    <tr key={y}>
                      <td className="py-0.5 font-data">{y}</td>
                      <td
                        className={`py-0.5 text-right font-data ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}
                      >
                        {fmtUSD(pnl)}
                      </td>
                      <td className="px-3 py-0.5">
                        <div className="relative h-2 w-full">
                          <div
                            className={`absolute top-0 h-2 ${pnl >= 0 ? "left-1/2 bg-emerald-700" : "right-1/2 bg-red-700"}`}
                            style={{ width: `${widthPct / 2}%` }}
                          />
                          <div className="absolute left-1/2 top-0 h-2 w-px bg-terminal-border" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          {m.bestYear && m.worstYear && (
            <div className="mt-2 text-[10px] text-terminal-muted">
              best: <span className="font-data">{m.bestYear.year}</span> ({fmtUSD(m.bestYear.pnl)})
              {" · "}worst: <span className="font-data">{m.worstYear.year}</span> ({fmtUSD(m.worstYear.pnl)})
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function RealWorldRisks({ portfolio }: { portfolio: PortfolioFile }) {
  const m = portfolio.headline!.metrics;
  const headlineAnn = portfolio.headline?.annualizedReturn ?? 0;
  const interim = m.interimMaxDrawdown;
  const worstMonth = m.worstMonthlyMtmReturn;
  const txn = portfolio.txnSensitivities ?? [];
  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Real-world risk &amp; cost adjustments
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        Caveats that the basic backtest hides: interim mark-to-market
        drawdowns (margin-call risk), tax treatment, transaction costs,
        position-level execution costs.
      </p>

      {/* Interim DD + Worst month */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded border border-red-700/40 bg-red-950/20 p-3">
          <div className="text-[10px] uppercase tracking-wider text-red-400">
            Interim mark-to-market drawdown
          </div>
          <div className="mt-1 font-data text-2xl text-red-400">
            {interim != null ? fmtPct(interim) : "—"}
          </div>
          <div className="text-[11px] text-terminal-muted">
            worst monthly MTM:{" "}
            <span className="font-data">
              {worstMonth != null ? fmtPct(worstMonth) : "—"}
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed">
            The headline strategy looks smooth at exit dates, but during open
            positions the equity can swing meaningfully. With 2x portfolio
            leverage, a{" "}
            <span className="font-data text-red-400">
              {interim != null ? fmtPct(Math.abs(interim)) : "—"}
            </span>{" "}
            drawdown comes close to (or breaches) typical margin-maintenance
            thresholds (~30% on most retail platforms), which would force a
            real-world unwind even though the backtest assumed hold-to-term.
          </p>
        </div>

        <div className="rounded border border-orange-700/40 bg-orange-950/20 p-3">
          <div className="text-[10px] uppercase tracking-wider text-orange-400">
            Post-tax annualized return
          </div>
          <table className="mt-1 w-full text-xs">
            <tbody>
              <tr>
                <td className="py-0.5">Pre-tax</td>
                <td className="py-0.5 text-right font-data text-amber-accent">
                  {fmtPct(headlineAnn)}
                </td>
              </tr>
              <tr>
                <td className="py-0.5">22% bracket</td>
                <td className="py-0.5 text-right font-data">
                  {fmtPct(m.postTaxAnnReturn22pct)}
                </td>
              </tr>
              <tr>
                <td className="py-0.5">32% bracket</td>
                <td className="py-0.5 text-right font-data">
                  {fmtPct(m.postTaxAnnReturn32pct)}
                </td>
              </tr>
              <tr>
                <td className="py-0.5">37% bracket</td>
                <td className="py-0.5 text-right font-data text-red-400">
                  {fmtPct(m.postTaxAnnReturn37pct)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-[11px] leading-relaxed text-terminal-muted">
            Short-sale gains are <em>always</em> taxed as short-term capital
            gains (IRS §1233 / §1234B), regardless of holding period. So
            both legs of a 12-month pair trade pay ordinary-income rates
            on gains. At top federal bracket the 8.7% pre-tax shrinks to{" "}
            <span className="font-data text-red-400">
              {fmtPct(m.postTaxAnnReturn37pct)}
            </span>{" "}
            — below the 8% deployment bar.
          </p>
        </div>
      </div>

      {/* Transaction cost sensitivity */}
      {txn.length > 0 && (
        <div className="mt-4 rounded border border-terminal-border bg-terminal-panel/30 p-3">
          <div className="text-[10px] uppercase tracking-wider text-terminal-muted">
            Transaction-cost sensitivity (round-trip basis points on gross)
          </div>
          <table className="mt-2 w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
              <tr>
                <th className="text-left">Round-trip cost</th>
                <th className="text-right">Final $</th>
                <th className="text-right">Annualized</th>
                <th className="text-right">Δ vs 0bps</th>
                <th className="text-left pl-3">Realistic for…</th>
              </tr>
            </thead>
            <tbody>
              {txn.map((t) => {
                const realistic =
                  t.bpsRoundTrip === 0
                    ? "frictionless ideal"
                    : t.bpsRoundTrip <= 10
                      ? "limit orders, large-cap, deep liquidity"
                      : t.bpsRoundTrip <= 25
                        ? "market orders, large-cap"
                        : t.bpsRoundTrip <= 50
                          ? "market orders, mid-cap or wider spreads"
                          : "illiquid / pre-bankruptcy / acquisition pending";
                return (
                  <tr key={t.bpsRoundTrip} className="border-t border-terminal-border/50">
                    <td className="py-0.5 font-data">{t.bpsRoundTrip} bps</td>
                    <td className="py-0.5 text-right font-data">
                      {fmtUSD(t.finalEquity)}
                    </td>
                    <td className="py-0.5 text-right font-data">
                      {fmtPct(t.annualizedReturn)}
                    </td>
                    <td
                      className={`py-0.5 text-right font-data ${t.deltaPp < 0 ? "text-red-400" : "text-terminal-muted"}`}
                    >
                      {t.deltaPp >= 0 ? "+" : ""}
                      {(t.deltaPp * 100).toFixed(1)}pp
                    </td>
                    <td className="py-0.5 pl-3 text-[11px] text-terminal-muted">
                      {realistic}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 rounded border border-amber-accent/40 bg-amber-accent/5 p-3">
        <div className="text-[10px] uppercase tracking-wider text-amber-accent">
          Stacked-realism scenario
        </div>
        <p className="mt-1 text-xs leading-relaxed">
          When all real-world frictions are stacked — 5% borrow (realistic
          for some periods), 25bps txn cost (market orders, large-cap), 32%
          marginal tax bracket — the headline strategy&apos;s effective
          annualized drops materially below its{" "}
          <span className="font-data text-amber-accent">
            {fmtPct(headlineAnn)}
          </span>{" "}
          backtest figure. Combined with the{" "}
          <span className="font-data text-red-400">
            {interim != null ? fmtPct(interim) : "—"}
          </span>{" "}
          interim drawdown, the practical edge is narrower than the headline
          suggests.
        </p>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function Benchmarks({ portfolio }: { portfolio: PortfolioFile }) {
  const benches = portfolio.benchmarks!;
  const headlineAnn = portfolio.headline?.annualizedReturn ?? 0;
  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Counterfactual benchmarks (same window)
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        What would $10K have done in passive alternatives over the same start
        and end dates as the headline strategy?
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <th className="px-3 py-2 text-left">Strategy</th>
              <th className="px-3 py-2 text-right">Final $</th>
              <th className="px-3 py-2 text-right">Annualized</th>
              <th className="px-3 py-2 text-right">Δ vs strategy</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-terminal-border bg-amber-accent/10">
              <td className="px-3 py-2">
                <div className="font-data text-amber-accent">
                  {portfolio.headline?.name}
                </div>
                <div className="text-[10px] text-terminal-muted">our strategy</div>
              </td>
              <td className="px-3 py-2 text-right font-data text-amber-accent">
                {fmtUSD(portfolio.headline?.finalEquity ?? 0)}
              </td>
              <td className="px-3 py-2 text-right font-data text-amber-accent">
                {fmtPct(headlineAnn)}
              </td>
              <td className="px-3 py-2 text-right font-data text-terminal-muted">—</td>
            </tr>
            {benches.map((b) => {
              const delta = headlineAnn - b.annualizedReturn;
              return (
                <tr key={b.name} className="border-t border-terminal-border/50">
                  <td className="px-3 py-2">
                    <div className="font-data">{b.name}</div>
                    <div className="text-[10px] text-terminal-muted">
                      {b.description}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-data">
                    {fmtUSD(b.finalEquity)}
                  </td>
                  <td className="px-3 py-2 text-right font-data">
                    {fmtPct(b.annualizedReturn)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-data ${delta >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {delta >= 0 ? "+" : ""}
                    {(delta * 100).toFixed(1)}pp
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-terminal-muted">
        <span className="text-amber-accent">Honest read:</span> the strategy
        underperforms passive SPY buy-and-hold over this window in absolute
        return — but with materially less volatility (max DD ~0% vs SPY&apos;s
        peak-to-trough drawdowns of 25-34% in 2020 and 2022). Whether this
        trade-off is worth it depends on whether you weight risk-adjusted or
        absolute return more.
      </p>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function Ablations({ portfolio }: { portfolio: PortfolioFile }) {
  const ablations = portfolio.ablations!;
  const headlineAnn = portfolio.headline?.annualizedReturn ?? 0;
  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Ablation: which rules carry the alpha?
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        Disable one filter at a time, re-simulate, measure annualized return
        delta vs. the headline. Bigger negative Δ ⇒ the rule is load-bearing;
        Δ near zero ⇒ the rule contributes nothing.
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <th className="px-3 py-2 text-left">Variant</th>
              <th className="px-3 py-2 text-right">Final $</th>
              <th className="px-3 py-2 text-right">Annualized</th>
              <th className="px-3 py-2 text-right">Δ ann vs headline</th>
              <th className="px-3 py-2 text-right">n trades</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-terminal-border bg-amber-accent/10">
              <td className="px-3 py-2">
                <div className="font-data text-amber-accent">
                  Headline (all rules on)
                </div>
              </td>
              <td className="px-3 py-2 text-right font-data text-amber-accent">
                {fmtUSD(portfolio.headline?.finalEquity ?? 0)}
              </td>
              <td className="px-3 py-2 text-right font-data text-amber-accent">
                {fmtPct(headlineAnn)}
              </td>
              <td className="px-3 py-2 text-right font-data text-terminal-muted">
                —
              </td>
              <td className="px-3 py-2 text-right font-data text-terminal-muted">
                {portfolio.headline?.positions.length ?? "—"}
              </td>
            </tr>
            {ablations
              .slice()
              .sort((a, b) => a.delta - b.delta)
              .map((a) => (
                <tr key={a.name} className="border-t border-terminal-border/50">
                  <td className="px-3 py-2">
                    <div className="font-data">{a.name}</div>
                    <div className="text-[10px] text-terminal-muted">
                      {a.description}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-data">
                    {fmtUSD(a.finalEquity)}
                  </td>
                  <td className="px-3 py-2 text-right font-data">
                    {fmtPct(a.annualizedReturn)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-data ${a.delta < -0.005 ? "text-red-400" : a.delta > 0.005 ? "text-emerald-400" : "text-terminal-muted"}`}
                  >
                    {a.delta >= 0 ? "+" : ""}
                    {(a.delta * 100).toFixed(1)}pp
                  </td>
                  <td className="px-3 py-2 text-right font-data text-terminal-muted">
                    {a.nTaken}
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
function SensitivityTable({ portfolio }: { portfolio: PortfolioFile }) {
  const sens = portfolio.sensitivities!;
  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Borrow-cost sensitivity
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        Real short-borrow rates vary by name: liquid large-caps ~0.3-2%,
        hard-to-borrow names can be 5-50%+. The headline assumes 2% flat;
        below shows what happens if the assumption is wrong.
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <th className="px-3 py-2 text-left">Annual borrow</th>
              <th className="px-3 py-2 text-right">Final $</th>
              <th className="px-3 py-2 text-right">Annualized</th>
              <th className="px-3 py-2 text-right">Δ vs 2%</th>
            </tr>
          </thead>
          <tbody>
            {sens.map((s) => (
              <tr
                key={s.annualBorrow}
                className={`border-t border-terminal-border/50 ${s.annualBorrow === portfolio.annualBorrowCost ? "bg-amber-accent/10" : ""}`}
              >
                <td className="px-3 py-2 font-data">
                  {(s.annualBorrow * 100).toFixed(1)}%
                  {s.annualBorrow === portfolio.annualBorrowCost && (
                    <span className="ml-2 text-[10px] text-amber-accent">(baseline)</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-data">
                  {fmtUSD(s.finalEquity)}
                </td>
                <td className="px-3 py-2 text-right font-data">
                  {fmtPct(s.annualizedReturn)}
                </td>
                <td
                  className={`px-3 py-2 text-right font-data ${s.deltaPp < -0.005 ? "text-red-400" : s.deltaPp > 0.005 ? "text-emerald-400" : "text-terminal-muted"}`}
                >
                  {s.deltaPp >= 0 ? "+" : ""}
                  {(s.deltaPp * 100).toFixed(1)}pp
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-terminal-muted">
        <span className="text-amber-accent">Honest read:</span> liquid Util/CS
        large-caps borrow at ~0.5-2%. The strategy clears its annualized bar
        even at 5% borrow. At 10%+ (illiquid / hard-to-borrow names), it
        breaks down. Most names in the matched set are easy-to-borrow, so
        the 2% assumption is reasonable but check actual rates before
        deploying.
      </p>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
function PerTradeDetail({ portfolio }: { portfolio: PortfolioFile }) {
  const positions = portfolio.headline!.positions;
  if (positions.length === 0) return null;
  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Per-trade detail (headline strategy)
      </h2>
      <p className="mt-1 text-xs text-terminal-muted">
        Every position the headline strategy took. Sanity-check execution
        feasibility, look for flukes, see which trades drove returns.
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <th className="px-3 py-2 text-left">Ticker</th>
              <th className="px-3 py-2 text-left">Sector</th>
              <th className="px-3 py-2 text-left">Entry</th>
              <th className="px-3 py-2 text-left">Exit</th>
              <th className="px-3 py-2 text-right">Days</th>
              <th className="px-3 py-2 text-right">Size $</th>
              <th className="px-3 py-2 text-right">Return / α</th>
              <th className="px-3 py-2 text-right">P&amp;L</th>
              <th className="px-3 py-2 text-left">Exit reason</th>
              <th className="px-3 py-2 text-right">ML score</th>
              <th className="px-3 py-2 text-right">Trail-6m</th>
            </tr>
          </thead>
          <tbody>
            {positions
              .slice()
              .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
              .map((p, i) => (
                <tr
                  key={`${p.ticker}-${p.entryDate}-${i}`}
                  className="border-t border-terminal-border/50"
                >
                  <td className="px-3 py-1.5 font-data font-semibold">
                    <a
                      href={`https://finance.yahoo.com/quote/${encodeURIComponent(p.ticker)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-amber-accent hover:underline"
                    >
                      {p.ticker}
                    </a>
                  </td>
                  <td className="px-3 py-1.5 text-terminal-muted">
                    {p.sector}
                  </td>
                  <td className="px-3 py-1.5 font-data text-[10px]">
                    {p.entryDate}
                  </td>
                  <td className="px-3 py-1.5 font-data text-[10px]">
                    {p.exitDate}
                  </td>
                  <td className="px-3 py-1.5 text-right font-data text-terminal-muted">
                    {p.daysHeld}
                  </td>
                  <td className="px-3 py-1.5 text-right font-data">
                    {fmtUSD(p.size)}
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right font-data ${p.ret < 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {fmtPct(p.ret)}
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right font-data ${p.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {fmtUSD(p.pnl)}
                  </td>
                  <td className="px-3 py-1.5 font-data text-[10px] text-terminal-muted">
                    {p.exitReason}
                  </td>
                  <td className="px-3 py-1.5 text-right font-data text-terminal-muted">
                    {p.mlScore != null ? p.mlScore.toFixed(2) : "—"}
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right font-data ${(p.trailing6m ?? 0) < 0 ? "text-emerald-400" : "text-terminal-muted"}`}
                  >
                    {p.trailing6m != null ? fmtPct(p.trailing6m) : "—"}
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
function CaveatsAndOperational() {
  return (
    <section>
      <h2 className="font-display text-xl text-terminal-fg">
        Capacity, paper-trade tracking, remaining unmodeled risks
      </h2>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="rounded border border-terminal-border bg-terminal-panel/30 p-3">
          <h3 className="font-display text-sm text-terminal-fg">
            Crowdedness &amp; capacity
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-terminal-muted">
            We don&apos;t model short interest per name — that would require
            FINRA biweekly short-interest data joined to each historical
            event. Heuristic guidance instead:
          </p>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-terminal-muted">
            <li>
              <span className="font-data text-amber-accent">Retail</span>{" "}
              ($10K–$1M): non-issue. The matched names have $5B–$500B
              market caps; you can&apos;t move them.
            </li>
            <li>
              <span className="font-data text-amber-accent">Mid AUM</span>{" "}
              ($1M–$100M): mostly fine but watch borrow rates on smaller
              names. SHLD pre-BK borrowed at 50%+ — the 2% assumption fails.
            </li>
            <li>
              <span className="font-data text-amber-accent">High AUM</span>{" "}
              ($100M+): capacity-constrained. Short positions of $5–50M can
              represent 1–3% of float on smaller SP500 names; expect
              borrow-cost spikes and adverse execution.
            </li>
            <li>
              <span className="font-data text-amber-accent">Crowding</span>:
              if too many traders deploy this same screen at once, short
              interest spikes and squeeze risk rises. Mitigation: monitor
              SI as % of float; if &gt; 20%, skip.
            </li>
          </ul>
        </div>

        <div className="rounded border border-terminal-border bg-terminal-panel/30 p-3">
          <h3 className="font-display text-sm text-terminal-fg">
            Forward paper-trade tracking
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-terminal-muted">
            A backtest selected with hindsight on the same dataset that
            evaluates it isn&apos;t a real out-of-sample test. The credible
            forward signal is{" "}
            <em>does the strategy actually work in real time</em>. We&apos;ve
            scaffolded a paper-trade tracker at{" "}
            <a
              href="/data/paper-trades.json"
              className="font-data text-amber-accent hover:underline"
            >
              /data/paper-trades.json
            </a>
            ; once a matched trade is opened (by you or the monthly
            routine), it&apos;s logged, marked-to-market over time, and
            compared against the backtest expectation.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-terminal-muted">
            <span className="font-data text-amber-accent">Tracking since:</span>{" "}
            2026-05-03 (no live trades yet). After ~12 months of forward
            data we&apos;ll have a real out-of-sample anchor.
          </p>
        </div>

        <div className="rounded border border-terminal-border bg-terminal-panel/30 p-3 md:col-span-2">
          <h3 className="font-display text-sm text-terminal-fg">
            Remaining unmodeled risks
          </h3>
          <ul className="mt-2 grid gap-1 text-xs leading-relaxed text-terminal-muted md:grid-cols-2">
            <li>
              <span className="font-data text-amber-accent">Hard-to-borrow events</span>:
              if a stock becomes hard-to-borrow mid-trade, broker may force
              a buy-in (close your short at the worst possible time). Not
              captured by flat 2% borrow assumption.
            </li>
            <li>
              <span className="font-data text-amber-accent">Stock recall risk</span>:
              brokers can pull shares loaned to you, forcing a buy-in.
              More common in high-conviction shorts.
            </li>
            <li>
              <span className="font-data text-amber-accent">Reg SHO threshold</span>:
              listing on the SHO list (high fail-to-deliver) often triggers
              a forced unwind. Not modeled.
            </li>
            <li>
              <span className="font-data text-amber-accent">Dividend payments</span>:
              the short pays the long&apos;s dividend. Built into the 2%
              borrow as a rough proxy but actual varies by name and year.
            </li>
            <li>
              <span className="font-data text-amber-accent">Wash sale rules</span>:
              IRS §1091 — can&apos;t deduct loss if you re-establish a
              substantially identical position within 30 days. Affects tax
              treatment when re-shorting same name.
            </li>
            <li>
              <span className="font-data text-amber-accent">Constructive sale</span>:
              IRS §1259 — short-against-the-box rules. Niche but real.
            </li>
            <li>
              <span className="font-data text-amber-accent">Black-swan tail</span>:
              the 95% bootstrap CI assumes the past distribution captures
              the future. Tail events (Volkswagen squeeze, GameStop, AMC)
              live outside this distribution.
            </li>
            <li>
              <span className="font-data text-amber-accent">Regime persistence</span>:
              the alpha came from sectors with secular declines (Util/CS).
              If those sectors stop declining (e.g. utility renaissance from
              data-center demand), the strategy alpha disappears.
            </li>
          </ul>
        </div>
      </div>
    </section>
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
    | "positionSize"
    | "peakGrossDeployment";
  const [sortKey, setSortKey] = useState<Key>("finalEquity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [unleveragedOnly, setUnleveragedOnly] = useState<boolean>(false);
  const sorted = useMemo(() => {
    let rows = [...portfolio.results];
    if (unleveragedOnly) rows = rows.filter((r) => r.unleveraged === true);
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
  }, [portfolio.results, sortKey, sortDir, unleveragedOnly]);

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
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-terminal-muted">
        <span>
          {portfolio.results.length} variants evaluated. Borrow cost{" "}
          {fmtPctNoSign(portfolio.annualBorrowCost)} annualized. Pair-trade
          strategies split position 50/50 between short ticker and long SPY.
          Rows sortable.
        </span>
        <label className="flex items-center gap-2 text-xs uppercase tracking-wider text-terminal-muted">
          <input
            type="checkbox"
            checked={unleveragedOnly}
            onChange={(e) => setUnleveragedOnly(e.target.checked)}
            className="accent-amber-accent"
          />
          unleveraged only (peak deployment ≤ 100%)
        </label>
      </div>
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
              <Th right onClick={() => toggle("peakGrossDeployment")} active={sortKey === "peakGrossDeployment"} dir={sortDir}>
                Peak %
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
                  <td
                    className={`px-3 py-2 text-right font-data ${r.unleveraged ? "text-terminal-muted" : "text-sky-400"}`}
                    title={r.unleveraged ? "Unleveraged (≤100%)" : "Uses portfolio leverage"}
                  >
                    {r.peakGrossDeployment != null
                      ? `${(r.peakGrossDeployment * 100).toFixed(0)}%`
                      : "—"}
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
