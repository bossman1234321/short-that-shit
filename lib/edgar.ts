import dns from "node:dns";
import { readCache, writeCache } from "./cache";
import { throttle } from "./rate-limit";
import type { FiscalYearFigure, Fundamentals, TtmInfo } from "./types";

// Some serverless environments resolve data.sec.gov to an IPv6 address that
// silently hangs. Forcing IPv4 first avoids 30s TCP timeouts during builds.
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* no-op on environments that don't support it */
}

const USER_AGENT =
  process.env.SEC_USER_AGENT || "Stock Screener research@example.com";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

// Manual CIK overrides for tickers absent from the active map (de-listed,
// de-registered, or otherwise missing). EDGAR's companyfacts endpoint still
// serves these CIKs.
import { delistedCikOverrides } from "./delisted-universe";

const CIK_OVERRIDES: Record<string, { cik: string; entityName: string }> = {
  WBA: { cik: "0001618921", entityName: "WALGREENS BOOTS ALLIANCE, INC." },
  ...delistedCikOverrides(),
};

type TickerMap = Record<string, { cik: string; ticker: string; title: string }>;

let tickerMapCache: TickerMap | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await throttle(() =>
    fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    })
  );
  if (!res.ok) {
    throw new Error(`EDGAR ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
}

export async function loadTickerMap(): Promise<TickerMap> {
  if (tickerMapCache) return tickerMapCache;
  const cached = await readCache<TickerMap>("ticker-map");
  if (cached) {
    tickerMapCache = cached;
    return cached;
  }
  const raw = await fetchJson<
    Record<string, { cik_str: number; ticker: string; title: string }>
  >(TICKERS_URL);
  const map: TickerMap = {};
  for (const v of Object.values(raw)) {
    const cik = String(v.cik_str).padStart(10, "0");
    map[v.ticker.toUpperCase()] = { cik, ticker: v.ticker, title: v.title };
  }
  await writeCache("ticker-map", map);
  tickerMapCache = map;
  return map;
}

export async function resolveCIK(ticker: string): Promise<{
  cik: string;
  entityName: string;
} | null> {
  const upper = ticker.toUpperCase();
  const override = CIK_OVERRIDES[upper];
  if (override) return override;
  const map = await loadTickerMap();
  const hit = map[upper];
  if (!hit) return null;
  return { cik: hit.cik, entityName: hit.title };
}

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
];

const OCF_TAGS = [
  "NetCashProvidedByOperatingActivities",
  "NetCashProvidedByUsedInOperatingActivities",
  "NetCashProvidedByOperatingActivitiesContinuingOperations",
];

const REPURCHASE_TAGS = [
  "PaymentsForRepurchaseOfCommonStock",
  "PaymentsForRepurchaseOfEquity",
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

// Flow items (revenue, OCF, buybacks) report a [start, end] period. A 10-K
// can also contain stub/transition periods that aren't a full fiscal year —
// require ~12 months between start and end to filter those out.
function isFullAnnualPeriod(e: RawEntry): boolean {
  if (!e.start) return true; // balance-sheet items have no start, accept
  const start = new Date(e.start).getTime();
  const end = new Date(e.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const months = (end - start) / (1000 * 60 * 60 * 24 * 30.4375);
  return months >= 11 && months <= 13;
}

// Merge across multiple candidate tags. For each FY, prefer the most recent
// filed entry across all tags (handles companies that switched tags mid-history).
function mergeAnnualSeries(
  raw: CompanyFacts["facts"]["us-gaap"],
  tags: string[],
  unit = "USD"
): FiscalYearFigure[] {
  if (!raw) return [];
  const byFy = new Map<number, RawEntry>();
  for (const tag of tags) {
    const node = raw[tag];
    if (!node) continue;
    const series = node.units[unit];
    if (!series) continue;
    for (const e of series) {
      if (!isAnnual(e)) continue;
      if (!isFullAnnualPeriod(e)) continue;
      const existing = byFy.get(e.fy);
      if (!existing) {
        byFy.set(e.fy, e);
        continue;
      }
      const eFiled = e.filed || e.end;
      const exFiled = existing.filed || existing.end;
      if (eFiled > exFiled) byFy.set(e.fy, e);
    }
  }
  return [...byFy.values()]
    .sort((a, b) => (a.end < b.end ? 1 : -1))
    .map((e) => ({
      fy: e.fy,
      end: e.end,
      val: e.val,
      form: e.form,
      accn: e.accn,
    }));
}

function latestAnnual(
  raw: CompanyFacts["facts"]["us-gaap"],
  tags: string[],
  unit = "USD"
): FiscalYearFigure | null {
  const merged = mergeAnnualSeries(raw, tags, unit);
  return merged[0] ?? null;
}

// Bucket a period length (in months) into the standard XBRL reporting
// shapes: 3-month quarter, 6/9-month YTD, or 12-month TTM/annual. Returns
// null for non-standard periods (transition stubs, etc.).
function periodBucket(months: number): 3 | 6 | 9 | 12 | null {
  if (Math.abs(months - 3) < 0.6) return 3;
  if (Math.abs(months - 6) < 0.6) return 6;
  if (Math.abs(months - 9) < 0.6) return 9;
  if (Math.abs(months - 12) < 0.6) return 12;
  return null;
}

function periodMonths(e: RawEntry): number | null {
  if (!e.start) return null;
  const start = new Date(e.start).getTime();
  const end = new Date(e.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return (end - start) / (1000 * 60 * 60 * 24 * 30.4375);
}

// Extract trailing-twelve-months info from a 10-Q. Pairs the most recent
// year-to-date period with its prior-year same-length comparable (which the
// 10-Q itself reports for comparison), then computes:
//   TTM = lastAnnual + currentYtd - priorYearYtd  (when YTD < 12mo)
//   TTM = currentYtd                              (when YTD == 12mo)
// `partialYoy` is the YoY rate over the YTD period itself, which is the
// most current revenue-trend signal we have.
//
// Returns null when:
//   - no usable YTD data exists,
//   - the most recent YTD has no prior-year comparable, or
//   - the YTD's end date isn't strictly after the latest annual.
function extractTtmRevenue(
  raw: CompanyFacts["facts"]["us-gaap"],
  tags: string[],
  lastAnnual: FiscalYearFigure | null
): TtmInfo | null {
  if (!raw || !lastAnnual) return null;

  // Collect all entries across the candidate revenue tags. Tag the period
  // length and dedupe by (start, end) keeping the most recently filed copy
  // — companies frequently re-state prior periods in later filings.
  type Tagged = RawEntry & { months: number; bucket: 3 | 6 | 9 | 12 };
  const seen = new Map<string, Tagged>();
  for (const tag of tags) {
    const node = raw[tag];
    if (!node) continue;
    const series = node.units["USD"];
    if (!series) continue;
    for (const e of series) {
      const months = periodMonths(e);
      if (months == null) continue;
      const bucket = periodBucket(months);
      if (!bucket) continue;
      const key = `${e.start}|${e.end}`;
      const existing = seen.get(key);
      const eFiled = e.filed || e.end;
      if (existing && (existing.filed || existing.end) >= eFiled) continue;
      seen.set(key, { ...e, months, bucket });
    }
  }
  const tagged = [...seen.values()];
  if (tagged.length === 0) return null;

  // YTD candidates: 3/6/9/12-mo periods that are NOT the FY annual itself
  // and that end strictly after the most recent annual end. The exclusion
  // of `fp == "FY"` guards against picking up the latest 10-K.
  const newYtds = tagged.filter(
    (e) => e.fp !== "FY" && e.form !== "10-K" && e.end > lastAnnual.end
  );
  if (newYtds.length === 0) return null;

  // Prefer the longest YTD (=most precise TTM): try 12 → 9 → 6 → 3.
  const buckets: Array<3 | 6 | 9 | 12> = [12, 9, 6, 3];
  for (const b of buckets) {
    const inBucket = newYtds
      .filter((e) => e.bucket === b)
      .sort((a, z) => (a.end < z.end ? 1 : -1));
    if (inBucket.length === 0) continue;

    const current = inBucket[0];

    // Find the prior-year same-length entry. The 10-Q's comparative section
    // re-reports the prior-year YTD, so it lives in `tagged` somewhere with
    // end ~= current.end - 1 year. Allow ±7 days for fiscal-calendar drift.
    const targetMs = new Date(current.end).getTime() - 365 * 24 * 60 * 60 * 1000;
    const tolMs = 7 * 24 * 60 * 60 * 1000;
    const priorCandidates = tagged
      .filter(
        (e) =>
          e.bucket === b &&
          e.end !== current.end &&
          Math.abs(new Date(e.end).getTime() - targetMs) <= tolMs
      )
      .sort((a, z) => ((a.filed || a.end) < (z.filed || z.end) ? 1 : -1));
    const priorYear = priorCandidates[0];
    if (!priorYear) continue;

    const ttm =
      b === 12 ? current.val : lastAnnual.val + current.val - priorYear.val;
    const partialYoy =
      priorYear.val !== 0 ? current.val / priorYear.val - 1 : 0;

    return {
      current: {
        start: current.start!,
        end: current.end,
        monthsYtd: b,
        val: current.val,
      },
      priorYear: {
        start: priorYear.start!,
        end: priorYear.end,
        monthsYtd: b,
        val: priorYear.val,
      },
      ttm,
      partialYoy,
    };
  }
  return null;
}

function deriveLiabilities(
  raw: CompanyFacts["facts"]["us-gaap"]
): FiscalYearFigure | null {
  // Direct Liabilities tag
  const direct = latestAnnual(raw, [LIABILITIES_TAG]);
  if (direct) return direct;

  // Derive from Total Assets - StockholdersEquity. We need both for the same FY.
  if (!raw) return null;
  const assets = mergeAnnualSeries(raw, TOTAL_ASSETS_TAGS);
  const equity = mergeAnnualSeries(raw, EQUITY_TAGS);
  if (assets.length === 0 || equity.length === 0) return null;

  // Match by fiscal year, take most recent shared FY
  const eqByFy = new Map(equity.map((e) => [e.fy, e]));
  for (const a of assets) {
    const e = eqByFy.get(a.fy);
    if (!e) continue;
    return {
      fy: a.fy,
      end: a.end,
      val: a.val - e.val,
      form: a.form,
      accn: a.accn,
    };
  }
  return null;
}

// Bump this version when the Fundamentals shape changes; old cache entries
// are then skipped automatically. (run-screen.ts reads this constant for
// cache-hit accounting.)
export const FUNDAMENTALS_CACHE_VERSION = "v3";

export async function fetchFundamentals(ticker: string): Promise<Fundamentals | null> {
  const upper = ticker.toUpperCase();
  const cacheKey = `fundamentals-${FUNDAMENTALS_CACHE_VERSION}-${upper}`;
  const cached = await readCache<Fundamentals>(cacheKey);
  if (cached) return cached;

  const resolved = await resolveCIK(upper);
  if (!resolved) return null;

  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${resolved.cik}.json`;
  let facts: CompanyFacts;
  try {
    facts = await fetchJson<CompanyFacts>(url);
  } catch (err) {
    if (err instanceof Error && /404/.test(err.message)) return null;
    throw err;
  }

  const gaap = facts.facts["us-gaap"];
  const annualRevenue = mergeAnnualSeries(gaap, REVENUE_TAGS).slice(0, 5);
  const operatingCashFlow = mergeAnnualSeries(gaap, OCF_TAGS).slice(0, 5);
  const stockRepurchases = mergeAnnualSeries(gaap, REPURCHASE_TAGS).slice(0, 5);
  const liabilities = deriveLiabilities(gaap);
  const stockholdersEquity = latestAnnual(gaap, EQUITY_TAGS);
  const ttm = extractTtmRevenue(gaap, REVENUE_TAGS, annualRevenue[0] ?? null);

  const fundamentals: Fundamentals = {
    ticker: upper,
    cik: resolved.cik,
    entityName: facts.entityName || resolved.entityName,
    revenue: annualRevenue,
    operatingCashFlow,
    stockRepurchases,
    liabilities,
    stockholdersEquity,
    ttm,
    fetchedAt: new Date().toISOString(),
    source: "edgar",
  };

  await writeCache(cacheKey, fundamentals);
  return fundamentals;
}
