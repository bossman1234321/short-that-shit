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
  it("excludes Financials, Real Estate, Utilities", () => {
    expect(EXCLUDED_SECTORS).toContain("Financials");
    expect(EXCLUDED_SECTORS).toContain("Real Estate");
    expect(EXCLUDED_SECTORS).toContain("Utilities");
  });

  it("does not exclude Energy (D/E is a real distress signal there)", () => {
    expect(EXCLUDED_SECTORS).not.toContain("Energy");
  });

  it("does not exclude Industrials, Tech, Health Care, Consumer", () => {
    expect(EXCLUDED_SECTORS).not.toContain("Industrials");
    expect(EXCLUDED_SECTORS).not.toContain("Technology");
    expect(EXCLUDED_SECTORS).not.toContain("Health Care");
    expect(EXCLUDED_SECTORS).not.toContain("Consumer Discretionary");
  });
});

describe("runScreen sector ineligibility", () => {
  it("marks Financials/REITs/Utilities as ineligible and suppresses match", async () => {
    // Every ticker has the same fundamentals: declining revenue + high D/E
    // (6.0). Eligible sectors should match; ineligible should not.
    vi.mocked(fetchFundamentals).mockImplementation(async (t: string) =>
      fund(t)
    );

    const result = await runScreen({ kind: "fixed", value: 2.0 });

    const byTicker = Object.fromEntries(result.rows.map((r) => [r.ticker, r]));

    // Eligible: Industrials and Tech — both match
    expect(byTicker.INDU.sectorIneligible).toBe(false);
    expect(byTicker.INDU.matched).toBe(true);
    expect(byTicker.INDU.flags).not.toContain("sector_ineligible");

    expect(byTicker.TECH.sectorIneligible).toBe(false);
    expect(byTicker.TECH.matched).toBe(true);

    // Ineligible: Financials, Real Estate, Utilities — flagged, not matched
    for (const t of ["BANK", "REIT", "UTIL"]) {
      expect(byTicker[t].sectorIneligible).toBe(true);
      expect(byTicker[t].matched).toBe(false);
      expect(byTicker[t].highConvictionMatched).toBe(false);
      expect(byTicker[t].flags).toContain("sector_ineligible");
    }

    expect(result.matchedCount).toBe(2); // INDU + TECH only
  });

  it("includeAllSectors=true reverts suppression", async () => {
    vi.mocked(fetchFundamentals).mockImplementation(async (t: string) =>
      fund(t)
    );

    const result = await runScreen(
      { kind: "fixed", value: 2.0 },
      { includeAllSectors: true }
    );

    const byTicker = Object.fromEntries(result.rows.map((r) => [r.ticker, r]));

    // Now financials/REITs/utilities are NOT ineligible and DO match
    for (const t of ["INDU", "TECH", "BANK", "REIT", "UTIL"]) {
      expect(byTicker[t].sectorIneligible).toBe(false);
      expect(byTicker[t].matched).toBe(true);
      expect(byTicker[t].flags).not.toContain("sector_ineligible");
    }
    expect(result.matchedCount).toBe(5);
  });

  it("universe-avg threshold is computed over eligible rows only", async () => {
    // Eligibles have D/E = 1.0; ineligibles have D/E = 100.0. If the average
    // were computed over the full universe, it would be ~40. Over eligibles
    // only, it's exactly 1.0.
    vi.mocked(fetchFundamentals).mockImplementation(async (t: string) => {
      const eligible = !["BANK", "REIT", "UTIL"].includes(t);
      const fy = (val: number) => ({
        fy: 2023,
        end: "2023-12-31",
        val,
        form: "10-K",
        accn: `accn-${t}`,
      });
      return fund(t, {
        liabilities: fy(eligible ? 100 : 10000),
        stockholdersEquity: fy(100),
      });
    });

    const result = await runScreen({ kind: "average" });
    expect(result.threshold.value).toBeCloseTo(1.0, 2);
  });
});
