// Multi-method backtest of the matched tickers.
//
//   (a) Per-year contemporaneous universe-average D/E threshold
//   (b) Fixed industry-norm threshold (D/E > 2.0)
//   (c) Forward returns at 6m / 1y / 3y windows from each trigger
//
// Loads full historical companyfacts for every ticker in the universe
// (cached locally), so the first run takes ~40s of EDGAR walks and
// subsequent runs are instant.

import dns from "node:dns";
import { resolveCIK } from "../lib/edgar";
import { throttle } from "../lib/rate-limit";
import { readCache, writeCache } from "../lib/cache";
import { SP500_UNIVERSE } from "../lib/universe";

dns.setDefaultResultOrder("ipv4first");

const USER_AGENT =
  process.env.SEC_USER_AGENT || "Stock Screener research@example.com";

const FIXED_THRESHOLD = 2.0;
const TICKERS = ["PRU", "MMM", "MTB", "HPQ", "MO"];

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

// Key entries by their period-end year. EDGAR's `fy` field is filing-year, not
// period-year — keying by end-year keeps comparable filings together. For
// instant balance-sheet items there's no `start`, so we trust the end date.
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
      // Flow items (revenue) must be ~12 months long; instant items (equity,
      // assets) don't have start, so we accept them.
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
  const resolved = await resolveCIK(ticker);
  if (!resolved) return null;
  const cacheKey = `companyfacts-raw-${ticker}`;
  const cached = await readCache<CompanyFacts>(cacheKey);
  if (cached) return cached;
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

type FyRow = {
  endYear: number;
  end: string;
  filed: string;
  revenue: number | null;
  liabilities: number | null;
  equity: number | null;
  de: number | null;
  negEquity: boolean;
  decline: boolean;
};

function buildHistory(facts: CompanyFacts): FyRow[] {
  const gaap = facts.facts["us-gaap"];
  const revs = bestPerEndYear(gaap, REVENUE_TAGS, "USD", true);
  const liabs = bestPerEndYear(gaap, [LIABILITIES_TAG]);
  const assets = bestPerEndYear(gaap, TOTAL_ASSETS_TAGS);
  const equity = bestPerEndYear(gaap, EQUITY_TAGS);

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

    rows.push({
      endYear: y,
      end: ref.end,
      filed: ref.filed || ref.end,
      revenue: r?.val ?? null,
      liabilities: liabValue,
      equity: eqValue,
      de,
      negEquity,
      decline: false,
    });
  }

  for (let i = 2; i < rows.length; i++) {
    const r2 = rows[i - 2].revenue;
    const r1 = rows[i - 1].revenue;
    const r0 = rows[i].revenue;
    if (
      r2 != null &&
      r1 != null &&
      r0 != null &&
      // require strict 1-year cadence
      rows[i - 1].endYear === rows[i].endYear - 1 &&
      rows[i - 2].endYear === rows[i].endYear - 2 &&
      r0 < r1 &&
      r1 < r2
    ) {
      rows[i].decline = true;
    }
  }
  return rows;
}

async function loadUniverseHistories(): Promise<Map<string, FyRow[]>> {
  const out = new Map<string, FyRow[]>();
  let i = 0;
  let cached = 0;
  let fetched = 0;
  for (const entry of SP500_UNIVERSE) {
    const cacheKey = `companyfacts-raw-${entry.ticker}`;
    const wasCached = (await readCache(cacheKey)) !== null;
    const facts = await fetchCompanyFacts(entry.ticker);
    i++;
    if (!facts) continue;
    if (wasCached) cached++;
    else fetched++;
    out.set(entry.ticker, buildHistory(facts));
    if (i % 25 === 0) {
      process.stdout.write(
        `  loaded ${i}/${SP500_UNIVERSE.length} (${cached}H/${fetched}M)\r`
      );
    }
  }
  console.log(
    `  loaded ${i}/${SP500_UNIVERSE.length} (${cached}H/${fetched}M)         `
  );
  return out;
}

function computeYearlyAvgDE(
  histories: Map<string, FyRow[]>
): Map<number, number> {
  const byYear = new Map<number, number[]>();
  for (const rows of histories.values()) {
    for (const r of rows) {
      if (r.de == null || !Number.isFinite(r.de) || r.de <= 0) continue;
      const arr = byYear.get(r.endYear) ?? [];
      arr.push(r.de);
      byYear.set(r.endYear, arr);
    }
  }
  const out = new Map<number, number>();
  for (const [y, arr] of byYear.entries()) {
    if (arr.length < 20) continue; // require enough breadth for the average to be meaningful
    out.set(y, arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  return out;
}

type Bar = { ts: number; date: string; close: number };

async function fetchYahooPrices(
  ticker: string,
  fromIso: string
): Promise<Bar[]> {
  const period1 = Math.floor(new Date(fromIso).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1mo&events=history`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1mo&events=history`,
  ];
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36",
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        lastErr = new Error(`Yahoo ${res.status}`);
        continue;
      }
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
          ts: ts[i],
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          close: c,
        });
      }
      return bars;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Yahoo unreachable");
}

function priceAtOrAfter(bars: Bar[], dateIso: string): Bar | null {
  for (const b of bars) {
    if (b.date >= dateIso) return b;
  }
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

type TriggerKind = "fixed" | "current-avg" | "contemporaneous-avg";

function findFirstTrigger(
  rows: FyRow[],
  kind: TriggerKind,
  fixedValue: number,
  currentAvg: number,
  contemporaneousAvg: Map<number, number>
): FyRow | null {
  for (const r of rows) {
    if (!r.decline) continue;
    let threshold: number;
    if (kind === "fixed") threshold = fixedValue;
    else if (kind === "current-avg") threshold = currentAvg;
    else {
      const t = contemporaneousAvg.get(r.endYear);
      if (t == null) continue;
      threshold = t;
    }
    const lev = r.negEquity || (r.de != null && r.de > threshold);
    if (lev) return r;
  }
  return null;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = n * 100;
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

type ForwardReturns = {
  trigger: { date: string; price: number } | null;
  windows: { label: string; date: string; price: number | null; ret: number | null; elapsed: boolean }[];
  today: { date: string; price: number; ret: number };
  maxDD: number;
};

async function computeForwardReturns(
  ticker: string,
  filed: string
): Promise<ForwardReturns | null> {
  let bars: Bar[];
  try {
    bars = await fetchYahooPrices(ticker, filed);
  } catch {
    return null;
  }
  if (bars.length === 0) return null;

  const trigger = priceAtOrAfter(bars, filed);
  if (!trigger) return null;

  const today = bars[bars.length - 1];

  const windows = [
    { label: "+6m", target: addMonths(filed, 6) },
    { label: "+1y", target: addMonths(filed, 12) },
    { label: "+3y", target: addMonths(filed, 36) },
  ].map((w) => {
    const elapsed = today.date >= w.target;
    if (!elapsed) return { label: w.label, date: w.target, price: null, ret: null, elapsed: false };
    const bar = priceClosestBefore(bars, w.target) ?? priceAtOrAfter(bars, w.target);
    if (!bar) return { label: w.label, date: w.target, price: null, ret: null, elapsed: true };
    return {
      label: w.label,
      date: bar.date,
      price: bar.close,
      ret: (bar.close - trigger.close) / trigger.close,
      elapsed: true,
    };
  });

  let peak = trigger.close;
  let maxDD = 0;
  for (const b of bars) {
    if (b.close > peak) peak = b.close;
    const dd = (b.close - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  return {
    trigger: { date: trigger.date, price: trigger.close },
    windows,
    today: {
      date: today.date,
      price: today.close,
      ret: (today.close - trigger.close) / trigger.close,
    },
    maxDD,
  };
}

async function main() {
  console.log("Loading universe histories for contemporaneous-avg threshold...");
  const universe = await loadUniverseHistories();
  const yearlyAvg = computeYearlyAvgDE(universe);
  const sortedYears = [...yearlyAvg.keys()].sort();

  console.log("\nUniverse-average D/E by fiscal-year-end:");
  for (const y of sortedYears) {
    console.log(`  ${y}: ${yearlyAvg.get(y)!.toFixed(2)}`);
  }
  const currentAvg = yearlyAvg.get(sortedYears[sortedYears.length - 1])!;
  console.log(
    `\nFixed threshold: ${FIXED_THRESHOLD.toFixed(2)} (industry norm)`
  );
  console.log(
    `"Current average" threshold: ${currentAvg.toFixed(2)} (most recent fiscal year)\n`
  );

  for (const t of TICKERS) {
    const rows = universe.get(t);
    if (!rows) {
      console.log(`\n=== ${t} === (not in universe history)`);
      continue;
    }
    console.log(`\n=== ${t} ===`);

    const methods: { name: string; kind: TriggerKind }[] = [
      { name: "fixed (D/E > 2.0)", kind: "fixed" },
      { name: "current-avg (D/E > 5.98)", kind: "current-avg" },
      { name: "contemporaneous-avg (year-by-year)", kind: "contemporaneous-avg" },
    ];

    for (const m of methods) {
      const trig = findFirstTrigger(rows, m.kind, FIXED_THRESHOLD, currentAvg, yearlyAvg);
      if (!trig) {
        console.log(`  [${m.name}] never triggered`);
        continue;
      }
      const thresholdAtYear =
        m.kind === "contemporaneous-avg"
          ? yearlyAvg.get(trig.endYear)
          : m.kind === "fixed"
            ? FIXED_THRESHOLD
            : currentAvg;
      console.log(
        `  [${m.name}] first trigger: FY${trig.endYear} (filed ${trig.filed}) — ` +
          `D/E ${trig.negEquity ? "neg-eq" : trig.de?.toFixed(2)}, threshold ${thresholdAtYear?.toFixed(2)}`
      );
      const fr = await computeForwardReturns(t, trig.filed);
      if (!fr || !fr.trigger) {
        console.log(`     no price data`);
        continue;
      }
      console.log(
        `     ${fmtPrice(fr.trigger.price)} at trigger (${fr.trigger.date})`
      );
      for (const w of fr.windows) {
        if (!w.elapsed) {
          console.log(`     ${w.label}: not yet elapsed (target ${w.date})`);
        } else {
          console.log(
            `     ${w.label} (${w.date}): ${fmtPrice(w.price)} ${fmtPct(w.ret)}`
          );
        }
      }
      console.log(
        `     today (${fr.today.date}): ${fmtPrice(fr.today.price)} ${fmtPct(fr.today.ret)} | max DD ${fmtPct(fr.maxDD)}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
