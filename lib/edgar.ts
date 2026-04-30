import { readCache, writeCache } from "./cache";
import { throttle } from "./rate-limit";
import type { FiscalYearFigure, Fundamentals } from "./types";

const USER_AGENT =
  process.env.SEC_USER_AGENT || "Stock Screener research@example.com";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

// Manual CIK overrides for tickers absent from the active map (de-listed,
// de-registered, or otherwise missing). EDGAR's companyfacts endpoint still
// serves these CIKs.
const CIK_OVERRIDES: Record<string, { cik: string; entityName: string }> = {
  WBA: { cik: "0001618921", entityName: "WALGREENS BOOTS ALLIANCE, INC." },
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

export async function fetchFundamentals(ticker: string): Promise<Fundamentals | null> {
  const upper = ticker.toUpperCase();
  const cacheKey = `fundamentals-${upper}`;
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
  const liabilities = deriveLiabilities(gaap);
  const stockholdersEquity = latestAnnual(gaap, EQUITY_TAGS);

  const fundamentals: Fundamentals = {
    ticker: upper,
    cik: resolved.cik,
    entityName: facts.entityName || resolved.entityName,
    revenue: annualRevenue,
    liabilities,
    stockholdersEquity,
    fetchedAt: new Date().toISOString(),
    source: "edgar",
  };

  await writeCache(cacheKey, fundamentals);
  return fundamentals;
}
