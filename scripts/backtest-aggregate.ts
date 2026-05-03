// Full historical backtest of the screen.
//
// For every (ticker × historical fiscal year) in the universe history,
// identify when the screen would have triggered, fetch Yahoo monthly prices
// for the ticker + SPY, and compute forward 6m / 1y / 2y returns vs SPY.
// Output: public/data/backtest.json with per-event records (used as ML
// training data downstream) and aggregate hit-rate stats.
//
// Limitations baked into the data, surfaced in the UI footer:
//   - Survivorship bias: universe is current SP500, not point-in-time SP500.
//     Companies that went BK aren't here.
//   - Yahoo historical prices are split/dividend-adjusted (adjclose),
//     consistent with how a real short return would be computed.
//   - Trigger date is the 10-K *filing* date, not period-end — that's what
//     would have been actionable to a real trader.

import dns from "node:dns";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveCIK } from "../lib/edgar";
import { throttle } from "../lib/rate-limit";
import { readCache, writeCache } from "../lib/cache";
import { SP500_UNIVERSE, getSectorMap, type Sector } from "../lib/universe";

dns.setDefaultResultOrder("ipv4first");

const USER_AGENT =
  process.env.SEC_USER_AGENT || "Stock Screener research@example.com";

const OUT_PATH = path.resolve(process.cwd(), "public/data/backtest.json");

// Sector-exclusion mirror of EXCLUDED_SECTORS in lib/run-screen.ts. Kept
// identical so backtest aggregates reflect the live default behavior.
const EXCLUDED_SECTORS: ReadonlyArray<Sector> = [
  "Financials",
  "Real Estate",
  "Utilities",
];

// ────────────────────────────────────────────────────────────────────────
// EDGAR data: copy of the local helpers from scripts/backtest.ts. Kept
// inline (rather than imported) to keep the legacy script untouched.
// ────────────────────────────────────────────────────────────────────────

type RawEntry = {
  end: string;
  val: number;
  fy: number;
  fp: string;
  form: string;
  accn: string;
  filed?: string;
  start?: string;
};

type CompanyFacts = {
  cik: number;
  entityName: string;
  facts: {
    "us-gaap"?: Record<string, { units: Record<string, RawEntry[]> }>;
  };
};

const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "SalesRevenueGoodsNet",
  "InterestAndDividendIncomeOperating",
  "RevenuesNetOfInterestExpense",
];
const OCF_TAGS = [
  "NetCashProvidedByOperatingActivities",
  "NetCashProvidedByUsedInOperatingActivities",
  "NetCashProvidedByOperatingActivitiesContinuingOperations",
];
const LIABILITIES_TAG = "Liabilities";
const TOTAL_ASSETS_TAGS = ["Assets", "LiabilitiesAndStockholdersEquity"];
const EQUITY_TAGS = [
  "StockholdersEquity",
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
];

function isAnnual(e: RawEntry): boolean {
  if (e.fp !== "FY") return false;
  return e.form === "10-K" || e.form === "10-K/A" || e.form === "20-F";
}

function periodLengthMonths(e: RawEntry): number | null {
  if (!e.start) return null;
  const start = new Date(e.start);
  const end = new Date(e.end);
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

function endYear(e: RawEntry): number {
  return Number(e.end.slice(0, 4));
}

function bestPerEndYear(
  raw: CompanyFacts["facts"]["us-gaap"],
  tags: string[],
  unit = "USD",
  isFlow = false
): Map<number, RawEntry> {
  const out = new Map<number, RawEntry>();
  if (!raw) return out;
  for (const tag of tags) {
    const node = raw[tag];
    if (!node) continue;
    const series = node.units[unit];
    if (!series) continue;
    for (const e of series) {
      if (!isAnnual(e)) continue;
      if (isFlow) {
        const months = periodLengthMonths(e);
        if (months != null && (months < 11 || months > 13)) continue;
      }
      const year = endYear(e);
      const existing = out.get(year);
      if (!existing) {
        out.set(year, e);
        continue;
      }
      const eFiled = e.filed || e.end;
      const exFiled = existing.filed || existing.end;
      if (eFiled > exFiled) out.set(year, e);
    }
  }
  return out;
}

async function fetchCompanyFacts(ticker: string): Promise<CompanyFacts | null> {
  const cacheKey = `companyfacts-raw-${ticker}`;
  const cached = await readCache<CompanyFacts>(cacheKey);
  if (cached) return cached;
  const resolved = await resolveCIK(ticker);
  if (!resolved) return null;
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${resolved.cik}.json`;
  try {
    const res = await throttle(() =>
      fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      })
    );
    if (!res.ok) return null;
    const data = (await res.json()) as CompanyFacts;
    await writeCache(cacheKey, data);
    return data;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// History reduction: per-fiscal-year row with revenue / liabilities / equity.
// Mirrors the existing scripts/backtest.ts logic.
// ────────────────────────────────────────────────────────────────────────

type FyRow = {
  endYear: number;
  end: string;
  filed: string;
  revenue: number | null;
  ocf: number | null;
  liabilities: number | null;
  equity: number | null;
  de: number | null;
  negEquity: boolean;
  decline2y: boolean;
  decline1y: boolean;
};

// For each fiscal-year-end, find the EARLIEST filing date that reported it.
// Critical for backtest accuracy: subsequent filings re-state prior years,
// so the most-recent `filed` is the wrong "trigger date" — that's lookahead.
// We want the date when a trader could first have acted on the data.
function earliestFilingPerYear(
  raw: CompanyFacts["facts"]["us-gaap"]
): Map<number, string> {
  const out = new Map<number, string>();
  if (!raw) return out;
  // Sweep all candidate tags; the earliest 10-K filing for any of them is
  // the original 10-K date (filings include all GAAP tags atomically).
  const tagsToCheck = [...REVENUE_TAGS, ...EQUITY_TAGS, LIABILITIES_TAG];
  for (const tag of tagsToCheck) {
    const node = raw[tag];
    if (!node) continue;
    for (const series of Object.values(node.units)) {
      for (const e of series) {
        if (!isAnnual(e)) continue;
        if (!e.filed) continue;
        const y = endYear(e);
        const existing = out.get(y);
        if (!existing || e.filed < existing) out.set(y, e.filed);
      }
    }
  }
  return out;
}

function buildHistory(facts: CompanyFacts): FyRow[] {
  const gaap = facts.facts["us-gaap"];
  const revs = bestPerEndYear(gaap, REVENUE_TAGS, "USD", true);
  const ocfs = bestPerEndYear(gaap, OCF_TAGS, "USD", true);
  const liabs = bestPerEndYear(gaap, [LIABILITIES_TAG]);
  const assets = bestPerEndYear(gaap, TOTAL_ASSETS_TAGS);
  const equity = bestPerEndYear(gaap, EQUITY_TAGS);
  const earliestFiled = earliestFilingPerYear(gaap);

  const years = new Set<number>([
    ...revs.keys(),
    ...liabs.keys(),
    ...assets.keys(),
    ...equity.keys(),
  ]);
  const sorted = [...years].sort((a, b) => a - b);

  const rows: FyRow[] = [];
  for (const y of sorted) {
    const r = revs.get(y);
    const o = ocfs.get(y);
    const l = liabs.get(y);
    const a = assets.get(y);
    const e = equity.get(y);

    let liabValue: number | null = null;
    if (l) liabValue = l.val;
    else if (a && e) liabValue = a.val - e.val;

    const eqValue = e?.val ?? null;
    const negEquity = eqValue != null && eqValue <= 0;

    let de: number | null = null;
    if (liabValue != null && eqValue != null && eqValue > 0) {
      de = liabValue / eqValue;
    }

    const ref = r ?? l ?? a ?? e;
    if (!ref) continue;

    // Prefer earliest filing date. Fall back: end-of-period + 75 days
    // (mid-range of 60–90 day 10-K filing window).
    const filed = earliestFiled.get(y) ?? (() => {
      const d = new Date(ref.end);
      d.setUTCDate(d.getUTCDate() + 75);
      return d.toISOString().slice(0, 10);
    })();

    rows.push({
      endYear: y,
      end: ref.end,
      filed,
      revenue: r?.val ?? null,
      ocf: o?.val ?? null,
      liabilities: liabValue,
      equity: eqValue,
      de,
      negEquity,
      decline2y: false,
      decline1y: false,
    });
  }

  for (let i = 0; i < rows.length; i++) {
    if (i >= 2) {
      const r2 = rows[i - 2].revenue;
      const r1 = rows[i - 1].revenue;
      const r0 = rows[i].revenue;
      if (
        r2 != null &&
        r1 != null &&
        r0 != null &&
        rows[i - 1].endYear === rows[i].endYear - 1 &&
        rows[i - 2].endYear === rows[i].endYear - 2 &&
        r0 < r1 &&
        r1 < r2
      ) {
        rows[i].decline2y = true;
      }
    }
    if (i >= 1) {
      const r1 = rows[i - 1].revenue;
      const r0 = rows[i].revenue;
      if (
        r1 != null &&
        r0 != null &&
        rows[i - 1].endYear === rows[i].endYear - 1 &&
        r0 < r1
      ) {
        rows[i].decline1y = true;
      }
    }
  }
  return rows;
}

// ────────────────────────────────────────────────────────────────────────
// Yahoo Finance prices, with disk caching.
// ────────────────────────────────────────────────────────────────────────

type Bar = { date: string; close: number };

async function fetchYahooMonthly(
  ticker: string,
  fromIso: string
): Promise<Bar[] | null> {
  const cacheKey = `yahoo-monthly-${ticker}`;
  const cached = await readCache<Bar[]>(cacheKey);
  if (cached) return cached;

  const period1 = Math.floor(new Date(fromIso).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1mo&events=history`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1mo&events=history`,
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
      await writeCache(cacheKey, bars);
      return bars;
    } catch {
      /* try next mirror */
    }
  }
  return null;
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
function addMonths(dateIso: string, months: number): string {
  const d = new Date(dateIso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function returnBetween(
  bars: Bar[],
  fromIso: string,
  toIso: string
): number | null {
  const a = priceAtOrAfter(bars, fromIso);
  if (!a) return null;
  const b = priceClosestBefore(bars, toIso) ?? priceAtOrAfter(bars, toIso);
  if (!b) return null;
  if (a.date > toIso) return null; // we don't have data starting before window end
  return (b.close - a.close) / a.close;
}

// ────────────────────────────────────────────────────────────────────────
// Trigger detection: emulates the live screen's matched logic at every
// historical filing date for every eligible ticker.
// ────────────────────────────────────────────────────────────────────────

type TriggerEvent = {
  ticker: string;
  sector: Sector;
  endYear: number;
  end: string;
  filed: string;
  // Features at trigger time
  de: number | null;
  negEquity: boolean;
  yoy_t: number | null;
  yoy_t1: number | null;
  ocfYoY: number | null;
  ocfDecline2y: boolean;
  contemporaneousAvgDE: number;
  // Forward returns
  ret6m: number | null;
  ret1y: number | null;
  ret2y: number | null;
  spy6m: number | null;
  spy1y: number | null;
  spy2y: number | null;
  alpha6m: number | null;
  alpha1y: number | null;
  alpha2y: number | null;
};

function computeYearlyAvgDE(
  histories: Map<string, FyRow[]>,
  sectorMap: Record<string, Sector>
): Map<number, number> {
  const byYear = new Map<number, number[]>();
  for (const [t, rows] of histories) {
    const sector = sectorMap[t];
    if (sector && EXCLUDED_SECTORS.includes(sector)) continue;
    for (const r of rows) {
      if (r.de == null || !Number.isFinite(r.de) || r.de <= 0) continue;
      const arr = byYear.get(r.endYear) ?? [];
      arr.push(r.de);
      byYear.set(r.endYear, arr);
    }
  }
  const out = new Map<number, number>();
  for (const [y, arr] of byYear.entries()) {
    if (arr.length < 20) continue;
    out.set(y, arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  return out;
}

function findTriggers(
  ticker: string,
  rows: FyRow[],
  sector: Sector,
  yearlyAvg: Map<number, number>
): Omit<TriggerEvent, keyof ReturnType<typeof zeroReturns>>[] {
  const events: Omit<TriggerEvent, keyof ReturnType<typeof zeroReturns>>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.decline2y) continue;
    const threshold = yearlyAvg.get(r.endYear);
    if (threshold == null) continue;
    const lev = r.negEquity || (r.de != null && r.de > threshold);
    if (!lev) continue;

    // Compute features
    const r0 = r.revenue;
    const r1 = rows[i - 1]?.revenue;
    const r2 = rows[i - 2]?.revenue;
    const yoy_t = r1 != null && r0 != null && r1 !== 0 ? (r0 - r1) / r1 : null;
    const yoy_t1 =
      r2 != null && r1 != null && r2 !== 0 ? (r1 - r2) / r2 : null;
    const o0 = r.ocf;
    const o1 = rows[i - 1]?.ocf;
    const o2 = rows[i - 2]?.ocf;
    const ocfYoY = o1 != null && o0 != null && o1 !== 0 ? (o0 - o1) / o1 : null;
    const ocfDecline2y =
      o2 != null && o1 != null && o0 != null && o0 < o1 && o1 < o2;

    events.push({
      ticker,
      sector,
      endYear: r.endYear,
      end: r.end,
      filed: r.filed,
      de: r.de,
      negEquity: r.negEquity,
      yoy_t,
      yoy_t1,
      ocfYoY,
      ocfDecline2y,
      contemporaneousAvgDE: threshold,
    });
  }
  return events;
}

function zeroReturns() {
  return {
    ret6m: null as number | null,
    ret1y: null as number | null,
    ret2y: null as number | null,
    spy6m: null as number | null,
    spy1y: null as number | null,
    spy2y: null as number | null,
    alpha6m: null as number | null,
    alpha1y: null as number | null,
    alpha2y: null as number | null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Aggregation: hit-rate stats from per-event records.
// ────────────────────────────────────────────────────────────────────────

type Stat = {
  count: number;
  meanAlpha1y: number | null;
  medianAlpha1y: number | null;
  hitRate: number | null; // fraction with alpha1y < -0.05
  hitRateBigMiss: number | null; // fraction with alpha1y < -0.20
};

function computeStat(events: TriggerEvent[]): Stat {
  const alphas = events
    .map((e) => e.alpha1y)
    .filter((x): x is number => x != null && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (alphas.length === 0) {
    return {
      count: events.length,
      meanAlpha1y: null,
      medianAlpha1y: null,
      hitRate: null,
      hitRateBigMiss: null,
    };
  }
  const mean = alphas.reduce((a, b) => a + b, 0) / alphas.length;
  const median =
    alphas.length % 2 === 1
      ? alphas[Math.floor(alphas.length / 2)]
      : (alphas[alphas.length / 2 - 1] + alphas[alphas.length / 2]) / 2;
  const hits = alphas.filter((a) => a < -0.05).length;
  const bigMisses = alphas.filter((a) => a < -0.2).length;
  return {
    count: alphas.length,
    meanAlpha1y: mean,
    medianAlpha1y: median,
    hitRate: hits / alphas.length,
    hitRateBigMiss: bigMisses / alphas.length,
  };
}

function deBucket(de: number | null, negEquity: boolean): string {
  if (negEquity) return "neg-eq";
  if (de == null) return "unknown";
  if (de < 2) return "0–2";
  if (de < 5) return "2–5";
  if (de < 10) return "5–10";
  return "10+";
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[backtest-aggregate] loading universe histories…");
  const sectorMap = getSectorMap();
  const histories = new Map<string, FyRow[]>();
  let loaded = 0,
    cached = 0,
    fetched = 0;
  for (const entry of SP500_UNIVERSE) {
    const wasCached =
      (await readCache(`companyfacts-raw-${entry.ticker}`)) !== null;
    const facts = await fetchCompanyFacts(entry.ticker);
    if (!facts) continue;
    if (wasCached) cached++;
    else fetched++;
    histories.set(entry.ticker, buildHistory(facts));
    loaded++;
    if (loaded % 25 === 0) {
      process.stdout.write(
        `  loaded ${loaded}/${SP500_UNIVERSE.length} (${cached}H/${fetched}M)\r`
      );
    }
  }
  console.log(
    `  loaded ${loaded}/${SP500_UNIVERSE.length} (${cached}H/${fetched}M)`
  );

  const yearlyAvg = computeYearlyAvgDE(histories, sectorMap);
  console.log(`  yearly-avg D/E (eligible) computed for ${yearlyAvg.size} years`);

  // Find all triggers across the FULL universe — sector exclusion is now an
  // aggregation-time concern rather than a collection-time one. Threshold is
  // still computed over eligible sectors only (so it matches what the live
  // screen sees), but excluded-sector events are evaluated against the same
  // threshold so we can ask: "if we DID screen banks/REITs/utilities, how
  // would the historical hit rate look?"
  console.log("[backtest-aggregate] finding triggers (all sectors)…");
  const triggers: Omit<TriggerEvent, keyof ReturnType<typeof zeroReturns>>[] =
    [];
  for (const [ticker, rows] of histories) {
    const sector = sectorMap[ticker];
    if (!sector) continue;
    triggers.push(...findTriggers(ticker, rows, sector, yearlyAvg));
  }
  console.log(`  ${triggers.length} historical triggers found across all sectors`);

  // Fetch SPY benchmark prices once (unique per dataset)
  console.log("[backtest-aggregate] fetching SPY benchmark…");
  const spyBars = await fetchYahooMonthly("SPY", "1995-01-01");
  if (!spyBars) {
    console.error("  failed to fetch SPY — aborting");
    process.exit(1);
  }
  console.log(`  SPY: ${spyBars.length} monthly bars`);

  // Fetch ticker prices and compute forward returns
  console.log("[backtest-aggregate] computing forward returns…");
  const events: TriggerEvent[] = [];
  const tickersWithTriggers = [...new Set(triggers.map((t) => t.ticker))];
  let priceLoaded = 0,
    priceFailed = 0;
  const barsByTicker = new Map<string, Bar[]>();
  for (const t of tickersWithTriggers) {
    const bars = await fetchYahooMonthly(t, "1995-01-01");
    if (!bars) {
      priceFailed++;
      continue;
    }
    barsByTicker.set(t, bars);
    priceLoaded++;
    if (priceLoaded % 20 === 0) {
      process.stdout.write(
        `  prices ${priceLoaded}/${tickersWithTriggers.length} (${priceFailed} failed)\r`
      );
    }
  }
  console.log(
    `  prices ${priceLoaded}/${tickersWithTriggers.length} (${priceFailed} failed)`
  );

  for (const trig of triggers) {
    const bars = barsByTicker.get(trig.ticker);
    const ret: ReturnType<typeof zeroReturns> = zeroReturns();
    if (bars) {
      const filed = trig.filed;
      const today = new Date().toISOString().slice(0, 10);
      const horizons: Array<["6m" | "1y" | "2y", string]> = [
        ["6m", addMonths(filed, 6)],
        ["1y", addMonths(filed, 12)],
        ["2y", addMonths(filed, 24)],
      ];
      for (const [k, end] of horizons) {
        if (end > today) continue; // window not yet elapsed
        const r = returnBetween(bars, filed, end);
        const s = returnBetween(spyBars, filed, end);
        if (k === "6m") {
          ret.ret6m = r;
          ret.spy6m = s;
          ret.alpha6m = r != null && s != null ? r - s : null;
        }
        if (k === "1y") {
          ret.ret1y = r;
          ret.spy1y = s;
          ret.alpha1y = r != null && s != null ? r - s : null;
        }
        if (k === "2y") {
          ret.ret2y = r;
          ret.spy2y = s;
          ret.alpha2y = r != null && s != null ? r - s : null;
        }
      }
    }
    events.push({ ...trig, ...ret });
  }

  // Aggregate. We compute two views:
  //   `aggregates`              — eligible sectors only (matches live screen)
  //   `aggregatesIncludingExcluded` — full universe (informs the question
  //                                   "should we be excluding these sectors?")
  console.log("[backtest-aggregate] aggregating…");

  const eligibleEvents = events.filter(
    (e) => !EXCLUDED_SECTORS.includes(e.sector)
  );

  const aggregateView = (subset: TriggerEvent[]) => {
    const overall = computeStat(subset);
    const bySector: Record<string, Stat> = {};
    for (const s of new Set(subset.map((e) => e.sector))) {
      bySector[s] = computeStat(subset.filter((e) => e.sector === s));
    }
    const byYear: Record<string, Stat> = {};
    for (const y of new Set(subset.map((e) => e.endYear))) {
      byYear[y] = computeStat(subset.filter((e) => e.endYear === y));
    }
    const byDeBucket: Record<string, Stat> = {};
    const buckets = new Set(subset.map((e) => deBucket(e.de, e.negEquity)));
    for (const k of buckets) {
      byDeBucket[k] = computeStat(
        subset.filter((e) => deBucket(e.de, e.negEquity) === k)
      );
    }
    return { overall, bySector, byYear, byDeBucket };
  };

  const aggregates = aggregateView(eligibleEvents);
  const aggregatesIncludingExcluded = aggregateView(events);

  const out = {
    generatedAt: new Date().toISOString(),
    universeSize: SP500_UNIVERSE.length,
    historiesLoaded: loaded,
    triggerCount: eligibleEvents.length,
    triggerCountAllSectors: events.length,
    excludedSectors: EXCLUDED_SECTORS,
    aggregates,
    aggregatesIncludingExcluded,
    events,
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out), "utf8");
  console.log(`[backtest-aggregate] wrote ${OUT_PATH}`);
  const o = aggregates.overall;
  const oa = aggregatesIncludingExcluded.overall;
  console.log(
    `  eligible only:  ${o.count} events, mean α₁y ${o.meanAlpha1y != null ? (o.meanAlpha1y * 100).toFixed(1) + "%" : "—"}, hit rate ${o.hitRate != null ? (o.hitRate * 100).toFixed(0) + "%" : "—"}`
  );
  console.log(
    `  all sectors:    ${oa.count} events, mean α₁y ${oa.meanAlpha1y != null ? (oa.meanAlpha1y * 100).toFixed(1) + "%" : "—"}, hit rate ${oa.hitRate != null ? (oa.hitRate * 100).toFixed(0) + "%" : "—"}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
