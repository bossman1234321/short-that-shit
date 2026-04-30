import { describe, it, expect } from "vitest";
import {
  debtToEquity,
  isMonotonicRevenueDecline,
  yoy,
  buildRow,
  universeAverageDE,
} from "./screen";
import type { Fundamentals } from "./types";

function fund(overrides: Partial<Fundamentals> = {}): Fundamentals {
  return {
    ticker: "TEST",
    cik: "0000000001",
    entityName: "Test Co",
    revenue: [],
    liabilities: null,
    stockholdersEquity: null,
    fetchedAt: "2026-04-29T00:00:00Z",
    source: "edgar",
    ...overrides,
  };
}

function rev(fy: number, val: number) {
  return {
    fy,
    end: `${fy}-12-31`,
    val,
    form: "10-K",
    accn: `accn-${fy}`,
  };
}

describe("debtToEquity", () => {
  it("computes ratio when both inputs are positive", () => {
    expect(debtToEquity(100, 50)).toBe(2);
  });

  it("returns null on zero equity", () => {
    expect(debtToEquity(100, 0)).toBeNull();
  });

  it("returns null on negative equity (handled separately as a flag)", () => {
    expect(debtToEquity(100, -25)).toBeNull();
  });

  it("returns null when either side is missing", () => {
    expect(debtToEquity(null, 50)).toBeNull();
    expect(debtToEquity(100, null)).toBeNull();
    expect(debtToEquity(null, null)).toBeNull();
  });
});

describe("isMonotonicRevenueDecline", () => {
  it("matches strict descending: 100 > 90 > 80", () => {
    expect(isMonotonicRevenueDecline(100, 90, 80)).toBe(true);
  });

  it("rejects equal values: 100 = 100 > 90", () => {
    expect(isMonotonicRevenueDecline(100, 100, 90)).toBe(false);
  });

  it("rejects single-year decline: 90 > 100 > 95", () => {
    expect(isMonotonicRevenueDecline(90, 100, 95)).toBe(false);
  });

  it("rejects rising revenue: 80 < 90 < 100", () => {
    expect(isMonotonicRevenueDecline(80, 90, 100)).toBe(false);
  });

  it("rejects when any year is null", () => {
    expect(isMonotonicRevenueDecline(null, 90, 80)).toBe(false);
    expect(isMonotonicRevenueDecline(100, null, 80)).toBe(false);
    expect(isMonotonicRevenueDecline(100, 90, null)).toBe(false);
  });
});

describe("yoy", () => {
  it("computes positive growth", () => {
    expect(yoy(100, 110)).toBeCloseTo(0.1);
  });

  it("computes negative growth", () => {
    expect(yoy(100, 80)).toBeCloseTo(-0.2);
  });

  it("returns null on zero prior", () => {
    expect(yoy(0, 100)).toBeNull();
  });
});

describe("buildRow", () => {
  it("matches when both decline and leverage are met", () => {
    const f = fund({
      revenue: [rev(2023, 80), rev(2022, 90), rev(2021, 100)],
      liabilities: { fy: 2023, end: "2023-12-31", val: 200, form: "10-K", accn: "x" },
      stockholdersEquity: { fy: 2023, end: "2023-12-31", val: 50, form: "10-K", accn: "x" },
    });
    const row = buildRow(f, 2.0); // D/E = 4.0, threshold = 2.0
    expect(row.declineMatched).toBe(true);
    expect(row.leverageMatched).toBe(true);
    expect(row.matched).toBe(true);
    expect(row.flags).toEqual([]);
  });

  it("does not match when revenue is rising", () => {
    const f = fund({
      revenue: [rev(2023, 120), rev(2022, 110), rev(2021, 100)],
      liabilities: { fy: 2023, end: "2023-12-31", val: 200, form: "10-K", accn: "x" },
      stockholdersEquity: { fy: 2023, end: "2023-12-31", val: 50, form: "10-K", accn: "x" },
    });
    const row = buildRow(f, 2.0);
    expect(row.declineMatched).toBe(false);
    expect(row.matched).toBe(false);
  });

  it("does not match when D/E is below threshold", () => {
    const f = fund({
      revenue: [rev(2023, 80), rev(2022, 90), rev(2021, 100)],
      liabilities: { fy: 2023, end: "2023-12-31", val: 50, form: "10-K", accn: "x" },
      stockholdersEquity: { fy: 2023, end: "2023-12-31", val: 100, form: "10-K", accn: "x" },
    });
    const row = buildRow(f, 1.0); // D/E = 0.5
    expect(row.leverageMatched).toBe(false);
    expect(row.matched).toBe(false);
  });

  it("flags negative equity and treats it as high leverage", () => {
    const f = fund({
      revenue: [rev(2023, 80), rev(2022, 90), rev(2021, 100)],
      liabilities: { fy: 2023, end: "2023-12-31", val: 200, form: "10-K", accn: "x" },
      stockholdersEquity: { fy: 2023, end: "2023-12-31", val: -10, form: "10-K", accn: "x" },
    });
    const row = buildRow(f, 5.0);
    expect(row.flags).toContain("negative_equity");
    expect(row.debtToEquity).toBeNull();
    expect(row.leverageMatched).toBe(true);
    expect(row.declineMatched).toBe(true);
    expect(row.matched).toBe(true);
  });

  it("flags missing revenue when fewer than 3 years", () => {
    const f = fund({
      revenue: [rev(2023, 80), rev(2022, 90)],
      liabilities: { fy: 2023, end: "2023-12-31", val: 200, form: "10-K", accn: "x" },
      stockholdersEquity: { fy: 2023, end: "2023-12-31", val: 50, form: "10-K", accn: "x" },
    });
    const row = buildRow(f, 2.0);
    expect(row.flags).toContain("missing_revenue");
    expect(row.declineMatched).toBe(false);
    expect(row.matched).toBe(false);
  });

  it("flags missing balance sheet", () => {
    const f = fund({
      revenue: [rev(2023, 80), rev(2022, 90), rev(2021, 100)],
      liabilities: null,
      stockholdersEquity: null,
    });
    const row = buildRow(f, 2.0);
    expect(row.flags).toContain("missing_balance_sheet");
    expect(row.leverageMatched).toBe(false);
    expect(row.matched).toBe(false);
  });

  it("computes YoY percentages from newest-first revenue", () => {
    const f = fund({
      revenue: [rev(2023, 80), rev(2022, 90), rev(2021, 100)],
      liabilities: { fy: 2023, end: "2023-12-31", val: 1, form: "10-K", accn: "x" },
      stockholdersEquity: { fy: 2023, end: "2023-12-31", val: 1, form: "10-K", accn: "x" },
    });
    const row = buildRow(f, 0);
    // yoy_t = (rev_t - rev_t1) / rev_t1 = (80 - 90) / 90
    expect(row.yoy_t).toBeCloseTo(-10 / 90);
    expect(row.yoy_t1).toBeCloseTo(-10 / 100);
  });
});

describe("universeAverageDE", () => {
  it("averages valid D/E values, ignoring null and non-positive", () => {
    const rows = [
      { debtToEquity: 1.0 } as any,
      { debtToEquity: 3.0 } as any,
      { debtToEquity: null } as any,
      { debtToEquity: -1 } as any, // ignored
    ];
    expect(universeAverageDE(rows)).toBe(2.0);
  });

  it("returns 0 on empty universe", () => {
    expect(universeAverageDE([])).toBe(0);
  });
});
