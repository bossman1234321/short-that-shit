// Trains the ML short-conviction model on the historical events emitted
// by scripts/backtest-aggregate.ts. Walk-forward validation: train on
// events with endYear < SPLIT_YEAR, test on events with endYear >= SPLIT_YEAR.
// Output: public/data/ml-model.json (loaded by lib/screen.ts at run time).
//
// Honest about constraints:
//   - Tiny dataset (low triple-digit events). Confidence intervals on
//     per-coefficient values are wide.
//   - Walk-forward AUC is the only number to trust; train AUC will be
//     optimistic.
//   - Linear in features → no interactions captured. The hand-coded
//     log_de_or_neg is the only nonlinearity.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildFeatureVector,
  computeAuc,
  ML_NUMERIC_FEATURES,
  ML_SECTORS,
  scoreFeatures,
  standardize,
  trainLogReg,
  type ModelWeights,
} from "../lib/ml-score";
import type { Sector } from "../lib/universe";

const SPLIT_YEAR = 2020; // events strictly before this train; >= test
const POSITIVE_LABEL_THRESHOLD = -0.05; // alpha1y < -5% → "short worked"
const BACKTEST_PATH = path.resolve(process.cwd(), "public/data/backtest.json");
const MODEL_PATH = path.resolve(process.cwd(), "public/data/ml-model.json");

// Permissive — the full event shape now has 30+ fields. buildFeatureVector
// reads what it needs and ignores the rest.
type BacktestEvent = any;

async function main() {
  const raw = await fs.readFile(BACKTEST_PATH, "utf8");
  const data = JSON.parse(raw) as { events: BacktestEvent[] };

  // Filter to events with α1y resolved and a buildable feature vector.
  const ready = data.events.filter((e) => {
    if (e.alpha1y == null || !Number.isFinite(e.alpha1y)) return false;
    return buildFeatureVector(e) != null;
  });

  console.log(
    `[train-model] ${ready.length}/${data.events.length} events have α1y + features`
  );

  const train = ready.filter((e) => e.endYear < SPLIT_YEAR);
  const test = ready.filter((e) => e.endYear >= SPLIT_YEAR);
  console.log(
    `[train-model] train (endYear < ${SPLIT_YEAR}): ${train.length}, test: ${test.length}`
  );
  if (train.length < 20 || test.length < 5) {
    console.error("Not enough data for a meaningful walk-forward split.");
    process.exit(1);
  }

  // Build X (raw, pre-standardization), y
  const Xtrain_raw = train.map((e) => buildFeatureVector(e)!);
  const ytrain = train.map((e) =>
    e.alpha1y! < POSITIVE_LABEL_THRESHOLD ? 1 : 0
  );
  const Xtest_raw = test.map((e) => buildFeatureVector(e)!);
  const ytest = test.map((e) =>
    e.alpha1y! < POSITIVE_LABEL_THRESHOLD ? 1 : 0
  );

  const numericLen = ML_NUMERIC_FEATURES.length;
  const totalDim = Xtrain_raw[0].length;
  const sectorLen = totalDim - numericLen;

  // Standardize numeric columns only; one-hot stays in {0,1}.
  const numericMeans: number[] = [];
  const numericStds: number[] = [];
  const Xtrain = Xtrain_raw.map((row) => row.slice()); // deep copy
  const Xtest = Xtest_raw.map((row) => row.slice());
  for (let i = 0; i < numericLen; i++) {
    const col = Xtrain.map((r) => r[i]);
    const { mean, std } = standardize(col);
    numericMeans.push(mean);
    numericStds.push(std);
    for (const r of Xtrain) r[i] = (r[i] - mean) / (std || 1);
    for (const r of Xtest) r[i] = (r[i] - mean) / (std || 1); // test uses train stats
  }

  // Don't regularize the bias (handled separately) but DO regularize sector
  // one-hots — they're underdetermined with so few events per sector.
  const regIdx = Array.from({ length: totalDim }, (_, i) => i);

  const { coefs } = trainLogReg(Xtrain, ytrain, {
    l2: 0.1,
    lr: 0.3,
    iters: 1500,
    onlyRegularizeIdx: regIdx,
  });

  const featureNames = [
    ...ML_NUMERIC_FEATURES,
    ...ML_SECTORS.map((s) => `sector_${s.replace(/\s+/g, "_")}`),
    "bias",
  ];

  const model: ModelWeights = {
    features: featureNames,
    numericMeans,
    numericStds,
    coefs,
    trainSize: train.length,
    testSize: test.length,
    trainAuc: 0,
    testAuc: 0,
    trainSplitYearLt: SPLIT_YEAR,
    trainedAt: new Date().toISOString(),
    positiveLabelDef: `alpha1y < ${POSITIVE_LABEL_THRESHOLD}`,
    notes:
      "Logistic regression, L2=0.1, walk-forward split. Treat score as ranking signal, not calibrated probability.",
  };

  // AUCs (use raw, un-standardized features — scoreFeatures restandardizes)
  const trainScores = Xtrain_raw.map((f) => scoreFeatures(f, model));
  const testScores = Xtest_raw.map((f) => scoreFeatures(f, model));
  model.trainAuc = computeAuc(trainScores, ytrain);
  model.testAuc = computeAuc(testScores, ytest);

  console.log(
    `[train-model] train AUC=${model.trainAuc.toFixed(3)}  test AUC=${model.testAuc.toFixed(3)}`
  );
  console.log("[train-model] coefficients (largest |w| first):");
  const ranked = featureNames
    .slice(0, -1)
    .map((name, i) => ({ name, w: coefs[i] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  for (const r of ranked) {
    console.log(`  ${r.name.padEnd(32)} ${r.w >= 0 ? "+" : ""}${r.w.toFixed(3)}`);
  }
  console.log(`  ${"bias".padEnd(32)} ${coefs[coefs.length - 1].toFixed(3)}`);

  await fs.mkdir(path.dirname(MODEL_PATH), { recursive: true });
  await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2), "utf8");
  console.log(`[train-model] wrote ${MODEL_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
