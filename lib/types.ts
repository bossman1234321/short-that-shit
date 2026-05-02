export type FiscalYearFigure = {
  fy: number;
  end: string;
  val: number;
  form: string;
  accn: string;
};

export type YtdSnapshot = {
  start: string;       // period start (YYYY-MM-DD)
  end: string;         // period end (YYYY-MM-DD)
  monthsYtd: number;   // 3, 6, 9, or 12
  val: number;         // revenue over the period
};

// Trailing-twelve-months info derived from the most recent 10-Q (or 12-month
// 10-K when the YTD itself spans a full year). `current` is the latest
// year-to-date period; `priorYear` is the same-length period a year earlier
// from the comparative section of the 10-Q. `ttm` is the rolling-12 figure
// computed as lastAnnual + current - priorYear (or `current` directly when
// monthsYtd is 12). `partialYoy` is the YoY rate over the YTD period.
export type TtmInfo = {
  current: YtdSnapshot;
  priorYear: YtdSnapshot;
  ttm: number;
  partialYoy: number;
};

export type Fundamentals = {
  ticker: string;
  cik: string;
  entityName: string;
  revenue: FiscalYearFigure[];
  operatingCashFlow: FiscalYearFigure[];
  stockRepurchases: FiscalYearFigure[];
  liabilities: FiscalYearFigure | null;
  stockholdersEquity: FiscalYearFigure | null;
  ttm: TtmInfo | null;
  fetchedAt: string;
  source: "edgar" | "polygon";
};

export type ScreenFlag =
  | "negative_equity"
  | "missing_revenue"
  | "missing_balance_sheet"
  | "buyback_driven_neg_equity"
  | "buyback_winding_down"
  | "ocf_declining"
  | "ocf_resilient"
  | "sector_ineligible"
  | "ttm_recovering"
  | "ttm_accelerating";

export type NegEquityType = "buyback_driven" | "buyback_winding_down" | "distress" | null;

export type ScreenRow = {
  ticker: string;
  entityName: string;
  cik: string;
  sector?: string;
  debtToEquity: number | null;
  liabilities: number | null;
  stockholdersEquity: number | null;
  rev_t: number | null;
  rev_t1: number | null;
  rev_t2: number | null;
  rev_t_end: string | null;
  rev_t1_end: string | null;
  rev_t2_end: string | null;
  yoy_t: number | null;
  yoy_t1: number | null;
  ocf_t: number | null;
  ocf_t1: number | null;
  ocf_t2: number | null;
  ocf_t_end: string | null;
  yoy_ocf_t: number | null;
  yoy_ocf_t1: number | null;
  ocfDeclineMatched: boolean;
  ocfResilient: boolean;
  negEquityType: NegEquityType;
  recentRepurchases: number | null;
  // 4th year of revenue is included so the client can recompute matches
  // for declineYears=3 (4 years of monotonic decline) without a refetch.
  rev_t3: number | null;
  rev_t3_end: string | null;
  // ML short-conviction score in [0, 1]. Null when feature vector cannot
  // be built (missing yoy/ocf data) or no model is loaded.
  mlShortScore: number | null;
  // Most recent partial-year revenue from the latest 10-Q. partialYoy is
  // the YTD-over-prior-YTD rate, ttm is the rolling-12 figure derived from
  // lastAnnual + current YTD - prior-year YTD.
  revTtm: number | null;
  revTtmEnd: string | null;
  revTtmMonthsYtd: number | null;
  revTtmYoy: number | null;
  // ttmRecovering: matched on annual decline, but the YTD trend has turned
  //   positive (or close to it). Warning sign for short candidates.
  // ttmAccelerating: matched on annual decline, AND YTD is declining faster
  //   than the most recent annual rate. Strengthens the short thesis.
  ttmRecovering: boolean;
  ttmAccelerating: boolean;
  declineMatched: boolean;
  leverageMatched: boolean;
  // sectorIneligible: D/E is structurally meaningless for this sector
  // (Financials, Real Estate, Utilities) — match is suppressed by default.
  sectorIneligible: boolean;
  matched: boolean;
  highConvictionMatched: boolean;
  flags: ScreenFlag[];
};

// Surfaced backtest summary for the UI footer. Subset of what's in
// public/data/backtest.json — full per-event records aren't shipped.
export type BacktestSummary = {
  generatedAt: string;
  triggerCount: number;
  withForwardReturns: number;
  meanAlpha1y: number | null;
  medianAlpha1y: number | null;
  hitRate: number | null;
  hitRateBigMiss: number | null;
  bySector: Record<string, { count: number; meanAlpha1y: number | null; hitRate: number | null }>;
};

export type MlMetadata = {
  trainSize: number;
  testSize: number;
  trainAuc: number;
  testAuc: number;
  trainSplitYearLt: number;
  trainedAt: string;
  positiveLabelDef: string;
  // Top features by absolute coefficient, with sign — for the footer.
  topFeatures: Array<{ name: string; coef: number }>;
};

export type ScreenResult = {
  threshold: { kind: "average" | "fixed"; value: number };
  declineYears: 1 | 2 | 3;
  universeSize: number;
  matchedCount: number;
  highConvictionCount: number;
  rows: ScreenRow[];
  generatedAt: string;
  cacheHits: number;
  cacheMisses: number;
  backtest: BacktestSummary | null;
  mlModel: MlMetadata | null;
};
