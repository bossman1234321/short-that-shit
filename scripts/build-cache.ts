// Pre-bakes the screen result into public/data/screen.json so the deployed
// page renders instantly without hitting EDGAR at request time.
//
// Runs on `npm run build` (via the prebuild hook). Re-uses the disk cache in
// .cache/edgar/ when fresh, so iterative rebuilds are fast.

import { promises as fs } from "node:fs";
import path from "node:path";
import { runScreen } from "../lib/run-screen";

const OUT_PATH = path.resolve(process.cwd(), "public/data/screen.json");

async function main() {
  console.log(`[bake] running universe screen...`);
  const start = Date.now();
  const result = await runScreen({ kind: "average" });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(result), "utf8");

  console.log(
    `[bake] wrote ${OUT_PATH} — ${result.universeSize} tickers, ` +
      `${result.matchedCount} matched, threshold ${result.threshold.value.toFixed(2)}, ` +
      `cache ${result.cacheHits}H / ${result.cacheMisses}M, ${elapsed}s`
  );
}

main().catch((e) => {
  console.error("[bake] failed:", e);
  process.exit(1);
});
