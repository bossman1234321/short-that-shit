import { fetchFundamentals, FUNDAMENTALS_CACHE_VERSION } from "./edgar";
import { buildRow, universeAverageDE } from "./screen";
import { SP500_UNIVERSE, getSectorMap, type Sector } from "./universe";
import type { ScreenResult, ScreenRow } from "./types";
import { readCache } from "./cache";

export type ThresholdInput =
  | { kind: "average" }
  | { kind: "fixed"; value: number };

export type RunOptions = {
  tickers?: string[];
  includeAllSectors?: boolean;
};

// D/E is structurally meaningless as a distress signal in these sectors:
// banks' liabilities are deposits, REITs are designed to be highly levered,
// utilities are regulated to operate at high leverage. Excluded by default.
export const EXCLUDED_SECTORS: ReadonlyArray<Sector> = [
  "Financials",
  "Real Estate",
  "Utilities",
];

function isIneligible(
  sector: Sector | undefined,
  includeAll: boolean
): boolean {
  if (includeAll) return false;
  if (!sector) return false;
  return EXCLUDED_SECTORS.includes(sector);
}

const CONCURRENCY = 6;

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function runScreen(
  threshold: ThresholdInput,
  options: RunOptions = {}
): Promise<ScreenResult> {
  const { tickers, includeAllSectors = false } = options;

  const universe = tickers
    ? tickers.map((t) => ({ ticker: t.toUpperCase(), sector: undefined as any }))
    : SP500_UNIVERSE;

  const sectorMap = getSectorMap();
  let cacheHits = 0;
  let cacheMisses = 0;

  const fundamentals = await mapWithLimit(universe, CONCURRENCY, async (e) => {
    // Match the cache key used inside fetchFundamentals so the hit/miss
    // metric reflects actual network activity.
    const wasCached =
      (await readCache(
        `fundamentals-${FUNDAMENTALS_CACHE_VERSION}-${e.ticker}`
      )) !== null;
    const f = await fetchFundamentals(e.ticker);
    if (wasCached) cacheHits++;
    else cacheMisses++;
    return { entry: e, fundamentals: f };
  });

  // Single enrichment pass: fundamentals + sector + ineligibility flag.
  // Used twice — first for the placeholder rows that drive the universe
  // average, then for the final rows.
  const enriched = fundamentals
    .filter((x) => x.fundamentals)
    .map((x) => {
      const sector = sectorMap[x.entry.ticker];
      const ineligible = isIneligible(sector, includeAllSectors);
      return { fundamentals: x.fundamentals!, sector, ineligible };
    });

  // Universe-average D/E is computed over *eligible* rows only. Including
  // banks/REITs/utilities pulls the average toward ~6, which is meaningless
  // as a distress threshold for industrial / consumer / tech names.
  const placeholderRows = enriched.map((x) => buildRow(x.fundamentals, 0));
  const eligiblePlaceholders = placeholderRows.filter(
    (_, i) => !enriched[i].ineligible
  );
  const avg = universeAverageDE(eligiblePlaceholders);

  const thresholdValue = threshold.kind === "average" ? avg : threshold.value;

  const rows: ScreenRow[] = enriched.map((x) => {
    const row = buildRow(x.fundamentals, thresholdValue);
    if (x.ineligible) {
      return {
        ...row,
        sector: x.sector,
        sectorIneligible: true,
        matched: false,
        highConvictionMatched: false,
        flags: [...row.flags, "sector_ineligible"],
      };
    }
    return { ...row, sector: x.sector };
  });

  rows.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    const ad = a.debtToEquity ?? -Infinity;
    const bd = b.debtToEquity ?? -Infinity;
    return bd - ad;
  });

  return {
    threshold: {
      kind: threshold.kind,
      value: thresholdValue,
    },
    universeSize: universe.length,
    matchedCount: rows.filter((r) => r.matched).length,
    highConvictionCount: rows.filter((r) => r.highConvictionMatched).length,
    rows,
    generatedAt: new Date().toISOString(),
    cacheHits,
    cacheMisses,
  };
}
