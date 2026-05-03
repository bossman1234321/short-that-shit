import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelWeights } from "@/lib/ml-score";
import { BacktestReview } from "./backtest-view";

export const dynamic = "force-static";
export const revalidate = false;

type BacktestEvent = {
  ticker: string;
  sector: string;
  endYear: number;
  end: string;
  filed: string;
  de: number | null;
  negEquity: boolean;
  yoy_t: number | null;
  yoy_t1: number | null;
  ocfYoY: number | null;
  ocfDecline2y: boolean;
  ret6m: number | null;
  ret1y: number | null;
  ret2y: number | null;
  alpha6m: number | null;
  alpha1y: number | null;
  alpha2y: number | null;
  spy1y: number | null;
};

type BacktestFile = {
  generatedAt: string;
  triggerCount: number;
  triggerCountAllSectors: number;
  excludedSectors: string[];
  aggregates: {
    overall: SectorStat;
    bySector: Record<string, SectorStat>;
    byDeBucket: Record<string, SectorStat>;
    byYear: Record<string, SectorStat>;
  };
  events: BacktestEvent[];
};

type SectorStat = {
  count: number;
  meanAlpha1y: number | null;
  medianAlpha1y: number | null;
  hitRate: number | null;
  hitRateBigMiss: number | null;
};

type PortfolioFile = {
  generatedAt: string;
  startingBalance: number;
  annualBorrowCost: number;
  results: Array<{
    name: string;
    description: string;
    config: {
      positionSize: number;
      maxConcurrent: number;
      holdMonths: number;
      stopLossPct: number | null;
      takeProfitPct: number | null;
    };
    nFiltered: number;
    nTaken: number;
    nWon: number;
    nStoppedOut: number;
    nTakeProfit: number;
    finalEquity: number;
    totalReturn: number;
    annualizedReturn: number | null;
    winRate: number;
    meanPnLPerPos: number;
    maxDrawdown: number;
  }>;
};

async function loadJson<T>(rel: string): Promise<T | null> {
  try {
    const file = path.resolve(process.cwd(), rel);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export default async function BacktestPage() {
  const [backtest, portfolio, model] = await Promise.all([
    loadJson<BacktestFile>("public/data/backtest.json"),
    loadJson<PortfolioFile>("public/data/portfolio-sim.json"),
    loadJson<ModelWeights>("public/data/ml-model.json"),
  ]);

  return (
    <BacktestReview
      backtest={backtest}
      portfolio={portfolio}
      model={model}
    />
  );
}
