// Validate candidate CIKs for delisted S&P 500 names by hitting EDGAR
// `companyfacts` and checking whether revenue + balance-sheet data exists.
// Outputs a TypeScript fragment ready to paste into lib/delisted-universe.ts.
//
// Usage: npx tsx scripts/check-delisted.ts

import dns from "node:dns";
import { throttle } from "../lib/rate-limit";

dns.setDefaultResultOrder("ipv4first");

const USER_AGENT =
  process.env.SEC_USER_AGENT || "Stock Screener research@example.com";

// Candidate delisted S&P 500 names. CIKs sourced from SEC EDGAR
// company-search; some are best-guess and need validation.
const CANDIDATES: Array<{
  ticker: string;
  cik: string;
  entityName: string;
  sector: string;
  delistedDate: string;
  reason: string;
}> = [
  // ── 2008 GFC ──
  { ticker: "LEH", cik: "0000806085", entityName: "Lehman Brothers Holdings", sector: "Financials", delistedDate: "2008-09-15", reason: "bankruptcy" },
  { ticker: "BSC", cik: "0000777001", entityName: "Bear Stearns Companies", sector: "Financials", delistedDate: "2008-05-30", reason: "acquired by JPM" },
  { ticker: "WB",  cik: "0000036995", entityName: "Wachovia Corp", sector: "Financials", delistedDate: "2008-12-31", reason: "acquired by WFC" },
  { ticker: "WM",  cik: "0000933136", entityName: "Washington Mutual", sector: "Financials", delistedDate: "2008-09-26", reason: "FDIC receivership" },
  { ticker: "CFC", cik: "0000025191", entityName: "Countrywide Financial", sector: "Financials", delistedDate: "2008-07-01", reason: "acquired by BAC" },
  { ticker: "GM",  cik: "0000040730", entityName: "General Motors (old)", sector: "Consumer Discretionary", delistedDate: "2009-06-01", reason: "Ch.11 bankruptcy" },

  // ── 2010s declining giants / bankruptcies ──
  { ticker: "EK",   cik: "0000031235", entityName: "Eastman Kodak", sector: "Materials", delistedDate: "2012-01-19", reason: "bankruptcy" },
  { ticker: "RAD",  cik: "0000084129", entityName: "Rite Aid", sector: "Consumer Staples", delistedDate: "2023-10-15", reason: "bankruptcy" },
  { ticker: "SHLD", cik: "0001310067", entityName: "Sears Holdings", sector: "Consumer Discretionary", delistedDate: "2018-10-15", reason: "bankruptcy" },
  { ticker: "JCP",  cik: "0001166126", entityName: "J.C. Penney", sector: "Consumer Discretionary", delistedDate: "2020-05-15", reason: "bankruptcy" },
  { ticker: "SUNW", cik: "0000709519", entityName: "Sun Microsystems", sector: "Technology", delistedDate: "2010-01-27", reason: "acquired by ORCL" },
  { ticker: "DELL", cik: "0000826083", entityName: "Dell Inc (old, pre-going-private)", sector: "Technology", delistedDate: "2013-10-29", reason: "taken private" },

  // ── 2010s & 2020s media/retail/consumer ──
  { ticker: "BBY-orig", cik: "0000764478", entityName: "Best Buy (placeholder, still public)", sector: "Consumer Discretionary", delistedDate: "", reason: "still listed" },
  { ticker: "TWX",  cik: "0001105705", entityName: "Time Warner (old)", sector: "Communication Services", delistedDate: "2018-06-14", reason: "acquired by AT&T" },
  { ticker: "BBBY", cik: "0000886158", entityName: "Bed Bath & Beyond", sector: "Consumer Discretionary", delistedDate: "2023-05-03", reason: "bankruptcy" },

  // ── 2023 banking crisis ──
  { ticker: "SIVB", cik: "0000719739", entityName: "SVB Financial Group", sector: "Financials", delistedDate: "2023-03-10", reason: "FDIC receivership" },
  { ticker: "FRC",  cik: "0001132979", entityName: "First Republic Bank", sector: "Financials", delistedDate: "2023-05-01", reason: "FDIC receivership" },
  { ticker: "SBNY", cik: "0001288469", entityName: "Signature Bank", sector: "Financials", delistedDate: "2023-03-12", reason: "FDIC receivership" },

  // ── tech/comm / older ──
  { ticker: "Q",    cik: "0001037949", entityName: "Qwest Communications", sector: "Communication Services", delistedDate: "2011-04-01", reason: "acquired by CenturyLink" },
  { ticker: "EMC",  cik: "0000790070", entityName: "EMC Corp", sector: "Technology", delistedDate: "2016-09-07", reason: "acquired by Dell" },
  { ticker: "MOT",  cik: "0000068505", entityName: "Motorola (old)", sector: "Technology", delistedDate: "2011-01-04", reason: "split into MSI/MMI" },
];

type CompanyFacts = {
  cik?: number;
  entityName?: string;
  facts?: { "us-gaap"?: Record<string, { units: Record<string, any[]> }> };
};

async function probe(cik: string): Promise<{
  ok: boolean;
  status: number;
  entityName?: string;
  hasRevenue: boolean;
  hasEquity: boolean;
  earliestRev?: string;
  latestRev?: string;
}> {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  try {
    const res = await throttle(() =>
      fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      })
    );
    if (!res.ok) {
      return { ok: false, status: res.status, hasRevenue: false, hasEquity: false };
    }
    const data = (await res.json()) as CompanyFacts;
    const gaap = data.facts?.["us-gaap"] ?? {};
    const revTags = [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
      "InterestAndDividendIncomeOperating",
    ];
    const revAll: any[] = [];
    for (const t of revTags) {
      const series = gaap[t]?.units?.USD ?? [];
      for (const e of series) {
        if (e.fp === "FY" && (e.form === "10-K" || e.form === "10-K/A")) {
          revAll.push(e);
        }
      }
    }
    const ends = revAll.map((e) => e.end as string).sort();
    const hasRevenue = revAll.length > 0;
    const equity = gaap["StockholdersEquity"]?.units?.USD ?? [];
    const hasEquity = equity.some(
      (e: any) => e.fp === "FY" && e.form === "10-K"
    );
    return {
      ok: true,
      status: 200,
      entityName: data.entityName,
      hasRevenue,
      hasEquity,
      earliestRev: ends[0],
      latestRev: ends[ends.length - 1],
    };
  } catch (e) {
    return { ok: false, status: -1, hasRevenue: false, hasEquity: false };
  }
}

async function main() {
  console.log(
    `Checking ${CANDIDATES.length} candidate delisted CIKs against EDGAR…\n`
  );
  console.log(
    "Ticker".padEnd(10) +
      "CIK".padEnd(13) +
      "Status".padEnd(8) +
      "Rev".padEnd(5) +
      "Eq".padEnd(4) +
      "EDGAR Name".padEnd(40) +
      "Years"
  );
  console.log("-".repeat(110));
  const results: Array<(typeof CANDIDATES)[number] & {
    ok: boolean;
    hasRevenue: boolean;
    hasEquity: boolean;
    earliestRev?: string;
    latestRev?: string;
    edgarName?: string;
  }> = [];
  for (const c of CANDIDATES) {
    const p = await probe(c.cik);
    results.push({
      ...c,
      ok: p.ok,
      hasRevenue: p.hasRevenue,
      hasEquity: p.hasEquity,
      earliestRev: p.earliestRev,
      latestRev: p.latestRev,
      edgarName: p.entityName,
    });
    console.log(
      c.ticker.padEnd(10) +
        c.cik.padEnd(13) +
        (p.ok ? `${p.status}` : `ERR ${p.status}`).padEnd(8) +
        (p.hasRevenue ? "y" : "n").padEnd(5) +
        (p.hasEquity ? "y" : "n").padEnd(4) +
        (p.entityName ?? c.entityName).slice(0, 38).padEnd(40) +
        (p.earliestRev && p.latestRev ? `${p.earliestRev.slice(0, 4)}→${p.latestRev.slice(0, 4)}` : "—")
    );
  }

  const usable = results.filter((r) => r.ok && r.hasRevenue && r.hasEquity);
  console.log(
    `\n${usable.length}/${results.length} candidates have usable data (rev + equity)`
  );
  console.log("\n=== Usable entries (paste into delisted universe) ===\n");
  for (const r of usable) {
    console.log(
      `  { ticker: "${r.ticker}", cik: "${r.cik}", entityName: "${(r.edgarName ?? r.entityName).replace(/"/g, '\\"')}", sector: "${r.sector}", delistedDate: "${r.delistedDate}", reason: "${r.reason}" },`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
