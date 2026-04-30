// Debug a single ticker's raw EDGAR companyfacts.
import { resolveCIK, loadTickerMap } from "../lib/edgar";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: debug-ticker.ts TICKER");
    process.exit(1);
  }

  const map = await loadTickerMap();
  const candidates = Object.keys(map).filter((t) => t.includes(arg.toUpperCase()));
  console.log(`Tickers containing "${arg}":`, candidates.slice(0, 10));

  const resolved = await resolveCIK(arg);
  if (!resolved) {
    console.log("Could not resolve. Exiting.");
    return;
  }
  console.log("Resolved:", resolved);

  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${resolved.cik}.json`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        process.env.SEC_USER_AGENT || "Stock Screener research@example.com",
    },
  });
  const data = (await res.json()) as any;
  const gaap = data.facts?.["us-gaap"] ?? {};

  // List candidate revenue tags and their date ranges
  const revTags = Object.keys(gaap).filter((k) => /revenue|sales/i.test(k));
  console.log("\nRevenue-like tags:");
  for (const t of revTags) {
    const series = gaap[t]?.units?.USD;
    if (!series) continue;
    const annual = series.filter(
      (e: any) => e.form === "10-K" && (e.fp === "FY" || !e.fp)
    );
    if (annual.length === 0) continue;
    const ends = annual.map((e: any) => e.end).sort();
    console.log(
      `  ${t}: ${annual.length} annual entries, ${ends[0]} → ${ends[ends.length - 1]}`
    );
  }

  // List candidate balance-sheet tags
  const bsTags = Object.keys(gaap).filter((k) => /liabilit|stockholders|equity/i.test(k));
  console.log("\nBalance-sheet-like tags:");
  for (const t of bsTags) {
    const series = gaap[t]?.units?.USD;
    if (!series) continue;
    const annual = series.filter(
      (e: any) => e.form === "10-K" && (e.fp === "FY" || !e.fp)
    );
    if (annual.length === 0) continue;
    const ends = annual.map((e: any) => e.end).sort();
    console.log(
      `  ${t}: ${annual.length} annual entries, ${ends[0]} → ${ends[ends.length - 1]}`
    );
  }
}

main().catch(console.error);
