"use client";

import { useMemo, useState } from "react";
import type { ScreenResult, ScreenRow } from "@/lib/types";

type SortKey =
  | "ticker"
  | "entityName"
  | "sector"
  | "debtToEquity"
  | "rev_t"
  | "rev_t1"
  | "rev_t2"
  | "yoy_t"
  | "yoy_t1";

type ThresholdMode = "avg" | "custom";

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
  return s.slice(0, 7); // YYYY-MM
}

function getCmp(row: ScreenRow, key: SortKey): number | string {
  switch (key) {
    case "ticker":
      return row.ticker;
    case "entityName":
      return row.entityName;
    case "sector":
      return row.sector ?? "";
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
  }
}

function applyThreshold(rows: ScreenRow[], threshold: number): ScreenRow[] {
  return rows.map((r) => {
    const leverageMatched =
      r.flags.includes("negative_equity") ||
      (r.debtToEquity != null && r.debtToEquity > threshold);
    return {
      ...r,
      leverageMatched,
      matched: r.declineMatched && leverageMatched,
    };
  });
}

export function ScreenView({ initial }: { initial: ScreenResult }) {
  const [showAll, setShowAll] = useState(false);
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

  const sectors = useMemo(() => {
    const set = new Set<string>();
    for (const r of initial.rows) if (r.sector) set.add(r.sector);
    return [...set].sort();
  }, [initial.rows]);

  const recomputed = useMemo(
    () => applyThreshold(initial.rows, activeThreshold),
    [initial.rows, activeThreshold]
  );

  const matchedCount = useMemo(
    () => recomputed.filter((r) => r.matched).length,
    [recomputed]
  );

  const visibleRows = useMemo(() => {
    let rows = [...recomputed];
    if (!showAll) rows = rows.filter((r) => r.matched);
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
  }, [recomputed, showAll, sectorFilter, sortKey, sortDir]);

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
    if (mode === "avg") setActiveThreshold(initial.threshold.value);
  }

  function applyCustom() {
    const v = Number(customThresholdInput);
    if (Number.isFinite(v) && v >= 0) setActiveThreshold(v);
  }

  const data: ScreenResult = {
    ...initial,
    rows: recomputed,
    matchedCount,
    threshold: { kind: thresholdMode === "avg" ? "average" : "fixed", value: activeThreshold },
  };
  const isPending = false;

  return (
    <div className="min-h-screen bg-terminal-bg text-terminal-fg">
      <Header data={data} />

      <FilterBar
        data={data}
        showAll={showAll}
        setShowAll={setShowAll}
        thresholdMode={thresholdMode}
        setThresholdMode={applyMode}
        customThreshold={customThresholdInput}
        setCustomThreshold={setCustomThresholdInput}
        onApplyCustom={applyCustom}
        sectors={sectors}
        sectorFilter={sectorFilter}
        setSectorFilter={setSectorFilter}
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

        <Footer data={data} />
      </main>
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
  thresholdMode: ThresholdMode;
  setThresholdMode: (m: ThresholdMode) => void;
  customThreshold: string;
  setCustomThreshold: (v: string) => void;
  onApplyCustom: () => void;
  sectors: string[];
  sectorFilter: string;
  setSectorFilter: (v: string) => void;
  isPending: boolean;
}) {
  const {
    data,
    showAll,
    setShowAll,
    thresholdMode,
    setThresholdMode,
    customThreshold,
    setCustomThreshold,
    onApplyCustom,
    sectors,
    sectorFilter,
    setSectorFilter,
    isPending,
  } = props;

  return (
    <div className="border-b border-terminal-border bg-terminal-bg">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-end gap-x-8 gap-y-4 px-6 py-4">
        <Stat label="universe" value={data.universeSize.toString()} />
        <Stat
          label="matched"
          value={data.matchedCount.toString()}
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

        <label className="flex items-center gap-2 border-l border-terminal-border pl-8 text-xs uppercase tracking-wider text-terminal-muted">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="accent-amber-accent"
          />
          show full universe
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

function Row({ row, dim }: { row: ScreenRow; dim: boolean }) {
  const negEquity = row.flags.includes("negative_equity");
  const baseColor = dim ? "text-terminal-muted" : "text-terminal-fg";
  const rowBg = negEquity ? "bg-red-950/30" : "";
  return (
    <tr className={`${rowBg} ${dim ? "opacity-50" : ""}`}>
      <td className={`px-3 py-2 font-data font-semibold ${baseColor}`}>
        {row.ticker}
        {row.matched && (
          <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-amber-accent" />
        )}
      </td>
      <td className={`px-3 py-2 ${baseColor}`}>{row.entityName}</td>
      <td className="px-3 py-2 text-xs text-terminal-muted">{row.sector ?? "—"}</td>
      <td className={`px-3 py-2 text-right font-data ${negEquity ? "text-red-400" : baseColor}`}>
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
      <td className="px-3 py-2 font-data text-[10px] text-terminal-muted">
        {row.flags.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          row.flags.map((f) => (
            <span
              key={f}
              className={`mr-1 inline-block rounded border px-1 py-0.5 ${
                f === "negative_equity"
                  ? "border-red-700 text-red-400"
                  : "border-terminal-border text-terminal-muted"
              }`}
            >
              {f.replace(/_/g, " ")}
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
            Liabilities derived as <span className="font-data">Total Assets − Equity</span> when
            EDGAR&apos;s direct <span className="font-data">Liabilities</span> tag is absent.
          </li>
          <li>Negative equity flagged separately and counted as &quot;high leverage.&quot;</li>
        </ul>
      </div>

      <div>
        <h3 className="font-display text-base text-terminal-fg">Caveats</h3>
        <ul className="mt-2 space-y-1 text-xs">
          <li>Filings can lag quarter-end by 60–90 days.</li>
          <li>
            Annual figures only — TTM revenue not used. Mid-year fiscal-year-end
            companies may show stale data vs. calendar comparables.
          </li>
          <li>
            Revenue tags merged across <span className="font-data">RevenueFromContractWithCustomerExcludingAssessedTax</span>,
            <span className="font-data"> Revenues</span>, and <span className="font-data">SalesRevenueNet</span> for
            ASC-606 transition continuity.
          </li>
          <li>De-listed tickers may have stale or missing recent data.</li>
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
