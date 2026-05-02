import { fetchFundamentals, FUNDAMENTALS_CACHE_VERSION } from "./edgar";
import { buildRow, universeAverageDE } from "./screen";
import { SP500_UNIVERSE, getSectorMap, type Sector } from "./universe";
import type {
  BacktestSummary,
  MlMetadata,
  ScreenResult,
  ScreenRow,
} from "./types";
import { readCache } from "./cache";
import type { ModelWeights } from "./ml-score";
import { promises as fs } from "node:fs";
import path from "node:path";

export type ThresholdInput =
  | { kind: "average" }
  | { kind: "fixed"; value: number };

export type RunOptions = {
  tickers?: string[];
  includeAllSectors?: boolean;
  declineYears?: 1 | 2 | 3;
};

// Load the persisted ML model (offline-trained by scripts/train-model.ts).
// Returns null if the file is missing — the screen falls back gracefully
// (rows get mlShortScore=null and the UI hides the column).
async function loadMlModel(): Promise<ModelWeights | null> {
  try {
    const file = path.resolve(process.cwd(), "public/data/ml-model.json");
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as ModelWeights;
  } catch {
    return null;
  }
}

// Pull the small UI-visible subset of backtest stats. Per-event records
// stay in the file but aren't shipped on every screen response.
async function loadBacktestSummary(): Promise<BacktestSummary | null> {
  try {
    const file = path.resolve(process.cwd(), "public/data/backtest.json");
    const raw = await fs.readFile(file, "utf8");
    const data = JSON.parse(raw) as any;
    const overall = data?.aggregates?.overall;
    if (!overall) return null;
    const bySector: BacktestSummary["bySector"] = {};
    for (const [k, v] of Object.entries(
      data.aggregates.bySector as Record<string, any>
    )) {
      bySector[k] = {
        count: v.count,
        meanAlpha1y: v.meanAlpha1y,
        hitRate: v.hitRate,
      };
    }
    return {
      generatedAt: data.generatedAt,
      triggerCount: data.triggerCount,
      withForwardReturns: overall.count,
      meanAlpha1y: overall.meanAlpha1y,
      medianAlpha1y: overall.medianAlpha1y,
      hitRate: overall.hitRate,
      hitRateBigMiss: overall.hitRateBigMiss,
      bySector,
    };
  } catch {
    return null;
  }
}

function modelToMetadata(m: ModelWeights | null): MlMetadata | null {
  if (!m) return null;
  const ranked = m.features
    .slice(0, -1)
    .map((name, i) => ({ name, coef: m.coefs[i] }))
    .sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef))
    .slice(0, 8);
  return {
    trainSize: m.trainSize,
    testSize: m.testSize,
    trainAuc: m.trainAuc,
    testAuc: m.testAuc,
    trainSplitYearLt: m.trainSplitYearLt,
    trainedAt: m.trainedAt,
    positiveLabelDef: m.positiveLabelDef,
    topFeatures: ranked,
  };
}

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
  const { tickers, includeAllSectors = false, declineYears = 2 } = options;
  const mlModel = await loadMlModel();
  const backtest = await loadBacktestSummary();

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
  const placeholderRows = enriched.map((x) =>
    buildRow(x.fundamentals, 0, { declineYears })
  );
  const eligiblePlaceholders = placeholderRows.filter(
    (_, i) => !enriched[i].ineligible
  );
  const avg = universeAverageDE(eligiblePlaceholders);

  const thresholdValue = threshold.kind === "average" ? avg : threshold.value;

  const rows: ScreenRow[] = enriched.map((x) => {
    const row = buildRow(x.fundamentals, thresholdValue, {
      declineYears,
      sector: x.sector,
      model: mlModel,
    });
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
    declineYears,
    universeSize: universe.length,
    matchedCount: rows.filter((r) => r.matched).length,
    highConvictionCount: rows.filter((r) => r.highConvictionMatched).length,
    rows,
    generatedAt: new Date().toISOString(),
    cacheHits,
    cacheMisses,
    backtest,
    mlModel: modelToMetadata(mlModel),
  };
}
