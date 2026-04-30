export type FiscalYearFigure = {
  fy: number;
  end: string;
  val: number;
  form: string;
  accn: string;
};

export type Fundamentals = {
  ticker: string;
  cik: string;
  entityName: string;
  revenue: FiscalYearFigure[];
  liabilities: FiscalYearFigure | null;
  stockholdersEquity: FiscalYearFigure | null;
  fetchedAt: string;
  source: "edgar" | "polygon";
};

export type ScreenFlag = "negative_equity" | "missing_revenue" | "missing_balance_sheet";

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
  declineMatched: boolean;
  leverageMatched: boolean;
  matched: boolean;
  flags: ScreenFlag[];
};

export type ScreenResult = {
  threshold: { kind: "average" | "fixed"; value: number };
  universeSize: number;
  matchedCount: number;
  rows: ScreenRow[];
  generatedAt: string;
  cacheHits: number;
  cacheMisses: number;
};
