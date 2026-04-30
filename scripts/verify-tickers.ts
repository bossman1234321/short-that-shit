import { fetchFundamentals } from "../lib/edgar";
import { buildRow, universeAverageDE } from "../lib/screen";
import type { ScreenRow } from "../lib/types";

const TICKERS = ["INTC", "MMM", "WBA", "AAPL", "NVDA"];

function fmt(n: number | null, digits = 2): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function pct(n: number | null): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const fundamentals = [];
  for (const t of TICKERS) {
    process.stdout.write(`Fetching ${t}... `);
    const f = await fetchFundamentals(t);
    if (!f) {
      console.log("NOT FOUND");
      continue;
    }
    fundamentals.push(f);
    console.log(
      `OK (${f.entityName}, ${f.revenue.length}y revenue, eq=${fmt(
        f.stockholdersEquity?.val ?? null,
        0
      )})`
    );
  }

  // First pass: build rows with placeholder threshold (0) just to compute D/E
  const placeholderRows = fundamentals.map((f) => buildRow(f, 0));
  const avgDE = universeAverageDE(placeholderRows);
  console.log(`\nUniverse avg D/E (this 5-name slice): ${fmt(avgDE)}\n`);

  // Real screen against the universe average
  const rows: ScreenRow[] = fundamentals.map((f) => buildRow(f, avgDE));

  console.log(
    "Ticker  D/E       Rev T-2 → T-1 → T (USD bn)               YoY1     YoY2     decline lev match flags"
  );
  console.log(
    "------  --------  -----------------------------------------  -------  -------  ------- --- ----- -----"
  );
  for (const r of rows) {
    const rT = r.rev_t != null ? (r.rev_t / 1e9).toFixed(1) : "—";
    const rT1 = r.rev_t1 != null ? (r.rev_t1 / 1e9).toFixed(1) : "—";
    const rT2 = r.rev_t2 != null ? (r.rev_t2 / 1e9).toFixed(1) : "—";
    console.log(
      `${r.ticker.padEnd(6)}  ${fmt(r.debtToEquity).padEnd(8)}  ${rT2.padStart(
        6
      )} (${r.rev_t2_end ?? "—"}) → ${rT1.padStart(6)} (${
        r.rev_t1_end ?? "—"
      }) → ${rT.padStart(6)} (${r.rev_t_end ?? "—"})  ${pct(r.yoy_t1).padEnd(
        7
      )}  ${pct(r.yoy_t).padEnd(7)}  ${String(r.declineMatched).padEnd(7)} ${
        r.leverageMatched ? "Y" : "n"
      }   ${r.matched ? "MATCH" : "    -"} ${r.flags.join(",")}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
