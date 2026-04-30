import type { Fundamentals, ScreenFlag, ScreenRow } from "./types";

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

export function yoy(prior: number | null, current: number | null): number | null {
  if (prior == null || current == null || prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

export function buildRow(
  fundamentals: Fundamentals,
  threshold: number
): ScreenRow {
  const flags: ScreenFlag[] = [];

  // revenue array is sorted newest-first by fetchFundamentals
  const r0 = fundamentals.revenue[0] ?? null;
  const r1 = fundamentals.revenue[1] ?? null;
  const r2 = fundamentals.revenue[2] ?? null;
  if (!r0 || !r1 || !r2) flags.push("missing_revenue");

  const liab = fundamentals.liabilities?.val ?? null;
  const eq = fundamentals.stockholdersEquity?.val ?? null;
  if (liab == null || eq == null) flags.push("missing_balance_sheet");
  if (eq != null && eq <= 0) flags.push("negative_equity");

  const de = debtToEquity(liab, eq);
  const declineMatched = isMonotonicRevenueDecline(
    r2?.val ?? null,
    r1?.val ?? null,
    r0?.val ?? null
  );

  // Negative equity counts as "leverage matched" (effectively infinite D/E)
  const leverageMatched =
    flags.includes("negative_equity") || (de != null && de > threshold);

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
    declineMatched,
    leverageMatched,
    matched: declineMatched && leverageMatched,
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
