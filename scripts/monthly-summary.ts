// Monthly refresh summary → Telegram.
//
// Run AFTER backtest-aggregate, train-model, and bake have written their
// outputs. This script:
//
//   1. Loads the prior snapshot from .cache/monthly-snapshot.json (if any).
//   2. Loads current screen.json + portfolio-sim.json + ml-model.json.
//   3. Computes diff: new triggers, removed triggers, AUC delta, headline
//      P&L delta, universe size delta.
//   4. Sends a single Telegram summary message.
//   5. Writes the current state back to .cache/monthly-snapshot.json so
//      next month's run has a baseline.
//
// Designed to no-op gracefully if any file is missing — first run just
// captures the baseline.

import { promises as fs } from "node:fs";
import path from "node:path";
import { notify } from "../lib/notify";
import type { ScreenResult, MlMetadata, PortfolioSummary } from "../lib/types";

const SITE_URL = process.env.SITE_URL ?? "https://short-that-shit.vercel.app";
const SNAPSHOT_PATH = path.resolve(
  process.cwd(),
  ".cache",
  "monthly-snapshot.json"
);

type Snapshot = {
  capturedAt: string;
  matchedTickers: string[];
  highConvictionTickers: string[];
  universeSize: number;
  mlTestAuc: number | null;
  headlineFinalEquity: number | null;
  headlineAnnualized: number | null;
};

function buildSnapshot(
  screen: ScreenResult,
  portfolio: PortfolioSummary | null,
  ml: MlMetadata | null
): Snapshot {
  return {
    capturedAt: new Date().toISOString(),
    matchedTickers: screen.rows.filter((r) => r.matched).map((r) => r.ticker).sort(),
    highConvictionTickers: screen.rows
      .filter((r) => r.highConvictionMatched)
      .map((r) => r.ticker)
      .sort(),
    universeSize: screen.universeSize,
    mlTestAuc: ml?.testAuc ?? null,
    headlineFinalEquity: portfolio?.bestByEquity?.finalEquity ?? null,
    headlineAnnualized: portfolio?.bestByEquity?.annualizedReturn ?? null,
  };
}

function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x == null || !isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtUsd(x: number | null | undefined): string {
  if (x == null || !isFinite(x)) return "n/a";
  return `$${Math.round(x).toLocaleString()}`;
}

function diffSets(prev: string[], cur: string[]): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev);
  const curSet = new Set(cur);
  return {
    added: cur.filter((t) => !prevSet.has(t)),
    removed: prev.filter((t) => !curSet.has(t)),
  };
}

async function loadJson<T>(rel: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path.resolve(process.cwd(), rel), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function main() {
  const screen = await loadJson<ScreenResult>("public/data/screen.json");
  if (!screen) {
    console.error("[monthly-summary] screen.json not found; aborting.");
    process.exit(1);
  }
  const portfolio = await loadJson<{ generatedAt: string; bestByEquity?: PortfolioSummary["bestByEquity"] }>(
    "public/data/portfolio-sim.json"
  );
  const ml = await loadJson<MlMetadata>("public/data/ml-model.json");

  const cur = buildSnapshot(screen, (portfolio as any) ?? null, ml);
  const prev = await loadJson<Snapshot>(".cache/monthly-snapshot.json");

  let body: string;
  if (!prev) {
    body =
      `🌱 *Monthly refresh — first snapshot*\n` +
      `Universe: ${cur.universeSize} · matched: ${cur.matchedTickers.length} (${cur.highConvictionTickers.length} high-conv)\n` +
      `ML test AUC: ${cur.mlTestAuc?.toFixed(3) ?? "n/a"}\n` +
      `Headline backtest: ${fmtUsd(cur.headlineFinalEquity)} (ann ${fmtPct(cur.headlineAnnualized)})\n` +
      `[Open dashboard](${SITE_URL})`;
  } else {
    const { added, removed } = diffSets(prev.matchedTickers, cur.matchedTickers);
    const aucDelta =
      cur.mlTestAuc != null && prev.mlTestAuc != null
        ? cur.mlTestAuc - prev.mlTestAuc
        : null;
    const equityDelta =
      cur.headlineFinalEquity != null && prev.headlineFinalEquity != null
        ? cur.headlineFinalEquity - prev.headlineFinalEquity
        : null;

    const lines: string[] = [];
    lines.push(`🔄 *Monthly refresh complete*`);
    lines.push(
      `Universe: ${cur.universeSize} (${cur.universeSize - prev.universeSize >= 0 ? "+" : ""}${cur.universeSize - prev.universeSize})`
    );
    lines.push(
      `Matched: ${cur.matchedTickers.length} (${cur.matchedTickers.length - prev.matchedTickers.length >= 0 ? "+" : ""}${cur.matchedTickers.length - prev.matchedTickers.length})`
    );
    if (added.length) lines.push(`  ➕ added: ${added.join(", ")}`);
    if (removed.length) lines.push(`  ➖ removed: ${removed.join(", ")}`);
    lines.push(
      `ML AUC: ${cur.mlTestAuc?.toFixed(3) ?? "n/a"}` +
        (aucDelta != null ? ` (Δ ${aucDelta >= 0 ? "+" : ""}${aucDelta.toFixed(3)})` : "")
    );
    lines.push(
      `Headline equity: ${fmtUsd(cur.headlineFinalEquity)}` +
        (equityDelta != null ? ` (Δ ${equityDelta >= 0 ? "+" : ""}${fmtUsd(equityDelta)})` : "") +
        ` · ann ${fmtPct(cur.headlineAnnualized)}`
    );
    lines.push(`[Open dashboard](${SITE_URL})`);
    body = lines.join("\n");
  }

  console.log(body);
  await notify(body);

  await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  await fs.writeFile(SNAPSHOT_PATH, JSON.stringify(cur, null, 2) + "\n", "utf8");
  console.log(`[monthly-summary] snapshot written to ${SNAPSHOT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
