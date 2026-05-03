import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Fundamentals } from "./types";

// Mock the EDGAR fetcher and the disk cache so runScreen runs purely against
// in-memory fixtures.
vi.mock("./edgar", () => ({
  fetchFundamentals: vi.fn(),
  FUNDAMENTALS_CACHE_VERSION: "test",
}));
vi.mock("./cache", () => ({
  readCache: vi.fn(async () => null),
  writeCache: vi.fn(async () => {}),
}));

// Replace the universe with a small, predictable fixture spanning multiple
// sectors so the ineligibility logic is testable.
vi.mock("./universe", async () => {
  const actual = await vi.importActual<typeof import("./universe")>("./universe");
  const TEST_UNIVERSE = [
    { ticker: "INDU", sector: "Industrials" as const },
    { ticker: "TECH", sector: "Technology" as const },
    { ticker: "BANK", sector: "Financials" as const },
    { ticker: "REIT", sector: "Real Estate" as const },
    { ticker: "UTIL", sector: "Utilities" as const },
  ];
  return {
    ...actual,
    SP500_UNIVERSE: TEST_UNIVERSE,
    getSectorMap: () => {
      const m: Record<string, string> = {};
      for (const e of TEST_UNIVERSE) m[e.ticker] = e.sector;
      return m;
    },
  };
});

import { fetchFundamentals } from "./edgar";
import { runScreen, EXCLUDED_SECTORS } from "./run-screen";

function fund(
  ticker: string,
  overrides: Partial<Fundamentals> = {}
): Fundamentals {
  const fig = (fy: number, val: number) => ({
    fy,
    end: `${fy}-12-31`,
    val,
    form: "10-K",
    accn: `accn-${ticker}-${fy}`,
  });
  return {
    ticker,
    cik: "0000000001",
    entityName: `${ticker} Co`,
    revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
    operatingCashFlow: [],
    stockRepurchases: [],
    liabilities: fig(2023, 600),
    stockholdersEquity: fig(2023, 100),
    ttm: null,
    fetchedAt: "2026-04-29T00:00:00Z",
    source: "edgar",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchFundamentals).mockReset();
});

describe("EXCLUDED_SECTORS", () => {
  // The historical exclusion of Financials/REITs/Utilities was removed
  // after a backtest study (2026-05) showed Utilities and REITs were
  // actually valid short setups (hit rates 63% and 67% respectively).
  // The constant remains as zero-length scaffolding so the infrastructure
  // can be re-armed if a future study justifies it.
  it("is empty by default (no a-priori sector exclusion)", () => {
    expect(EXCLUDED_SECTORS).toEqual([]);
  });
});

describe("runScreen across all sectors", () => {
  it("matches eligible sector regardless of sector — no a-priori filter", async () => {
    // Every ticker has identical declining-revenue + high-D/E fundamentals.
    // After removal of the sector exclusion, all five should match.
    vi.mocked(fetchFundamentals).mockImplementation(async (t: string) =>
      fund(t)
    );

    const result = await runScreen({ kind: "fixed", value: 2.0 });
    const byTicker = Object.fromEntries(result.rows.map((r) => [r.ticker, r]));

    for (const t of ["INDU", "TECH", "BANK", "REIT", "UTIL"]) {
      expect(byTicker[t].sectorIneligible).toBe(false);
      expect(byTicker[t].matched).toBe(true);
      expect(byTicker[t].flags).not.toContain("sector_ineligible");
    }
    expect(result.matchedCount).toBe(5);
  });

  it("universe-avg D/E is computed over the full universe", async () => {
    // Mix of D/E values: 4 eligibles at 1.0, 3 ineligibles at 100.0.
    // Full-universe avg = (4*1 + 3*100) / 7 = 304/7 ≈ 43.4.
    vi.mocked(fetchFundamentals).mockImplementation(async (t: string) => {
      const lowDE = !["BANK", "REIT", "UTIL"].includes(t);
      const fy = (val: number) => ({
        fy: 2023,
        end: "2023-12-31",
        val,
        form: "10-K",
        accn: `accn-${t}`,
      });
      return fund(t, {
        liabilities: fy(lowDE ? 100 : 10000),
        stockholdersEquity: fy(100),
      });
    });

    const result = await runScreen({ kind: "average" });
    // (2 * 1.0 + 3 * 100.0) / 5 = 60.4 — only TECH/INDU/BANK/REIT/UTIL
    // are in the test universe (5 tickers, see vi.mock at top of file).
    expect(result.threshold.value).toBeCloseTo(60.4, 1);
  });
});
