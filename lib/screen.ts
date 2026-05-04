import type {
  FiscalYearFigure,
  Fundamentals,
  NegEquityType,
  ScreenFlag,
  ScreenRow,
} from "./types";
import {
  buildFeatureVector,
  scoreFeatures,
  type ModelWeights,
} from "./ml-score";
import type { Sector } from "./universe";

export function debtToEquity(
  liabilities: number | null,
  equity: number | null
): number | null {
  if (liabilities == null || equity == null) return null;
  if (equity <= 0) return null;
  return liabilities / equity;
}

export function isMonotonicRevenueDecline(
  rev_t2: number | null,
  rev_t1: number | null,
  rev_t: number | null
): boolean {
  if (rev_t2 == null || rev_t1 == null || rev_t == null) return false;
  return rev_t < rev_t1 && rev_t1 < rev_t2;
}

// Generic n-year monotonic-decline check. Pass revenues newest-first; the
// function returns true iff the most recent `years` consecutive YoY changes
// are all strict declines. years=1 → 1 YoY drop, years=2 → 2 (current
// default), years=3 → 3.
export function isMonotonicRevenueDeclineN(
  newestFirst: Array<number | null>,
  years: 1 | 2 | 3
): boolean {
  if (newestFirst.length < years + 1) return false;
  for (let i = 0; i < years; i++) {
    const newer = newestFirst[i];
    const older = newestFirst[i + 1];
    if (newer == null || older == null) return false;
    if (!(newer < older)) return false;
  }
  return true;
}

export function yoy(prior: number | null, current: number | null): number | null {
  if (prior == null || current == null || prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

// Classify negative equity into buyback-driven vs distress-driven.
// The user wants buyback-driven neg-eq filtered out of "leverage matched"
// because it's a capital-return signal, not financial weakness.
//
// Logic:
// - If equity > 0: not applicable, return null
// - Sum cumulative buybacks over last 5 reported years
// - If cumulative buybacks >= |equity deficit| → buybacks plausibly explain
//   the deficit, classify as buyback_driven
// - If buyback program is winding down (latest year < 50% of prior 3-yr avg)
//   → buyback_winding_down (still flag as warning, kept in leverage match)
// - Otherwise → distress (real balance-sheet stress)
export function classifyNegEquity(
  equity: number | null,
  stockRepurchases: FiscalYearFigure[]
): NegEquityType {
  if (equity == null || equity > 0) return null;
  const deficit = Math.abs(equity);

  const last5 = stockRepurchases.slice(0, 5);
  const cumulative = last5.reduce((a, e) => a + (e.val || 0), 0);

  if (cumulative < deficit) return "distress";

  const latest = last5[0]?.val ?? 0;
  const prior3 = last5.slice(1, 4);
  const prior3Avg =
    prior3.length > 0
      ? prior3.reduce((a, e) => a + (e.val || 0), 0) / prior3.length
      : 0;

  if (prior3Avg > 0 && latest < 0.5 * prior3Avg) return "buyback_winding_down";
  return "buyback_driven";
}

// Threshold for "TTM trend has turned" — partial-year YoY ≥ -1% means the
// in-progress year is essentially flat or growing despite annual decline.
// Treats noise around zero as recovery.
const TTM_RECOVERING_PCT = -0.01;

// "Decline accelerating" = the YTD pace is at least 3 percentage points
// worse than the most recent annual rate. Tightens the short thesis.
const TTM_ACCELERATING_DELTA = -0.03;

export function classifyTtmTrend(
  declineMatched: boolean,
  partialYoy: number | null,
  annualYoy: number | null
): { recovering: boolean; accelerating: boolean } {
  if (!declineMatched || partialYoy == null) {
    return { recovering: false, accelerating: false };
  }
  const recovering = partialYoy >= TTM_RECOVERING_PCT;
  const accelerating =
    annualYoy != null && partialYoy < annualYoy + TTM_ACCELERATING_DELTA;
  return { recovering, accelerating };
}

// Returns whether OCF declined two consecutive years (mirrors revenue logic).
function isOcfDecline(
  ocf_t2: number | null,
  ocf_t1: number | null,
  ocf_t: number | null
): boolean {
  if (ocf_t2 == null || ocf_t1 == null || ocf_t == null) return false;
  return ocf_t < ocf_t1 && ocf_t1 < ocf_t2;
}

// "Resilient" = OCF is growing despite revenue declining. This is the
// MO/dividend-trap pattern: top-line shrinks but cash machine keeps humming.
function isOcfResilient(
  declineMatched: boolean,
  ocf_t: number | null,
  ocf_t1: number | null
): boolean {
  if (!declineMatched) return false;
  if (ocf_t == null || ocf_t1 == null) return false;
  return ocf_t > ocf_t1;
}

export function buildRow(
  fundamentals: Fundamentals,
  threshold: number,
  options: {
    declineYears?: 1 | 2 | 3;
    sector?: Sector;
    model?: ModelWeights | null;
  } = {}
): ScreenRow {
  const declineYears = options.declineYears ?? 2;
  const flags: ScreenFlag[] = [];

  // revenue array is sorted newest-first by fetchFundamentals
  const r0 = fundamentals.revenue[0] ?? null;
  const r1 = fundamentals.revenue[1] ?? null;
  const r2 = fundamentals.revenue[2] ?? null;
  const r3 = fundamentals.revenue[3] ?? null;
  if (!r0 || !r1 || !r2) flags.push("missing_revenue");

  const o0 = fundamentals.operatingCashFlow[0] ?? null;
  const o1 = fundamentals.operatingCashFlow[1] ?? null;
  const o2 = fundamentals.operatingCashFlow[2] ?? null;

  const liab = fundamentals.liabilities?.val ?? null;
  const eq = fundamentals.stockholdersEquity?.val ?? null;
  if (liab == null || eq == null) flags.push("missing_balance_sheet");
  if (eq != null && eq <= 0) flags.push("negative_equity");

  const negEquityType = classifyNegEquity(eq, fundamentals.stockRepurchases);
  if (negEquityType === "buyback_driven") flags.push("buyback_driven_neg_equity");
  if (negEquityType === "buyback_winding_down") flags.push("buyback_winding_down");

  const de = debtToEquity(liab, eq);
  const declineMatched = isMonotonicRevenueDeclineN(
    [r0?.val ?? null, r1?.val ?? null, r2?.val ?? null, r3?.val ?? null],
    declineYears
  );

  const ocfDeclineMatched = isOcfDecline(
    o2?.val ?? null,
    o1?.val ?? null,
    o0?.val ?? null
  );
  const ocfResilient = isOcfResilient(
    declineMatched,
    o0?.val ?? null,
    o1?.val ?? null
  );
  if (declineMatched && ocfDeclineMatched) flags.push("ocf_declining");
  if (ocfResilient) flags.push("ocf_resilient");

  const annualYoy = yoy(r1?.val ?? null, r0?.val ?? null);
  const ttmTrend = classifyTtmTrend(
    declineMatched,
    fundamentals.ttm?.partialYoy ?? null,
    annualYoy
  );
  if (ttmTrend.recovering) flags.push("ttm_recovering");
  if (ttmTrend.accelerating) flags.push("ttm_accelerating");

  // Negative equity counts as "leverage matched" UNLESS it's plausibly
  // buyback-driven (capital return, not distress). buyback_winding_down still
  // counts because the program ending could itself signal weakness.
  const negEquityCountsAsLeverage =
    flags.includes("negative_equity") && negEquityType !== "buyback_driven";
  const leverageMatched =
    negEquityCountsAsLeverage || (de != null && de > threshold);

  const matched = declineMatched && leverageMatched;
  // High-conviction = the screen matches AND OCF is also declining (genuine
  // distress, not a dividend-trap false positive).
  const highConvictionMatched = matched && ocfDeclineMatched;

  const recentRepurchases = fundamentals.stockRepurchases[0]?.val ?? null;

  // ML score: only meaningful for *triggered* rows. The model is trained
  // exclusively on historical screen triggers (decline + leverage), so
  // scoring untriggered names is out-of-distribution and produces
  // misleadingly extreme outputs (saw NCLH score 1.000 simply for high
  // D/E with rising revenue — the model never saw growing-revenue
  // companies during training).
  //
  // Note: declineMatched here uses the user's chosen years lever; we score
  // any row that meets the decline condition, even if leverage / sector
  // ineligibility ultimately prevent it from being "matched". That gives
  // the user a more complete signal when they tune levers.
  let mlShortScore: number | null = null;
  if (options.model && options.sector && declineMatched) {
    const ocfYoY = yoy(o1?.val ?? null, o0?.val ?? null);
    const ocfDec2y =
      o2?.val != null &&
      o1?.val != null &&
      o0?.val != null &&
      o0.val < o1.val &&
      o1.val < o2.val;
    const yoyT1 = yoy(r2?.val ?? null, r1?.val ?? null);
    const yoyT = yoy(r1?.val ?? null, r0?.val ?? null);
    const features = buildFeatureVector({
      de,
      negEquity: eq != null && eq <= 0,
      yoy_t: yoyT,
      yoy_t1: yoyT1,
      ocfYoY,
      ocfDecline2y: ocfDec2y,
      sector: options.sector,
    });
    if (features) mlShortScore = scoreFeatures(features, options.model);
  }

  return {
    ticker: fundamentals.ticker,
    entityName: fundamentals.entityName,
    cik: fundamentals.cik,
    debtToEquity: de,
    liabilities: liab,
    stockholdersEquity: eq,
    rev_t: r0?.val ?? null,
    rev_t1: r1?.val ?? null,
    rev_t2: r2?.val ?? null,
    rev_t_end: r0?.end ?? null,
    rev_t1_end: r1?.end ?? null,
    rev_t2_end: r2?.end ?? null,
    yoy_t: yoy(r1?.val ?? null, r0?.val ?? null),
    yoy_t1: yoy(r2?.val ?? null, r1?.val ?? null),
    ocf_t: o0?.val ?? null,
    ocf_t1: o1?.val ?? null,
    ocf_t2: o2?.val ?? null,
    ocf_t_end: o0?.end ?? null,
    yoy_ocf_t: yoy(o1?.val ?? null, o0?.val ?? null),
    yoy_ocf_t1: yoy(o2?.val ?? null, o1?.val ?? null),
    ocfDeclineMatched,
    ocfResilient,
    negEquityType,
    recentRepurchases,
    rev_t3: r3?.val ?? null,
    rev_t3_end: r3?.end ?? null,
    mlShortScore,
    revTtm: fundamentals.ttm?.ttm ?? null,
    revTtmEnd: fundamentals.ttm?.current.end ?? null,
    revTtmMonthsYtd: fundamentals.ttm?.current.monthsYtd ?? null,
    revTtmYoy: fundamentals.ttm?.partialYoy ?? null,
    ttmRecovering: ttmTrend.recovering,
    ttmAccelerating: ttmTrend.accelerating,
    declineMatched,
    leverageMatched,
    sectorIneligible: false,
    regimeExcluded: false,
    regimeExclusionReason: null,
    regimeExclusionUntil: null,
    matched,
    highConvictionMatched,
    flags,
  };
}

export function universeAverageDE(rows: ScreenRow[]): number {
  const valid = rows
    .map((r) => r.debtToEquity)
    .filter((d): d is number => d != null && Number.isFinite(d) && d > 0);
  if (valid.length === 0) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}
