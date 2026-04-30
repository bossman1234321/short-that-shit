import { fetchFundamentals } from "./edgar";
import { buildRow, universeAverageDE } from "./screen";
import { SP500_UNIVERSE, getSectorMap } from "./universe";
import type { ScreenResult, ScreenRow } from "./types";
import { readCache } from "./cache";

export type ThresholdInput =
  | { kind: "average" }
  | { kind: "fixed"; value: number };

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
  tickers?: string[]
): Promise<ScreenResult> {
  const universe = tickers
    ? tickers.map((t) => ({ ticker: t.toUpperCase(), sector: undefined as any }))
    : SP500_UNIVERSE;

  const sectorMap = getSectorMap();
  let cacheHits = 0;
  let cacheMisses = 0;

  const fundamentals = await mapWithLimit(universe, CONCURRENCY, async (e) => {
    const wasCached = (await readCache(`fundamentals-${e.ticker}`)) !== null;
    const f = await fetchFundamentals(e.ticker);
    if (wasCached) cacheHits++;
    else cacheMisses++;
    return { entry: e, fundamentals: f };
  });

  // First pass: compute D/E with placeholder threshold to get the average.
  const placeholderRows = fundamentals
    .filter((x) => x.fundamentals)
    .map((x) => buildRow(x.fundamentals!, 0));
  const avg = universeAverageDE(placeholderRows);

  const thresholdValue = threshold.kind === "average" ? avg : threshold.value;

  const rows: ScreenRow[] = fundamentals
    .filter((x) => x.fundamentals)
    .map((x) => {
      const row = buildRow(x.fundamentals!, thresholdValue);
      const sector = sectorMap[x.entry.ticker];
      return { ...row, sector };
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
    rows,
    generatedAt: new Date().toISOString(),
    cacheHits,
    cacheMisses,
  };
}
