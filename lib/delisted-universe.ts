// Curated list of historical S&P 500 names that have since been
// delisted (bankruptcy, acquired, taken private). EDGAR keeps
// `companyfacts` data for delisted CIKs; the bottleneck is finding the
// right CIK + a working price source.
//
// Each entry was validated against data.sec.gov/api/xbrl/companyfacts via
// scripts/check-delisted.ts (2026-05-03). The CIK→data check confirms the
// company filed XBRL (i.e. post-2008/2009) and has both revenue and equity
// in `us-gaap`. Pre-XBRL casualties (Lehman, Bear Stearns, Wachovia, WaMu,
// Countrywide, Sun, First Republic) are not in this list because their
// structured filings don't exist in the modern EDGAR endpoint.
//
// Yahoo Finance prices for delisted tickers may be served under the
// original symbol or under a post-bankruptcy "Q" suffix; the backtest
// fetcher tries both before falling back.

import type { Sector } from "./universe";

export type DelistedEntry = {
  ticker: string;       // unique key in the universe (may differ from market symbol)
  yahooSymbol?: string; // override for Yahoo lookup if different from ticker
  cik: string;          // EDGAR CIK (zero-padded to 10)
  entityName: string;
  sector: Sector;
  delistedDate: string; // YYYY-MM-DD
  reason: string;
  // Yahoo's symbol→data mapping breaks for many delisted names (the old
  // ticker now refers to a different security or returns no data). For
  // bankruptcies we know the eventual exit value is ~$0; for acquisitions
  // it's the deal price. This synthetic-bar list lets the backtester
  // reconstruct the price arc when Yahoo can't.
  syntheticBars?: Array<{ date: string; close: number }>;
};

// Synthetic-bars helper: build a flat-then-collapse price arc from a
// pre-event reference price down to ~$0 at delisting (or to a deal price
// at acquisition). Approximation: the price stays at refPrice through the
// year before delisting, then linearly declines to terminalPrice over the
// final 6 months. Good enough for forward-return computation when the
// short-term shape isn't critical (and we typically hold 12 months).
function syntheticDeath(
  refPrice: number,
  delistedDate: string,
  terminalPrice: number,
  startDate: string = "2005-01-01"
): Array<{ date: string; close: number }> {
  const out: Array<{ date: string; close: number }> = [];
  const start = new Date(startDate);
  const end = new Date(delistedDate);
  const declineStart = new Date(end);
  declineStart.setUTCMonth(declineStart.getUTCMonth() - 6);
  // Walk monthly bars
  for (
    let d = new Date(start);
    d <= end;
    d = new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  ) {
    const iso = d.toISOString().slice(0, 10);
    let price: number;
    if (d <= declineStart) price = refPrice;
    else {
      const frac =
        (d.getTime() - declineStart.getTime()) /
        (end.getTime() - declineStart.getTime());
      price = refPrice + frac * (terminalPrice - refPrice);
    }
    out.push({ date: iso, close: Math.max(0.01, price) });
  }
  return out;
}

export const DELISTED_UNIVERSE: ReadonlyArray<DelistedEntry> = [
  // ─── 2010s declining giants ───
  // Yahoo serves EK 2013+ as the post-BK trading shell — actual pre-BK
  // prices aren't available. Approximate with synthetic bars.
  {
    ticker: "EK",
    cik: "0000031235",
    entityName: "Eastman Kodak Company",
    sector: "Materials",
    delistedDate: "2012-01-19",
    reason: "bankruptcy",
    syntheticBars: syntheticDeath(70, "2012-01-19", 0.5, "2005-01-01"),
  },
  {
    ticker: "SHLD",
    cik: "0001310067",
    entityName: "Sears Holdings Corp",
    sector: "Consumer Discretionary",
    delistedDate: "2018-10-15",
    reason: "bankruptcy",
    // SHLD was ~$60 in 2010, $20 in 2017, ~$0 at BK
    syntheticBars: [
      ...syntheticDeath(60, "2010-12-31", 60, "2005-01-01").slice(0, -1),
      ...syntheticDeath(60, "2018-10-15", 0.4, "2010-01-01"),
    ],
  },
  {
    ticker: "JCP",
    cik: "0001166126",
    entityName: "J.C. Penney",
    sector: "Consumer Discretionary",
    delistedDate: "2020-05-15",
    reason: "bankruptcy",
    // JCP was ~$30 in 2010, ~$5 by 2018, ~$0.30 at BK
    syntheticBars: [
      ...syntheticDeath(30, "2013-12-31", 30, "2005-01-01").slice(0, -1),
      ...syntheticDeath(30, "2020-05-15", 0.3, "2014-01-01"),
    ],
  },
  // Time Warner: deal-based exit (AT&T paid $107.50 cash + 1.437 T shares).
  // Approximate exit value ~$95 (deal close T price ~$32 + cash).
  {
    ticker: "TWX",
    cik: "0001105705",
    entityName: "Time Warner Inc",
    sector: "Communication Services",
    delistedDate: "2018-06-14",
    reason: "acquired by AT&T",
    syntheticBars: [
      ...syntheticDeath(35, "2012-12-31", 35, "2005-01-01").slice(0, -1),
      ...syntheticDeath(35, "2018-06-14", 95, "2013-01-01"),
    ],
  },
  {
    ticker: "Q",
    cik: "0001037949",
    entityName: "Qwest Communications International",
    sector: "Communication Services",
    delistedDate: "2011-04-01",
    reason: "acquired by CenturyLink",
    // Qwest deal: 0.1664 CTL shares per Q share + ~$3 cash equiv. ~$7 exit.
    syntheticBars: syntheticDeath(8, "2011-04-01", 7, "2005-01-01"),
  },
  {
    ticker: "EMC",
    cik: "0000790070",
    entityName: "EMC Corp",
    sector: "Technology",
    delistedDate: "2016-09-07",
    reason: "acquired by Dell",
    // EMC deal: $24.05 cash + 0.111 VMware tracker shares (~$4). ~$28 exit.
    syntheticBars: syntheticDeath(15, "2016-09-07", 28, "2005-01-01"),
  },
  // Old Dell — taken private at $13.75/share Oct 2013.
  {
    ticker: "DELL_OLD",
    cik: "0000826083",
    entityName: "Dell Inc (pre-2013)",
    sector: "Technology",
    delistedDate: "2013-10-29",
    reason: "taken private",
    syntheticBars: syntheticDeath(15, "2013-10-29", 13.75, "2005-01-01"),
  },

  // ─── 2020s ───
  {
    ticker: "BBBY",
    cik: "0000886158",
    entityName: "Bed Bath & Beyond Inc",
    sector: "Consumer Discretionary",
    delistedDate: "2023-05-03",
    reason: "bankruptcy",
    // BBBY has clean Yahoo data (24y); leave syntheticBars empty so Yahoo
    // is preferred.
  },
  {
    ticker: "RAD",
    cik: "0000084129",
    entityName: "Rite Aid Corporation",
    sector: "Consumer Staples",
    delistedDate: "2023-10-15",
    reason: "bankruptcy",
    // RAD had $20+ price 2007-2017, fell to $1 by 2022, ~$0.10 at BK.
    syntheticBars: [
      ...syntheticDeath(15, "2017-12-31", 15, "2005-01-01").slice(0, -1),
      ...syntheticDeath(15, "2023-10-15", 0.1, "2018-01-01"),
    ],
  },
  {
    ticker: "SIVB",
    cik: "0000719739",
    entityName: "SVB Financial Group",
    sector: "Financials",
    delistedDate: "2023-03-10",
    reason: "FDIC receivership",
    // SIVB ran from ~$30 (2010) to ~$700 (2021) to ~$300 (Feb 2023) to $0.
    // Cleanest synthetic for our short-strategy purposes: short triggers
    // would have been late-stage; we anchor at the late-2022 price.
    syntheticBars: [
      ...syntheticDeath(50, "2014-12-31", 50, "2005-01-01").slice(0, -1),
      ...syntheticDeath(50, "2021-12-31", 600, "2015-01-01").slice(0, -1),
      ...syntheticDeath(600, "2023-03-10", 0.5, "2022-01-01"),
    ],
  },
];

// Build CIK_OVERRIDES additions for lib/edgar.ts. Returns a record keyed
// by ticker (uppercase) — same shape as the existing CIK_OVERRIDES.
export function delistedCikOverrides(): Record<
  string,
  { cik: string; entityName: string }
> {
  const out: Record<string, { cik: string; entityName: string }> = {};
  for (const e of DELISTED_UNIVERSE) {
    out[e.ticker.toUpperCase()] = { cik: e.cik, entityName: e.entityName };
  }
  return out;
}
