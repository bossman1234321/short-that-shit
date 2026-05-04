"use client";

import { useEffect, useMemo, useState } from "react";
import type { ScreenFlag, ScreenResult, ScreenRow } from "@/lib/types";

type SortKey =
  | "ticker"
  | "entityName"
  | "sector"
  | "mlShortScore"
  | "debtToEquity"
  | "rev_t"
  | "rev_t1"
  | "rev_t2"
  | "yoy_t"
  | "yoy_t1"
  | "revTtm"
  | "revTtmYoy"
  | "ocf_t"
  | "yoy_ocf_t";

type ThresholdMode = "avg" | "custom";
type ConvictionMode = "all" | "highOnly";

function fmtUSD(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(digits)}K`;
  return n.toFixed(0);
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = n * 100;
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function shortDate(s: string | null | undefined): string {
  if (!s) return "—";
  return s.slice(0, 7);
}

function getCmp(row: ScreenRow, key: SortKey): number | string {
  switch (key) {
    case "ticker":
      return row.ticker;
    case "entityName":
      return row.entityName;
    case "sector":
      return row.sector ?? "";
    case "mlShortScore":
      return row.mlShortScore ?? -Infinity;
    case "debtToEquity":
      return row.debtToEquity ?? -Infinity;
    case "rev_t":
      return row.rev_t ?? -Infinity;
    case "rev_t1":
      return row.rev_t1 ?? -Infinity;
    case "rev_t2":
      return row.rev_t2 ?? -Infinity;
    case "yoy_t":
      return row.yoy_t ?? -Infinity;
    case "yoy_t1":
      return row.yoy_t1 ?? -Infinity;
    case "revTtm":
      return row.revTtm ?? -Infinity;
    case "revTtmYoy":
      return row.revTtmYoy ?? -Infinity;
    case "ocf_t":
      return row.ocf_t ?? -Infinity;
    case "yoy_ocf_t":
      return row.yoy_ocf_t ?? -Infinity;
  }
}

// Recomputes match flags against new threshold / decline-duration settings.
// All inputs needed are present on the row, so this avoids an API roundtrip
// when the user retunes the levers. (Sector exclusion was removed after the
// backtest study showed Utilities and REITs to be valid setups.)
function applyLevers(
  rows: ScreenRow[],
  threshold: number,
  declineYears: 1 | 2 | 3
): ScreenRow[] {
  return rows.map((r) => {
    const revsNewestFirst: Array<number | null> = [
      r.rev_t,
      r.rev_t1,
      r.rev_t2,
      r.rev_t3,
    ];
    let declineMatched = revsNewestFirst.length >= declineYears + 1;
    for (let i = 0; declineMatched && i < declineYears; i++) {
      const newer = revsNewestFirst[i];
      const older = revsNewestFirst[i + 1];
      if (newer == null || older == null || !(newer < older)) {
        declineMatched = false;
      }
    }

    const negEqCountsAsLeverage =
      r.flags.includes("negative_equity") &&
      r.negEquityType !== "buyback_driven";
    const leverageMatched =
      negEqCountsAsLeverage ||
      (r.debtToEquity != null && r.debtToEquity > threshold);
    const matched = declineMatched && leverageMatched;

    // TTM flags are conditional on declineMatched, so recompute them here
    // when the duration lever changes the matched set.
    const ttmRecovering =
      declineMatched && r.revTtmYoy != null && r.revTtmYoy >= -0.01;
    const ttmAccelerating =
      declineMatched &&
      r.revTtmYoy != null &&
      r.yoy_t != null &&
      r.revTtmYoy < r.yoy_t - 0.03;

    const flags: ScreenFlag[] = r.flags.filter(
      (f): f is ScreenFlag =>
        f !== "ttm_recovering" && f !== "ttm_accelerating"
    );
    if (ttmRecovering) flags.push("ttm_recovering");
    if (ttmAccelerating) flags.push("ttm_accelerating");

    return {
      ...r,
      declineMatched,
      leverageMatched,
      ttmRecovering,
      ttmAccelerating,
      matched,
      highConvictionMatched: matched && r.ocfDeclineMatched,
      flags,
    };
  });
}

// Universe-average D/E computed client-side over the eligible subset, so the
// threshold tracks the sector toggle without a server roundtrip. Mirrors
// lib/screen.ts:universeAverageDE.
function computeAverageDE(rows: ScreenRow[]): number {
  const valid = rows
    .map((r) => r.debtToEquity)
    .filter((d): d is number => d != null && Number.isFinite(d) && d > 0);
  if (valid.length === 0) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

export function ScreenView({ initial }: { initial: ScreenResult }) {
  const [showAll, setShowAll] = useState(false);
  const [convictionMode, setConvictionMode] = useState<ConvictionMode>("all");
  const [sortKey, setSortKey] = useState<SortKey>("debtToEquity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [thresholdMode, setThresholdMode] = useState<ThresholdMode>("avg");
  const [customThresholdInput, setCustomThresholdInput] = useState<string>(
    initial.threshold.value.toFixed(2)
  );
  const [activeThreshold, setActiveThreshold] = useState<number>(
    initial.threshold.value
  );
  const [sectorFilter, setSectorFilter] = useState<string>("all");
  const [ttmConfirmedOnly, setTtmConfirmedOnly] = useState<boolean>(false);
  const [declineYears, setDeclineYears] = useState<1 | 2 | 3>(
    initial.declineYears ?? 2
  );

  const sectors = useMemo(() => {
    const set = new Set<string>();
    for (const r of initial.rows) if (r.sector) set.add(r.sector);
    return [...set].sort();
  }, [initial.rows]);

  // Average D/E across all rows. Earlier we filtered out "ineligible"
  // sectors here, but the empirical backtest didn't justify the exclusion —
  // see lib/run-screen.ts:EXCLUDED_SECTORS for the audit trail.
  const computedAvg = useMemo(
    () => computeAverageDE(initial.rows),
    [initial.rows]
  );

  // In avg mode, keep the active threshold synced to the computed average.
  // In custom mode, the user-typed value sticks.
  useEffect(() => {
    if (thresholdMode === "avg") setActiveThreshold(computedAvg);
  }, [thresholdMode, computedAvg]);

  const recomputed = useMemo(
    () => applyLevers(initial.rows, activeThreshold, declineYears),
    [initial.rows, activeThreshold, declineYears]
  );

  const matchedCount = useMemo(
    () => recomputed.filter((r) => r.matched).length,
    [recomputed]
  );
  const highConvictionCount = useMemo(
    () => recomputed.filter((r) => r.highConvictionMatched).length,
    [recomputed]
  );

  const visibleRows = useMemo(() => {
    let rows = [...recomputed];
    if (!showAll) {
      rows =
        convictionMode === "highOnly"
          ? rows.filter((r) => r.highConvictionMatched)
          : rows.filter((r) => r.matched);
      if (ttmConfirmedOnly) rows = rows.filter((r) => !r.ttmRecovering);
    }
    if (sectorFilter !== "all")
      rows = rows.filter((r) => r.sector === sectorFilter);
    rows.sort((a, b) => {
      const av = getCmp(a, sortKey);
      const bv = getCmp(b, sortKey);
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
  }, [recomputed, showAll, convictionMode, sectorFilter, sortKey, sortDir, ttmConfirmedOnly]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "ticker" || key === "entityName" || key === "sector" ? "asc" : "desc");
    }
  }

  function applyMode(mode: ThresholdMode) {
    setThresholdMode(mode);
    if (mode === "avg") setActiveThreshold(computedAvg);
  }

  function applyCustom() {
    const v = Number(customThresholdInput);
    if (Number.isFinite(v) && v >= 0) setActiveThreshold(v);
  }

  const data: ScreenResult = {
    ...initial,
    rows: recomputed,
    matchedCount,
    highConvictionCount,
    threshold: { kind: thresholdMode === "avg" ? "average" : "fixed", value: activeThreshold },
  };
  const isPending = false;

  return (
    <div className="min-h-screen bg-terminal-bg text-terminal-fg">
      <Header data={data} />

      <TradeGate data={data} />
      <GuardrailsBar data={data} />

      <FilterBar
        data={data}
        showAll={showAll}
        setShowAll={setShowAll}
        convictionMode={convictionMode}
        setConvictionMode={setConvictionMode}
        thresholdMode={thresholdMode}
        setThresholdMode={applyMode}
        customThreshold={customThresholdInput}
        setCustomThreshold={setCustomThresholdInput}
        onApplyCustom={applyCustom}
        sectors={sectors}
        sectorFilter={sectorFilter}
        setSectorFilter={setSectorFilter}
        ttmConfirmedOnly={ttmConfirmedOnly}
        setTtmConfirmedOnly={setTtmConfirmedOnly}
        declineYears={declineYears}
        setDeclineYears={setDeclineYears}
        isPending={isPending}
      />

      <main className="mx-auto max-w-[1400px] px-6 pb-24">
        <div className="overflow-x-auto rounded border border-terminal-border bg-terminal-panel/30">
          <table className="terminal w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-terminal-muted">
              <tr>
                <Th onClick={() => toggleSort("ticker")} active={sortKey === "ticker"} dir={sortDir}>
                  Ticker
                </Th>
                <Th onClick={() => toggleSort("entityName")} active={sortKey === "entityName"} dir={sortDir}>
                  Issuer
                </Th>
                <Th onClick={() => toggleSort("sector")} active={sortKey === "sector"} dir={sortDir}>
                  Sector
                </Th>
                <Th right onClick={() => toggleSort("mlShortScore")} active={sortKey === "mlShortScore"} dir={sortDir}>
                  ML
                </Th>
                <Th right onClick={() => toggleSort("debtToEquity")} active={sortKey === "debtToEquity"} dir={sortDir}>
                  D/E
                </Th>
                <Th right onClick={() => toggleSort("rev_t2")} active={sortKey === "rev_t2"} dir={sortDir}>
                  Rev T-2
                </Th>
                <Th right onClick={() => toggleSort("yoy_t1")} active={sortKey === "yoy_t1"} dir={sortDir}>
                  YoY
                </Th>
                <Th right onClick={() => toggleSort("rev_t1")} active={sortKey === "rev_t1"} dir={sortDir}>
                  Rev T-1
                </Th>
                <Th right onClick={() => toggleSort("yoy_t")} active={sortKey === "yoy_t"} dir={sortDir}>
                  YoY
                </Th>
                <Th right onClick={() => toggleSort("rev_t")} active={sortKey === "rev_t"} dir={sortDir}>
                  Rev T
                </Th>
                <Th right onClick={() => toggleSort("revTtm")} active={sortKey === "revTtm"} dir={sortDir}>
                  Rev TTM
                </Th>
                <Th right onClick={() => toggleSort("revTtmYoy")} active={sortKey === "revTtmYoy"} dir={sortDir}>
                  ΔTTM
                </Th>
                <Th right onClick={() => toggleSort("ocf_t")} active={sortKey === "ocf_t"} dir={sortDir}>
                  OCF T
                </Th>
                <Th right onClick={() => toggleSort("yoy_ocf_t")} active={sortKey === "yoy_ocf_t"} dir={sortDir}>
                  ΔOCF
                </Th>
                <Th>Flags</Th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <Row key={r.ticker} row={r} dim={!r.matched} />
              ))}
            </tbody>
          </table>
        </div>

        {visibleRows.length === 0 && (
          <p className="mt-8 text-center text-terminal-muted">
            No companies match the current filter.
          </p>
        )}

        <PortfolioPanel data={data} />
        <BacktestPanel data={data} />
        <Footer data={data} />
      </main>
    </div>
  );
}

// Annualized-return gate banner. Three states:
//  • GREEN   — an unleveraged strategy clears the bar (best case)
//  • SKY     — only a leveraged strategy clears (trade allowed with margin)
//  • AMBER   — nothing clears the bar (don't trade)
function TradeGate({ data }: { data: ScreenResult }) {
  const p = data.portfolio;
  if (!p) return null;
  const bar = p.annualizedBar;
  const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const unlevWinner = p.bestUnleveragedClearingBar;
  const overall = p.bestByEquity;
  const overallClearsBar = p.anyStrategyMeetsBar;

  if (unlevWinner) {
    return (
      <div className="border-b border-emerald-700/40 bg-emerald-950/30">
        <div className="mx-auto max-w-[1400px] px-6 py-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="rounded bg-emerald-700 px-2 py-0.5 font-data text-xs uppercase text-white">
              trade signal
            </span>
            <span className="text-emerald-300">
              An unleveraged strategy clears the {fmtPct(bar)} annualized bar.
            </span>
            <span className="font-data text-emerald-100">
              {unlevWinner.name} → ann{" "}
              {fmtPct(unlevWinner.annualizedReturn ?? 0)}, win{" "}
              {fmtPct(unlevWinner.winRate)}, n={unlevWinner.nTaken}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (overallClearsBar && overall.annualizedReturn != null) {
    const peak = overall.peakGrossDeployment ?? 1;
    return (
      <div className="border-b border-sky-700/40 bg-sky-950/30">
        <div className="mx-auto max-w-[1400px] px-6 py-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="rounded bg-sky-700 px-2 py-0.5 font-data text-xs uppercase text-white">
              trade with margin
            </span>
            <span className="text-sky-300">
              No <em>unleveraged</em> strategy clears {fmtPct(bar)} but a
              leveraged strategy does.
            </span>
            <span className="font-data text-sky-100">
              {overall.name} → ann {fmtPct(overall.annualizedReturn)}, peak
              deployment {(peak * 100).toFixed(0)}%, win{" "}
              {fmtPct(overall.winRate)}, n={overall.nTaken}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-sky-200/70">
            Requires a portfolio-margin account. Pair-trade structure caps
            historical drawdown at{" "}
            {fmtPct(overall.maxDrawdown)}; leverage doubles both gains and
            losses.
          </div>
        </div>
      </div>
    );
  }

  const best = p.bestUnleveraged;
  return (
    <div className="border-b border-amber-accent/40 bg-amber-accent/10">
      <div className="mx-auto max-w-[1400px] px-6 py-3 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="rounded bg-amber-accent px-2 py-0.5 font-data text-xs uppercase text-terminal-bg">
            don&apos;t trade
          </span>
          <span className="text-amber-accent">
            No strategy clears the {fmtPct(bar)} annualized bar.
          </span>
          <span className="text-terminal-muted">
            Best unleveraged backtest is{" "}
            <span className="font-data text-amber-accent">
              {fmtPct(best.annualizedReturn ?? 0)}
            </span>{" "}
            ({best.name}, n={best.nTaken}). Per the user-set rule, the screen
            recommends <span className="font-semibold">waiting</span> on real
            trades until the strategy clears the threshold.
          </span>
        </div>
      </div>
    </div>
  );
}

// Persisted user inputs for guardrails (capital, borrow rates, checklist
// state). Stored in localStorage so the gates survive across sessions.
function useLocalStorageState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setV(JSON.parse(raw) as T);
    } catch {}
  }, [key]);
  const setter = (nv: T) => {
    setV(nv);
    try {
      localStorage.setItem(key, JSON.stringify(nv));
    } catch {}
  };
  return [v, setter];
}

// GuardrailsBar enforces the seven stress-test recommendations. Each rule
// is either auto-evaluated from server data (regime exclusions, paper-
// trade days, ML test AUC) or backed by user input persisted client-side
// (capital, borrow rates, checklist acks). When any rule fails, real
// trade signals downgrade visually and a "PRE-TRADE BLOCKED" indicator
// shows above the matched names.
function GuardrailsBar({ data }: { data: ScreenResult }) {
  const g = data.guardrails;
  const [capital, setCapital] = useLocalStorageState<number>(
    "stt:capital",
    100_000
  );
  const [checklistAcked, setChecklistAcked] = useLocalStorageState<{
    stopLoss: boolean;
    borrowVerified: boolean;
    paperReady: boolean;
    mlNotUsed: boolean;
  }>("stt:checklist", {
    stopLoss: false,
    borrowVerified: false,
    paperReady: false,
    mlNotUsed: false,
  });
  const [showPanel, setShowPanel] = useState<boolean>(false);

  const fmtPctNoSign = (n: number) => `${(n * 100).toFixed(0)}%`;
  const recommendedSize = capital * g.capitalCapPct;
  const allChecked =
    checklistAcked.stopLoss &&
    checklistAcked.borrowVerified &&
    checklistAcked.paperReady &&
    checklistAcked.mlNotUsed;

  const ruleStatuses: Array<{
    key: string;
    label: string;
    ok: boolean;
    detail: string;
  }> = [
    {
      key: "capital",
      label: `1) Position size ≤ ${fmtPctNoSign(g.capitalCapPct)} of capital`,
      ok: capital > 0,
      detail: capital > 0
        ? `$${recommendedSize.toLocaleString()} max per trade on $${capital.toLocaleString()} stated capital`
        : "set your total trading capital below",
    },
    {
      key: "regime",
      label: `2) Regime exclusions active (${g.regimeExclusions.length})`,
      ok: true,
      detail:
        g.regimeExclusions.length > 0
          ? g.regimeExclusions
              .map((r) => `${r.sector} until ${r.until}`)
              .join(", ")
          : "none",
    },
    {
      key: "borrow",
      label: `4) Reject if borrow > ${fmtPctNoSign(g.maxBorrowRate)}`,
      ok: checklistAcked.borrowVerified,
      detail: "verify per-name borrow rate before entry",
    },
    {
      key: "stop",
      label: `5) Margin-equity stop at ${fmtPctNoSign(g.marginEquityStopLossPct)}`,
      ok: checklistAcked.stopLoss,
      detail:
        "place a hard stop at -20% of margin equity (NOT position) before opening any trade",
    },
    {
      key: "paper",
      label: `6) Paper-trade ${g.paperTradeRequiredDays} days before live`,
      ok: g.paperTradeReady,
      detail: `${g.paperTradeDaysAccumulated} / ${g.paperTradeRequiredDays} days accumulated since ${g.paperTradeTrackingSince}`,
    },
    {
      key: "ml",
      label: "7) ML score is reference-only",
      ok: !g.mlScoreDecisionUse,
      detail: g.mlTestAuc != null
        ? `model test AUC ${g.mlTestAuc.toFixed(2)} — do not use as decision input`
        : "model AUC unknown",
    },
  ];

  const failingCount = ruleStatuses.filter((r) => !r.ok).length;

  return (
    <div className="border-b border-terminal-border bg-terminal-panel/40">
      <div className="mx-auto max-w-[1400px] px-6 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded px-2 py-0.5 font-data text-[10px] uppercase ${failingCount === 0 ? "bg-emerald-700 text-white" : "bg-amber-accent text-terminal-bg"}`}
          >
            guardrails {failingCount === 0 ? "✓ all green" : `${failingCount} pending`}
          </span>
          <span className="text-terminal-muted">
            paper trade <span className="font-data">{g.paperTradeDaysAccumulated}</span>/<span className="font-data">{g.paperTradeRequiredDays}</span>d
          </span>
          <span className="text-terminal-muted">
            cap{" "}
            <input
              type="number"
              min="0"
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value) || 0)}
              className="w-24 rounded border border-terminal-border bg-terminal-bg px-1 py-0.5 font-data text-[11px] text-terminal-fg focus:border-amber-accent focus:outline-none"
            />{" "}
            → max <span className="font-data text-amber-accent">${recommendedSize.toLocaleString()}</span>/pos
          </span>
          {g.regimeExclusions.length > 0 && (
            <span className="text-purple-400">
              regime: {g.regimeExclusions.map((r) => r.sector).join(", ")}{" "}
              excluded
            </span>
          )}
          <button
            onClick={() => setShowPanel(!showPanel)}
            className="ml-auto rounded border border-terminal-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-terminal-muted hover:text-amber-accent hover:border-amber-accent"
          >
            {showPanel ? "hide" : "show"} pre-trade checklist
          </button>
        </div>

        {showPanel && (
          <div className="mt-3 rounded border border-terminal-border bg-terminal-bg p-3">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-terminal-muted">
              Pre-trade checklist (must all be acked before opening any
              real-money position)
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {ruleStatuses.map((r) => {
                const interactiveKey =
                  r.key === "stop"
                    ? ("stopLoss" as const)
                    : r.key === "borrow"
                      ? ("borrowVerified" as const)
                      : r.key === "ml"
                        ? ("mlNotUsed" as const)
                        : null;
                const showCheckbox = interactiveKey != null;
                return (
                  <div
                    key={r.key}
                    className={`rounded border p-2 ${r.ok ? "border-emerald-700/40 bg-emerald-950/10" : "border-amber-accent/40 bg-amber-accent/5"}`}
                  >
                    <div className="flex items-center gap-2 text-[11px]">
                      <span
                        className={`font-data ${r.ok ? "text-emerald-400" : "text-amber-accent"}`}
                      >
                        {r.ok ? "✓" : "✗"}
                      </span>
                      <span className="font-medium">{r.label}</span>
                      {showCheckbox && (
                        <label className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-wider text-terminal-muted">
                          <input
                            type="checkbox"
                            checked={
                              checklistAcked[interactiveKey!]
                            }
                            onChange={(e) =>
                              setChecklistAcked({
                                ...checklistAcked,
                                [interactiveKey!]: e.target.checked,
                              })
                            }
                            className="accent-amber-accent"
                          />
                          ack
                        </label>
                      )}
                    </div>
                    <div className="mt-1 text-[10px] text-terminal-muted">
                      {r.detail}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 text-[10px] text-terminal-muted">
              {allChecked && g.paperTradeReady ? (
                <span className="text-emerald-400">
                  ✓ All gates passed — ok to open a real-money position at
                  the recommended size.
                </span>
              ) : !g.paperTradeReady ? (
                <span className="text-amber-accent">
                  ⚠ Paper-trade window incomplete ({g.paperTradeDaysAccumulated}{" "}
                  / {g.paperTradeRequiredDays} days). Stay on paper trades
                  until the gate clears.
                </span>
              ) : (
                <span className="text-amber-accent">
                  ⚠ Some checklist items unacknowledged — do not open a
                  real-money trade yet.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Header({ data }: { data: ScreenResult }) {
  return (
    <header className="border-b border-terminal-border bg-terminal-panel/40 backdrop-blur">
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-terminal-fg">
              Short That Shit
            </h1>
            <p className="mt-1 text-sm text-terminal-muted">
              S&P 500 — high leverage <span className="dim">∩</span> revenue declining 2y straight
            </p>
          </div>
          <div className="font-data text-right text-xs text-terminal-muted">
            <div>generated {new Date(data.generatedAt).toISOString().slice(0, 19).replace("T", " ")}Z</div>
            <div className="mt-1 dim">
              cache {data.cacheHits}H / {data.cacheMisses}M · source SEC EDGAR
            </div>
            <a
              href="/backtest"
              className="mt-1 inline-block text-amber-accent hover:underline"
            >
              backtest review →
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}

function FilterBar(props: {
  data: ScreenResult;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  convictionMode: ConvictionMode;
  setConvictionMode: (m: ConvictionMode) => void;
  thresholdMode: ThresholdMode;
  setThresholdMode: (m: ThresholdMode) => void;
  customThreshold: string;
  setCustomThreshold: (v: string) => void;
  onApplyCustom: () => void;
  sectors: string[];
  sectorFilter: string;
  setSectorFilter: (v: string) => void;
  ttmConfirmedOnly: boolean;
  setTtmConfirmedOnly: (v: boolean) => void;
  declineYears: 1 | 2 | 3;
  setDeclineYears: (v: 1 | 2 | 3) => void;
  isPending: boolean;
}) {
  const {
    data,
    showAll,
    setShowAll,
    convictionMode,
    setConvictionMode,
    thresholdMode,
    setThresholdMode,
    customThreshold,
    setCustomThreshold,
    onApplyCustom,
    sectors,
    sectorFilter,
    setSectorFilter,
    ttmConfirmedOnly,
    setTtmConfirmedOnly,
    declineYears,
    setDeclineYears,
    isPending,
  } = props;

  return (
    <div className="border-b border-terminal-border bg-terminal-bg">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-end gap-x-8 gap-y-4 px-6 py-4">
        <Stat label="universe" value={data.universeSize.toString()} />
        <Stat label="matched" value={data.matchedCount.toString()} accent />
        <Stat
          label="high conviction"
          value={data.highConvictionCount.toString()}
          accent
        />
        <Stat
          label={`threshold (${data.threshold.kind})`}
          value={data.threshold.value.toFixed(2)}
        />

        <div className="flex items-center gap-2 border-l border-terminal-border pl-8">
          <span className="text-xs uppercase tracking-wider text-terminal-muted">
            D/E threshold
          </span>
          <button
            onClick={() => setThresholdMode("avg")}
            className={`rounded border px-2 py-1 font-data text-xs transition-colors ${
              thresholdMode === "avg"
                ? "border-amber-accent text-amber-accent"
                : "border-terminal-border text-terminal-muted hover:text-terminal-fg"
            }`}
            disabled={isPending}
          >
            universe avg
          </button>
          <button
            onClick={() => setThresholdMode("custom")}
            className={`rounded border px-2 py-1 font-data text-xs transition-colors ${
              thresholdMode === "custom"
                ? "border-amber-accent text-amber-accent"
                : "border-terminal-border text-terminal-muted hover:text-terminal-fg"
            }`}
            disabled={isPending}
          >
            custom
          </button>
          {thresholdMode === "custom" && (
            <>
              <input
                type="number"
                step="0.1"
                min="0"
                value={customThreshold}
                onChange={(e) => setCustomThreshold(e.target.value)}
                className="w-20 rounded border border-terminal-border bg-terminal-bg px-2 py-1 font-data text-xs text-terminal-fg focus:border-amber-accent focus:outline-none"
              />
              <button
                onClick={onApplyCustom}
                disabled={isPending}
                className="rounded border border-amber-accent px-2 py-1 font-data text-xs text-amber-accent hover:bg-amber-accent hover:text-terminal-bg disabled:opacity-50"
              >
                apply
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-l border-terminal-border pl-8">
          <span className="text-xs uppercase tracking-wider text-terminal-muted">
            conviction
          </span>
          <button
            onClick={() => setConvictionMode("all")}
            className={`rounded border px-2 py-1 font-data text-xs transition-colors ${
              convictionMode === "all"
                ? "border-amber-accent text-amber-accent"
                : "border-terminal-border text-terminal-muted hover:text-terminal-fg"
            }`}
            disabled={isPending}
            title="All matches: revenue declining + leverage match (excludes buyback-driven neg-eq)"
          >
            all matches
          </button>
          <button
            onClick={() => setConvictionMode("highOnly")}
            className={`rounded border px-2 py-1 font-data text-xs transition-colors ${
              convictionMode === "highOnly"
                ? "border-amber-accent text-amber-accent"
                : "border-terminal-border text-terminal-muted hover:text-terminal-fg"
            }`}
            disabled={isPending}
            title="High conviction: also requires OCF declining (filters out dividend traps like MO)"
          >
            high only
          </button>
        </div>

        <div className="flex items-center gap-2 border-l border-terminal-border pl-8">
          <span className="text-xs uppercase tracking-wider text-terminal-muted">
            decline yrs
          </span>
          {([1, 2, 3] as const).map((n) => (
            <button
              key={n}
              onClick={() => setDeclineYears(n)}
              className={`rounded border px-2 py-1 font-data text-xs transition-colors ${
                declineYears === n
                  ? "border-amber-accent text-amber-accent"
                  : "border-terminal-border text-terminal-muted hover:text-terminal-fg"
              }`}
              disabled={isPending}
              title={`Require ${n} consecutive year${n > 1 ? "s" : ""} of revenue decline`}
            >
              {n}y
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 border-l border-terminal-border pl-8 text-xs uppercase tracking-wider text-terminal-muted">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="accent-amber-accent"
          />
          show full universe
        </label>

        <label
          className="flex items-center gap-2 text-xs uppercase tracking-wider text-terminal-muted"
          title="TTM-confirmed only: hide matches whose YTD revenue trend has turned positive (potential turnarounds). Tightens the short-candidate list."
        >
          <input
            type="checkbox"
            checked={ttmConfirmedOnly}
            onChange={(e) => setTtmConfirmedOnly(e.target.checked)}
            className="accent-amber-accent"
          />
          TTM-confirmed only
        </label>

        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-terminal-muted">
            sector
          </span>
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

        {isPending && (
          <span className="ml-auto font-data text-xs text-amber-accent">
            running screen...
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-terminal-muted">
        {label}
      </div>
      <div
        className={`font-data text-xl ${
          accent ? "text-amber-accent" : "text-terminal-fg"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

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

const FLAG_STYLE: Record<ScreenFlag, string> = {
  negative_equity: "border-red-700 text-red-400",
  buyback_driven_neg_equity: "border-sky-700 text-sky-400",
  buyback_winding_down: "border-orange-700 text-orange-400",
  ocf_declining: "border-amber-accent/60 text-amber-accent",
  ocf_resilient: "border-emerald-700 text-emerald-400",
  missing_revenue: "border-terminal-border text-terminal-muted",
  missing_balance_sheet: "border-terminal-border text-terminal-muted",
  sector_ineligible: "border-slate-700 text-slate-400",
  ttm_recovering: "border-yellow-700 text-yellow-500",
  ttm_accelerating: "border-rose-700 text-rose-400",
  regime_excluded: "border-purple-700 text-purple-400",
};

const FLAG_LABEL: Record<ScreenFlag, string> = {
  negative_equity: "neg eq",
  buyback_driven_neg_equity: "buyback-driven",
  buyback_winding_down: "buyback ↓",
  ocf_declining: "ocf ↓",
  ocf_resilient: "ocf resilient",
  missing_revenue: "missing rev",
  missing_balance_sheet: "missing bs",
  sector_ineligible: "sector excl",
  ttm_recovering: "ttm ↑",
  ttm_accelerating: "ttm ↓↓",
  regime_excluded: "regime ✋",
};

function Row({ row, dim }: { row: ScreenRow; dim: boolean }) {
  const negEquity = row.flags.includes("negative_equity");
  const buybackDriven = row.negEquityType === "buyback_driven";
  const baseColor = dim ? "text-terminal-muted" : "text-terminal-fg";
  // Buyback-driven neg-eq gets a softer treatment than true distress
  const rowBg = negEquity
    ? buybackDriven
      ? "bg-sky-950/20"
      : "bg-red-950/30"
    : "";
  return (
    <tr className={`${rowBg} ${dim ? "opacity-50" : ""}`}>
      <td className={`px-3 py-2 font-data font-semibold ${baseColor}`}>
        <a
          href={`https://finance.yahoo.com/quote/${encodeURIComponent(row.ticker)}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${row.ticker} on Yahoo Finance`}
          className="text-amber-accent underline decoration-dotted underline-offset-2 hover:decoration-solid hover:text-amber-300"
        >
          {row.ticker}
          <span aria-hidden="true" className="ml-1 text-[9px]">↗</span>
        </a>
        {row.highConvictionMatched ? (
          <span
            className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-amber-accent"
            title="high conviction: rev + ocf both declining"
          />
        ) : row.matched ? (
          <span
            className="ml-2 inline-block h-1.5 w-1.5 rounded-full border border-amber-accent/50"
            title="matched (rev decline + leverage); ocf not also declining"
          />
        ) : null}
      </td>
      <td className={`px-3 py-2 ${baseColor}`}>{row.entityName}</td>
      <td className="px-3 py-2 text-xs text-terminal-muted">{row.sector ?? "—"}</td>
      <td
        className={`px-3 py-2 text-right font-data ${mlScoreColor(row.mlShortScore, dim)}`}
        title={
          row.mlShortScore != null
            ? `Logistic-regression score (test AUC modest — see footer). Higher = model thinks this looks more like historical successful shorts.`
            : "No ML score: missing required features (yoy_t, yoy_t1, ocf_yoy)."
        }
      >
        {row.mlShortScore != null ? row.mlShortScore.toFixed(2) : "—"}
      </td>
      <td
        className={`px-3 py-2 text-right font-data ${
          negEquity ? (buybackDriven ? "text-sky-400" : "text-red-400") : baseColor
        }`}
      >
        {negEquity ? "neg eq" : fmtNum(row.debtToEquity)}
      </td>
      <td className={`px-3 py-2 text-right font-data ${baseColor}`}>
        <div>{fmtUSD(row.rev_t2)}</div>
        <div className="text-[10px] dim">{shortDate(row.rev_t2_end)}</div>
      </td>
      <td className={`px-3 py-2 text-right font-data ${yoyColor(row.yoy_t1, dim)}`}>
        {fmtPct(row.yoy_t1)}
      </td>
      <td className={`px-3 py-2 text-right font-data ${baseColor}`}>
        <div>{fmtUSD(row.rev_t1)}</div>
        <div className="text-[10px] dim">{shortDate(row.rev_t1_end)}</div>
      </td>
      <td className={`px-3 py-2 text-right font-data ${yoyColor(row.yoy_t, dim)}`}>
        {fmtPct(row.yoy_t)}
      </td>
      <td className={`px-3 py-2 text-right font-data ${baseColor}`}>
        <div>{fmtUSD(row.rev_t)}</div>
        <div className="text-[10px] dim">{shortDate(row.rev_t_end)}</div>
      </td>
      <td className={`px-3 py-2 text-right font-data ${baseColor}`}>
        <div>{fmtUSD(row.revTtm)}</div>
        <div className="text-[10px] dim">
          {row.revTtmEnd ? shortDate(row.revTtmEnd) : "—"}
          {row.revTtmMonthsYtd ? ` · ${row.revTtmMonthsYtd}m ytd` : ""}
        </div>
      </td>
      <td className={`px-3 py-2 text-right font-data ${yoyColor(row.revTtmYoy, dim)}`}>
        {fmtPct(row.revTtmYoy)}
      </td>
      <td className={`px-3 py-2 text-right font-data ${baseColor}`}>
        <div>{fmtUSD(row.ocf_t)}</div>
        <div className="text-[10px] dim">{shortDate(row.ocf_t_end)}</div>
      </td>
      <td className={`px-3 py-2 text-right font-data ${yoyColor(row.yoy_ocf_t, dim)}`}>
        {fmtPct(row.yoy_ocf_t)}
      </td>
      <td className="px-3 py-2 font-data text-[10px] text-terminal-muted">
        {row.flags.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          row.flags.map((f) => (
            <span
              key={f}
              className={`mr-1 inline-block rounded border px-1 py-0.5 ${FLAG_STYLE[f]}`}
            >
              {FLAG_LABEL[f]}
            </span>
          ))
        )}
      </td>
    </tr>
  );
}

function yoyColor(n: number | null, dim: boolean): string {
  if (dim) return "text-terminal-muted";
  if (n == null) return "text-terminal-muted";
  if (n < 0) return "text-red-400";
  return "text-terminal-fg";
}

function mlScoreColor(s: number | null, dim: boolean): string {
  if (dim) return "text-terminal-muted";
  if (s == null) return "text-terminal-muted";
  if (s >= 0.7) return "text-amber-accent";
  if (s >= 0.5) return "text-terminal-fg";
  return "text-terminal-muted";
}

function PortfolioPanel({ data }: { data: ScreenResult }) {
  const p = data.portfolio;
  if (!p) return null;
  const fmtUSD = (n: number) => `$${n.toFixed(0)}`;
  const fmtPct = (n: number | null) =>
    n == null ? "—" : `${(n * 100).toFixed(1)}%`;
  return (
    <section className="mt-10 border-t border-terminal-border pt-8 text-xs text-terminal-muted">
      <h3 className="font-display text-base text-terminal-fg">
        Portfolio simulation — what would $
        {p.startingBalance.toLocaleString()} have done?
      </h3>
      <p className="mt-2 leading-relaxed">
        Each historical screen trigger is opened as a long-short pair (short
        ticker + long SPY) with a fixed dollar size, held for 12 months, paying
        2% annualized borrow on the short half. Pair trades capture the screen&apos;s
        actual prediction — relative underperformance — without market-direction
        risk.
      </p>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <h4 className="font-display text-sm text-terminal-fg">
            Best (unleveraged, 1x deployment)
          </h4>
          <div className="mt-2 font-data text-2xl text-amber-accent">
            {fmtUSD(p.bestUnleveraged.finalEquity)}
          </div>
          <div className="text-[11px] text-terminal-muted">
            {fmtPct(p.bestUnleveraged.totalReturn)} total · annualized{" "}
            {fmtPct(p.bestUnleveraged.annualizedReturn)} · win rate{" "}
            {fmtPct(p.bestUnleveraged.winRate)} · max DD{" "}
            {fmtPct(p.bestUnleveraged.maxDrawdown)} · n=
            {p.bestUnleveraged.nTaken}
            {p.bestUnleveraged.peakGrossDeployment != null && (
              <>
                {" "}
                · peak deployment{" "}
                {(p.bestUnleveraged.peakGrossDeployment * 100).toFixed(0)}%
              </>
            )}
          </div>
          <div className="mt-2 text-[11px] leading-relaxed">
            <span className="font-data text-amber-accent">
              {p.bestUnleveraged.name}
            </span>{" "}
            — {p.bestUnleveraged.description}
          </div>
          <div className="mt-2 text-[10px] leading-relaxed text-terminal-muted">
            Strict no-leverage: position size × max concurrent ≤ starting
            balance. The realistic answer for a cash account without margin
            extension.
          </div>
        </div>
        <div>
          <h4 className="font-display text-sm text-terminal-fg">
            Best with margin / leverage (reference only)
          </h4>
          <div className="mt-2 font-data text-2xl text-sky-400">
            {fmtUSD(p.bestByEquity.finalEquity)}
          </div>
          <div className="text-[11px] text-terminal-muted">
            {fmtPct(p.bestByEquity.totalReturn)} total · annualized{" "}
            {fmtPct(p.bestByEquity.annualizedReturn)} · win rate{" "}
            {fmtPct(p.bestByEquity.winRate)} · max DD{" "}
            {fmtPct(p.bestByEquity.maxDrawdown)} · n={p.bestByEquity.nTaken}
            {p.bestByEquity.peakGrossDeployment != null && (
              <>
                {" "}
                · peak deployment{" "}
                {(p.bestByEquity.peakGrossDeployment * 100).toFixed(0)}%
              </>
            )}
          </div>
          <div className="mt-2 text-[11px] leading-relaxed">
            <span className="font-data text-sky-400">
              {p.bestByEquity.name}
            </span>{" "}
            — {p.bestByEquity.description}
          </div>
          <div className="mt-2 text-[10px] leading-relaxed text-terminal-muted">
            Includes 2x portfolio leverage and/or compounded sizing that
            exceeds 100% gross deployment. Achievable with portfolio margin
            but not without it. Pair-trade structure caps drawdowns under
            leverage; double-edged on losses.
          </div>
        </div>
      </div>
      <h5 className="mt-6 text-[11px] uppercase tracking-wider text-terminal-muted">
        Top 5 strategies tested ({p.topStrategies.length} of many)
      </h5>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-terminal-muted">
            <tr>
              <th className="text-left">Strategy</th>
              <th className="text-right">Final $</th>
              <th className="text-right">Total</th>
              <th className="text-right">Annualized</th>
              <th className="text-right">Win</th>
              <th className="text-right">Max DD</th>
              <th className="text-right">n</th>
            </tr>
          </thead>
          <tbody>
            {p.topStrategies.map((s) => (
              <tr key={s.name}>
                <td className="py-0.5 font-data text-[11px]">{s.name}</td>
                <td className="py-0.5 text-right font-data">
                  {fmtUSD(s.finalEquity)}
                </td>
                <td
                  className={`py-0.5 text-right font-data ${s.totalReturn >= 0 ? "text-emerald-400" : "text-red-400"}`}
                >
                  {fmtPct(s.totalReturn)}
                </td>
                <td className="py-0.5 text-right font-data">
                  {fmtPct(s.annualizedReturn)}
                </td>
                <td className="py-0.5 text-right font-data">
                  {fmtPct(s.winRate)}
                </td>
                <td className="py-0.5 text-right font-data">
                  {fmtPct(s.maxDrawdown)}
                </td>
                <td className="py-0.5 text-right font-data text-terminal-muted">
                  {s.nTaken}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 leading-relaxed">
        <span className="text-amber-accent">Honest read:</span> the screen&apos;s
        actual edge is in pair-trade structure (short ticker + long SPY
        equally) — naked shorts blow up ($10K → -$8.5K) because markets
        rise. <strong>Unleveraged best is ~5.5% annualized</strong> (vs SPY&apos;s
        ~12% over the same window) — modest but with{" "}
        <span className="font-data">~0% max drawdown</span> and 100% win
        rate, so risk-adjusted it&apos;s competitive. Adding 2x portfolio
        margin roughly doubles the annualized to ~8%, but amplifies losses
        if the alpha shifts. ML iteration was attempted (walk-forward
        logistic regression, sector-prior nearest-neighbor, L2 sweep): all
        topped out at ~3% annualized — walk-forward AUC is{" "}
        <span className="font-data">0.51</span>, indistinguishable from
        random. <strong>Rule-based filtering dominates ML on this dataset.</strong>{" "}
        The bottleneck is event count (154 over 15y); expanding the universe
        to delisted tickers would help.
      </p>
    </section>
  );
}

function BacktestPanel({ data }: { data: ScreenResult }) {
  const bt = data.backtest;
  const ml = data.mlModel;
  if (!bt && !ml) return null;
  return (
    <section className="mt-10 border-t border-terminal-border pt-8 text-xs text-terminal-muted">
      <h3 className="font-display text-base text-terminal-fg">
        Historical backtest &amp; ML model
      </h3>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        {bt && (
          <div>
            <h4 className="font-display text-sm text-terminal-fg">
              Backtest aggregate
            </h4>
            <p className="mt-1">
              <span className="font-data text-terminal-fg">
                {bt.withForwardReturns}
              </span>{" "}
              historical screen triggers with ≥1y forward returns. Forward
              return measured from the original 10-K filing date, vs SPY
              over the same window.
            </p>
            <table className="mt-3 w-full text-xs">
              <tbody>
                <tr>
                  <td className="py-0.5">Mean α₁y vs SPY</td>
                  <td className="py-0.5 text-right font-data">
                    {bt.meanAlpha1y != null
                      ? `${(bt.meanAlpha1y * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td className="py-0.5">Median α₁y</td>
                  <td className="py-0.5 text-right font-data">
                    {bt.medianAlpha1y != null
                      ? `${(bt.medianAlpha1y * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td className="py-0.5">Hit rate (α₁y &lt; -5%)</td>
                  <td className="py-0.5 text-right font-data">
                    {bt.hitRate != null
                      ? `${(bt.hitRate * 100).toFixed(0)}%`
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td className="py-0.5">Big miss rate (α₁y &gt; +20%)</td>
                  <td className="py-0.5 text-right font-data">
                    {bt.hitRateBigMiss != null
                      ? `${(bt.hitRateBigMiss * 100).toFixed(0)}%`
                      : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
            <h5 className="mt-4 text-[11px] uppercase tracking-wider text-terminal-muted">
              Hit rate by sector
            </h5>
            <table className="mt-1 w-full text-xs">
              <tbody>
                {Object.entries(bt.bySector)
                  .filter(([, v]) => v.count >= 3)
                  .sort(
                    (a, b) =>
                      (a[1].meanAlpha1y ?? 0) - (b[1].meanAlpha1y ?? 0)
                  )
                  .map(([sector, v]) => (
                    <tr key={sector}>
                      <td className="py-0.5">{sector}</td>
                      <td className="py-0.5 text-right font-data text-terminal-muted">
                        n={v.count}
                      </td>
                      <td
                        className={`py-0.5 pl-3 text-right font-data ${v.meanAlpha1y != null && v.meanAlpha1y < 0 ? "text-red-400" : "text-terminal-fg"}`}
                      >
                        {v.meanAlpha1y != null
                          ? `${(v.meanAlpha1y * 100).toFixed(1)}%`
                          : "—"}
                      </td>
                      <td className="py-0.5 pl-3 text-right font-data text-terminal-muted">
                        hit{" "}
                        {v.hitRate != null
                          ? `${(v.hitRate * 100).toFixed(0)}%`
                          : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="mt-3 leading-relaxed">
              <span className="text-amber-accent">Honest read:</span> the
              strategy works in some sectors (notably Consumer Staples) and{" "}
              <em>fails</em> in others (Industrials, Consumer Discretionary
              tend to mean-revert hard). Survivorship bias inflates the
              numbers — the universe is current SP500, so companies that
              went bankrupt (the best historical shorts) aren&apos;t included.
            </p>
          </div>
        )}
        {ml && (
          <div>
            <h4 className="font-display text-sm text-terminal-fg">
              ML short-conviction model
            </h4>
            <p className="mt-1">
              Logistic regression. Target:{" "}
              <span className="font-data">{ml.positiveLabelDef}</span>.
              Walk-forward split: train on events with end-year &lt;{" "}
              <span className="font-data">{ml.trainSplitYearLt}</span>, test
              on later events.
            </p>
            <table className="mt-3 w-full text-xs">
              <tbody>
                <tr>
                  <td className="py-0.5">Train AUC</td>
                  <td className="py-0.5 text-right font-data">
                    {ml.trainAuc.toFixed(3)} <span className="dim">(n={ml.trainSize})</span>
                  </td>
                </tr>
                <tr>
                  <td className="py-0.5">Test AUC</td>
                  <td
                    className={`py-0.5 text-right font-data ${ml.testAuc < 0.5 ? "text-red-400" : ml.testAuc < 0.55 ? "text-yellow-500" : "text-emerald-400"}`}
                  >
                    {ml.testAuc.toFixed(3)} <span className="dim">(n={ml.testSize})</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <h5 className="mt-3 text-[11px] uppercase tracking-wider text-terminal-muted">
              Top features (|coef|)
            </h5>
            <table className="mt-1 w-full text-xs">
              <tbody>
                {ml.topFeatures.map((f) => (
                  <tr key={f.name}>
                    <td className="py-0.5 font-data text-[11px]">{f.name}</td>
                    <td
                      className={`py-0.5 text-right font-data ${f.coef >= 0 ? "text-emerald-400" : "text-red-400"}`}
                    >
                      {f.coef >= 0 ? "+" : ""}
                      {f.coef.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 leading-relaxed">
              <span className="text-amber-accent">Honest read:</span> with{" "}
              {ml.trainAuc.toFixed(2)} train AUC and {ml.testAuc.toFixed(2)}{" "}
              test AUC,{" "}
              {ml.testAuc < 0.55
                ? "the model did not generalize across the regime split. The training-set patterns (which sectors / D/E shapes worked pre-2020) didn&apos;t hold post-2020. Use ML score as a relative ranking signal at most, not a calibrated probability."
                : "the model has modest out-of-sample signal. Treat scores as a ranking, not a probability."}{" "}
              Coefficients shown above are interpretable: positive ⇒
              feature pushes the score up (more like historical successful
              shorts), negative ⇒ down.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function Footer({ data }: { data: ScreenResult }) {
  return (
    <section className="mt-12 grid gap-6 border-t border-terminal-border pt-8 text-sm text-terminal-muted md:grid-cols-3">
      <div>
        <h3 className="font-display text-base text-terminal-fg">Screening rules</h3>
        <ul className="mt-2 space-y-1 text-xs">
          <li>
            <span className="font-data text-amber-accent">D/E &gt; threshold</span> —
            total liabilities ÷ stockholders equity, computed from the most
            recent annual 10-K.
          </li>
          <li>
            <span className="font-data text-amber-accent">Revenue decline</span> —
            strict monotonic Rev<sub>t</sub> &lt; Rev<sub>t-1</sub> &lt; Rev
            <sub>t-2</sub> across the last three reported fiscal years.
          </li>
          <li>
            <span className="font-data text-amber-accent">All sectors included</span> —
            an earlier version excluded Financials / REITs / Utilities a priori.
            The historical backtest didn&apos;t support that: Utilities (n=19,
            hit 63%) and REITs (n=3, hit 67%) actually had higher hit rates
            than Industrials or Consumer Discretionary. Default is now
            no-exclusion. Use the sector dropdown to filter manually.
          </li>
          <li>
            <span className="font-data text-amber-accent">Buyback-driven neg-eq filter</span> —
            negative equity is only counted as leverage when cumulative 5y
            buybacks are smaller than the equity deficit (i.e. buybacks can&apos;t
            plausibly explain the deficit).
          </li>
          <li>
            <span className="font-data text-amber-accent">High conviction</span> —
            also requires operating cash flow declining 2y straight, filtering
            out dividend-trap names where revenue shrinks but cash holds up.
          </li>
          <li>
            <span className="font-data text-amber-accent">TTM trend flags</span> —
            <span className="font-data"> ttm ↑</span> means YTD revenue from the
            most recent 10-Q has turned positive vs. prior-year same period
            (potential turnaround, cautionary for shorts).{" "}
            <span className="font-data">ttm ↓↓</span> means YTD is declining
            faster than the most recent annual rate (high conviction).
          </li>
        </ul>
      </div>

      <div>
        <h3 className="font-display text-base text-terminal-fg">Caveats</h3>
        <ul className="mt-2 space-y-1 text-xs">
          <li>
            10-K filings can lag fiscal-year-end by 60–90 days; 10-Q filings
            (the source of TTM data) lag quarter-end by ~45 days.
          </li>
          <li>
            TTM is computed as <span className="font-data">last annual + current YTD − prior-year same-period YTD</span>;
            falls back to null when EDGAR has no quarterly data for the ticker.
          </li>
          <li>
            Revenue and OCF tags merged across multiple GAAP variants
            (ASC-606 transition, continuing-operations splits).
          </li>
          <li>
            Buybacks measured by{" "}
            <span className="font-data">PaymentsForRepurchaseOfCommonStock</span>;
            companies that report only authorization (not actual repurchases)
            may be misclassified as &quot;distress.&quot;
          </li>
        </ul>
      </div>

      <div>
        <h3 className="font-display text-base text-terminal-fg">Disclaimer</h3>
        <p className="mt-2 text-xs">
          Research note. Not investment advice. Data is provided as-is from
          SEC filings; no warranty as to accuracy or completeness. Computed{" "}
          <span className="font-data">{new Date(data.generatedAt).toISOString()}</span>.
        </p>
      </div>
    </section>
  );
}
