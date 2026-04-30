// Pre-bakes the screen result into public/data/screen.json so the deployed
// page renders instantly without hitting EDGAR at request time.
//
// Runs on `npm run build` (via the prebuild hook). Re-uses the disk cache in
// .cache/edgar/ when fresh, so iterative rebuilds are fast.
//
// On Vercel build infra we sometimes see ETIMEDOUT against data.sec.gov — likely
// IP-range throttling or an IPv6 path that hangs. Two mitigations: force the
// IPv4 resolver first, and treat prebuild failure as non-fatal so the deploy
// falls back to whatever screen.json is already committed in the repo.

import dns from "node:dns";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runScreen } from "../lib/run-screen";

dns.setDefaultResultOrder("ipv4first");

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

main().catch(async (e) => {
  // If EDGAR was unreachable during build, keep whatever screen.json is
  // already on disk. The page reads it as-is; the API can re-fetch on demand.
  let existingSize: number | null = null;
  try {
    const stat = await fs.stat(OUT_PATH);
    existingSize = stat.size;
  } catch {
    /* no existing file */
  }
  console.warn("[bake] screen run failed:", e?.message ?? e);
  if (existingSize != null) {
    console.warn(
      `[bake] keeping existing ${OUT_PATH} (${existingSize} bytes) and continuing build.`
    );
    process.exit(0);
  }
  console.warn(
    "[bake] no existing screen.json — page will fall back to live EDGAR fetch on first request."
  );
  process.exit(0);
});
