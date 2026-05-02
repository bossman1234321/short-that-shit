import { describe, it, expect } from "vitest";
import {
  classifyNegEquity,
  classifyTtmTrend,
  debtToEquity,
  isMonotonicRevenueDecline,
  isMonotonicRevenueDeclineN,
  yoy,
  buildRow,
  universeAverageDE,
} from "./screen";
import type { Fundamentals, TtmInfo } from "./types";

function fund(overrides: Partial<Fundamentals> = {}): Fundamentals {
  return {
    ticker: "TEST",
    cik: "0000000001",
    entityName: "Test Co",
    revenue: [],
    operatingCashFlow: [],
    stockRepurchases: [],
    liabilities: null,
    stockholdersEquity: null,
    ttm: null,
    fetchedAt: "2026-04-29T00:00:00Z",
    source: "edgar",
    ...overrides,
  };
}

function ttm(opts: {
  ytdVal: number;
  priorYtdVal: number;
  monthsYtd?: number;
  end?: string;
  ttmVal?: number;
}): TtmInfo {
  const monthsYtd = opts.monthsYtd ?? 9;
  const end = opts.end ?? "2024-09-30";
  const start = end.slice(0, 4) + "-01-01";
  const priorEnd = `${Number(end.slice(0, 4)) - 1}` + end.slice(4);
  const priorStart = priorEnd.slice(0, 4) + "-01-01";
  const partialYoy =
    opts.priorYtdVal !== 0 ? opts.ytdVal / opts.priorYtdVal - 1 : 0;
  return {
    current: { start, end, monthsYtd, val: opts.ytdVal },
    priorYear: { start: priorStart, end: priorEnd, monthsYtd, val: opts.priorYtdVal },
    ttm: opts.ttmVal ?? opts.ytdVal, // sane default; tests override when needed
    partialYoy,
  };
}

function fig(fy: number, val: number) {
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

describe("isMonotonicRevenueDeclineN", () => {
  // newest-first: [t, t-1, t-2, t-3]
  it("years=1 needs only 1 YoY drop", () => {
    expect(isMonotonicRevenueDeclineN([80, 90], 1)).toBe(true);
    expect(isMonotonicRevenueDeclineN([100, 90], 1)).toBe(false);
    expect(isMonotonicRevenueDeclineN([80], 1)).toBe(false); // not enough data
  });
  it("years=2 matches the legacy 2y check", () => {
    expect(isMonotonicRevenueDeclineN([80, 90, 100], 2)).toBe(true);
    expect(isMonotonicRevenueDeclineN([80, 90, 85], 2)).toBe(false); // not strict
  });
  it("years=3 needs 4 entries with strict descent", () => {
    expect(isMonotonicRevenueDeclineN([70, 80, 90, 100], 3)).toBe(true);
    expect(isMonotonicRevenueDeclineN([80, 90, 100], 3)).toBe(false); // only 3 entries
    expect(isMonotonicRevenueDeclineN([70, 80, 80, 100], 3)).toBe(false); // tie at t-1=t-2
  });
  it("returns false on any null along the required prefix", () => {
    expect(isMonotonicRevenueDeclineN([80, null, 100], 2)).toBe(false);
    expect(isMonotonicRevenueDeclineN([null, 90, 100], 2)).toBe(false);
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

describe("classifyNegEquity", () => {
  it("returns null when equity is positive", () => {
    expect(classifyNegEquity(100, [])).toBeNull();
  });

  it("returns 'distress' when neg equity but no buybacks", () => {
    expect(classifyNegEquity(-500, [])).toBe("distress");
  });

  it("returns 'distress' when buybacks exist but cumulative is below the deficit", () => {
    const small = [fig(2024, 50), fig(2023, 60), fig(2022, 70)];
    expect(classifyNegEquity(-500, small)).toBe("distress");
  });

  it("returns 'buyback_driven' when cumulative buybacks exceed the deficit and program is steady", () => {
    const steady = [
      fig(2024, 1500),
      fig(2023, 1400),
      fig(2022, 1300),
      fig(2021, 1200),
    ];
    expect(classifyNegEquity(-1000, steady)).toBe("buyback_driven");
  });

  it("returns 'buyback_winding_down' when latest year is < 50% of prior 3-yr avg", () => {
    const slowing = [
      fig(2024, 200), // big drop
      fig(2023, 1500),
      fig(2022, 1400),
      fig(2021, 1300),
    ];
    expect(classifyNegEquity(-1000, slowing)).toBe("buyback_winding_down");
  });
});

describe("classifyTtmTrend", () => {
  it("returns no flags when annual decline didn't match", () => {
    expect(classifyTtmTrend(false, -0.10, -0.05)).toEqual({
      recovering: false,
      accelerating: false,
    });
  });

  it("returns no flags when partialYoy is missing", () => {
    expect(classifyTtmTrend(true, null, -0.05)).toEqual({
      recovering: false,
      accelerating: false,
    });
  });

  it("flags recovering when YTD trend is flat or up despite annual decline", () => {
    // Annual was -5%, but YTD has turned positive
    expect(classifyTtmTrend(true, 0.02, -0.05).recovering).toBe(true);
    // Almost flat counts as recovery
    expect(classifyTtmTrend(true, -0.005, -0.05).recovering).toBe(true);
  });

  it("does NOT flag recovering when YTD is still meaningfully negative", () => {
    expect(classifyTtmTrend(true, -0.05, -0.05).recovering).toBe(false);
    expect(classifyTtmTrend(true, -0.03, -0.05).recovering).toBe(false);
  });

  it("flags accelerating when YTD is at least 3pp worse than annual", () => {
    // Annual was -5%, YTD is -10% (5pp worse) → accelerating
    expect(classifyTtmTrend(true, -0.10, -0.05).accelerating).toBe(true);
  });

  it("does NOT flag accelerating when YTD is only marginally worse", () => {
    // Annual was -5%, YTD is -6% (1pp worse) — within noise
    expect(classifyTtmTrend(true, -0.06, -0.05).accelerating).toBe(false);
  });

  it("can flag both recovering=false and accelerating=true (real distress)", () => {
    const r = classifyTtmTrend(true, -0.20, -0.10);
    expect(r.recovering).toBe(false);
    expect(r.accelerating).toBe(true);
  });
});

describe("buildRow", () => {
  it("matches when both decline and leverage are met", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, 50) },
    });
    const row = buildRow(f, 2.0);
    expect(row.declineMatched).toBe(true);
    expect(row.leverageMatched).toBe(true);
    expect(row.matched).toBe(true);
    expect(row.flags).toEqual([]);
  });

  it("returns sectorIneligible=false by default (set later by runScreen)", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, 50) },
    });
    const row = buildRow(f, 2.0);
    expect(row.sectorIneligible).toBe(false);
  });

  it("does not match when revenue is rising", () => {
    const f = fund({
      revenue: [fig(2023, 120), fig(2022, 110), fig(2021, 100)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, 50) },
    });
    const row = buildRow(f, 2.0);
    expect(row.declineMatched).toBe(false);
    expect(row.matched).toBe(false);
  });

  it("does not match when D/E is below threshold", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 50) },
      stockholdersEquity: { ...fig(2023, 100) },
    });
    const row = buildRow(f, 1.0);
    expect(row.leverageMatched).toBe(false);
    expect(row.matched).toBe(false);
  });

  it("flags negative equity as leverage when no plausible buyback explanation", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, -10) },
      stockRepurchases: [], // no buybacks
    });
    const row = buildRow(f, 5.0);
    expect(row.flags).toContain("negative_equity");
    expect(row.negEquityType).toBe("distress");
    expect(row.debtToEquity).toBeNull();
    expect(row.leverageMatched).toBe(true);
    expect(row.matched).toBe(true);
  });

  it("EXCLUDES buyback-driven negative equity from leverage match", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, -1000) }, // small deficit
      stockRepurchases: [
        fig(2023, 5000),
        fig(2022, 4500),
        fig(2021, 4000),
      ], // huge buyback program dwarfs the deficit
    });
    const row = buildRow(f, 5.0);
    expect(row.flags).toContain("negative_equity");
    expect(row.flags).toContain("buyback_driven_neg_equity");
    expect(row.negEquityType).toBe("buyback_driven");
    // D/E is null (negative equity), buybacks explain it, so leverage NOT matched
    expect(row.leverageMatched).toBe(false);
    expect(row.matched).toBe(false);
  });

  it("KEEPS buyback-winding-down neg-eq in leverage match (warning sign)", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, -1000) },
      stockRepurchases: [
        fig(2023, 100), // dropped sharply
        fig(2022, 4500),
        fig(2021, 4000),
        fig(2020, 3500),
      ],
    });
    const row = buildRow(f, 5.0);
    expect(row.negEquityType).toBe("buyback_winding_down");
    expect(row.flags).toContain("buyback_winding_down");
    expect(row.leverageMatched).toBe(true);
    expect(row.matched).toBe(true);
  });

  it("flags ocf_declining when revenue and OCF both decline 2y", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      operatingCashFlow: [fig(2023, 8), fig(2022, 9), fig(2021, 10)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, 50) },
    });
    const row = buildRow(f, 2.0);
    expect(row.ocfDeclineMatched).toBe(true);
    expect(row.flags).toContain("ocf_declining");
    expect(row.highConvictionMatched).toBe(true);
  });

  it("flags ocf_resilient when revenue declines but OCF grows (MO pattern)", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      operatingCashFlow: [fig(2023, 25), fig(2022, 22), fig(2021, 20)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, 50) },
    });
    const row = buildRow(f, 2.0);
    expect(row.ocfDeclineMatched).toBe(false);
    expect(row.ocfResilient).toBe(true);
    expect(row.flags).toContain("ocf_resilient");
    expect(row.matched).toBe(true);
    expect(row.highConvictionMatched).toBe(false);
  });

  it("flags ttm_recovering when annual declines but YTD turns positive", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, 50) },
      ttm: ttm({ ytdVal: 65, priorYtdVal: 60 }), // YTD +8%
    });
    const row = buildRow(f, 2.0);
    expect(row.matched).toBe(true);
    expect(row.ttmRecovering).toBe(true);
    expect(row.ttmAccelerating).toBe(false);
    expect(row.flags).toContain("ttm_recovering");
  });

  it("flags ttm_accelerating when YTD declines faster than annual rate", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, 50) },
      // annual yoy_t = (80-90)/90 ≈ -11%
      // YTD yoy = -20% — much worse
      ttm: ttm({ ytdVal: 48, priorYtdVal: 60 }),
    });
    const row = buildRow(f, 2.0);
    expect(row.ttmAccelerating).toBe(true);
    expect(row.ttmRecovering).toBe(false);
    expect(row.flags).toContain("ttm_accelerating");
    expect(row.matched).toBe(true);
  });

  it("populates revTtm fields from fundamentals.ttm when present", () => {
    const f = fund({
      revenue: [fig(2023, 100)],
      ttm: ttm({
        ytdVal: 50,
        priorYtdVal: 40,
        monthsYtd: 9,
        end: "2024-09-30",
        ttmVal: 110,
      }),
    });
    const row = buildRow(f, 0);
    expect(row.revTtm).toBe(110);
    expect(row.revTtmEnd).toBe("2024-09-30");
    expect(row.revTtmMonthsYtd).toBe(9);
    expect(row.revTtmYoy).toBeCloseTo(0.25);
  });

  it("leaves TTM fields null and sets neither flag when ttm info is absent", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, 50) },
      ttm: null,
    });
    const row = buildRow(f, 2.0);
    expect(row.revTtm).toBeNull();
    expect(row.revTtmYoy).toBeNull();
    expect(row.ttmRecovering).toBe(false);
    expect(row.ttmAccelerating).toBe(false);
    expect(row.flags).not.toContain("ttm_recovering");
    expect(row.flags).not.toContain("ttm_accelerating");
  });

  it("does not flag ttm_recovering when annual decline didn't match", () => {
    // Rising annual revenue → declineMatched=false → no TTM flags regardless
    const f = fund({
      revenue: [fig(2023, 120), fig(2022, 110), fig(2021, 100)],
      ttm: ttm({ ytdVal: 50, priorYtdVal: 60 }), // big YTD drop
    });
    const row = buildRow(f, 0);
    expect(row.declineMatched).toBe(false);
    expect(row.ttmRecovering).toBe(false);
    expect(row.ttmAccelerating).toBe(false);
  });

  it("flags missing revenue when fewer than 3 years", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90)],
      liabilities: { ...fig(2023, 200) },
      stockholdersEquity: { ...fig(2023, 50) },
    });
    const row = buildRow(f, 2.0);
    expect(row.flags).toContain("missing_revenue");
    expect(row.declineMatched).toBe(false);
    expect(row.matched).toBe(false);
  });

  it("flags missing balance sheet", () => {
    const f = fund({
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
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
      revenue: [fig(2023, 80), fig(2022, 90), fig(2021, 100)],
      liabilities: { ...fig(2023, 1) },
      stockholdersEquity: { ...fig(2023, 1) },
    });
    const row = buildRow(f, 0);
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
      { debtToEquity: -1 } as any,
    ];
    expect(universeAverageDE(rows)).toBe(2.0);
  });

  it("returns 0 on empty universe", () => {
    expect(universeAverageDE([])).toBe(0);
  });
});
