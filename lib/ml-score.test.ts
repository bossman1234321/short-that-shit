import { describe, it, expect } from "vitest";
import {
  buildFeatureVector,
  computeAuc,
  ML_NUMERIC_FEATURES,
  ML_SECTORS,
  scoreFeatures,
  sigmoid,
  standardize,
  trainLogReg,
  type ModelWeights,
} from "./ml-score";

describe("sigmoid", () => {
  it("maps 0 → 0.5", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5);
  });
  it("monotonically increasing in x", () => {
    expect(sigmoid(1) > sigmoid(0)).toBe(true);
    expect(sigmoid(0) > sigmoid(-1)).toBe(true);
  });
  it("numerically stable for large negatives", () => {
    expect(sigmoid(-100)).toBeGreaterThanOrEqual(0);
    expect(sigmoid(100)).toBeLessThanOrEqual(1);
  });
});

describe("buildFeatureVector", () => {
  it("returns null when required numeric feature is missing", () => {
    expect(
      buildFeatureVector({
        de: 2,
        negEquity: false,
        yoy_t: null, // missing
        yoy_t1: -0.05,
        ocfYoY: -0.1,
        ocfDecline2y: false,
        sector: "Industrials",
      })
    ).toBeNull();
  });

  it("encodes negative equity as log_de_or_neg=-1", () => {
    const v = buildFeatureVector({
      de: null,
      negEquity: true,
      yoy_t: -0.05,
      yoy_t1: -0.05,
      ocfYoY: -0.05,
      ocfDecline2y: false,
      sector: "Technology",
    });
    expect(v).not.toBeNull();
    expect(v![0]).toBe(-1);
    // neg_eq is index 2 in the expanded feature order (post-2026-05-03).
    const negEqIdx = ML_NUMERIC_FEATURES.indexOf("neg_eq");
    expect(v![negEqIdx]).toBe(1);
  });

  it("emits one-hot for the matching sector only", () => {
    const v = buildFeatureVector({
      de: 2,
      negEquity: false,
      yoy_t: -0.05,
      yoy_t1: -0.05,
      ocfYoY: -0.05,
      ocfDecline2y: false,
      sector: "Consumer Staples",
    })!;
    const oneHot = v.slice(ML_NUMERIC_FEATURES.length);
    const idx = ML_SECTORS.indexOf("Consumer Staples");
    for (let i = 0; i < oneHot.length; i++) {
      expect(oneHot[i]).toBe(i === idx ? 1 : 0);
    }
  });
});

describe("standardize", () => {
  it("returns mean=0 and std=1 for an empty input", () => {
    const r = standardize([]);
    expect(r.mean).toBe(0);
    expect(r.std).toBe(1);
    expect(r.z).toEqual([]);
  });

  it("standardizes to mean 0 stdev 1", () => {
    const r = standardize([1, 2, 3, 4, 5]);
    expect(r.mean).toBeCloseTo(3);
    expect(r.std).toBeGreaterThan(0);
    const zMean = r.z.reduce((a, b) => a + b, 0) / r.z.length;
    expect(zMean).toBeCloseTo(0);
  });
});

describe("trainLogReg", () => {
  it("learns a simple linearly-separable problem", () => {
    // x=1 → 1, x=-1 → 0
    const X = [[1], [1], [1], [-1], [-1], [-1]];
    const y = [1, 1, 1, 0, 0, 0];
    const { coefs } = trainLogReg(X, y, { l2: 0, lr: 0.5, iters: 500 });
    // First coef should be strongly positive
    expect(coefs[0]).toBeGreaterThan(1);
    // Bias near zero (centered problem)
    expect(Math.abs(coefs[1])).toBeLessThan(0.5);
  });
});

describe("computeAuc", () => {
  it("returns 1 for perfect ranking", () => {
    expect(computeAuc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
  });
  it("returns 0 for inverted ranking", () => {
    expect(computeAuc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
  });
  it("returns 0.5 when pos and neg are interleaved evenly", () => {
    // Sorted-by-score: (0.3,1) (0.4,0) (0.6,0) (0.7,1)
    // sumPosRanks = 1+4 = 5; U = 5 - 3 = 2; AUC = 2/(2*2) = 0.5
    expect(computeAuc([0.3, 0.4, 0.6, 0.7], [1, 0, 0, 1])).toBe(0.5);
  });
  it("handles ties gracefully", () => {
    // Two pairs of ties; with one pos and one neg in each pair AUC = 0.5
    expect(computeAuc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBe(0.5);
  });
  it("returns 0.5 when all labels are same class", () => {
    expect(computeAuc([0.1, 0.2, 0.3], [1, 1, 1])).toBe(0.5);
  });
});

describe("scoreFeatures", () => {
  function fakeModel(coefs: number[]): ModelWeights {
    return {
      features: ["a", "b", "bias"],
      numericMeans: [0, 0],
      numericStds: [1, 1],
      coefs,
      trainSize: 0,
      testSize: 0,
      trainAuc: 0.5,
      testAuc: 0.5,
      trainSplitYearLt: 2020,
      trainedAt: "2026-01-01T00:00:00Z",
      positiveLabelDef: "test",
      notes: "",
    };
  }

  it("returns 0.5 with zero coefficients and zero bias", () => {
    expect(scoreFeatures([0, 0], fakeModel([0, 0, 0]))).toBeCloseTo(0.5);
  });

  it("returns sigmoid(bias) when features are at the standardization mean", () => {
    expect(scoreFeatures([0, 0], fakeModel([0, 0, 1]))).toBeCloseTo(sigmoid(1));
  });

  it("returns 0.5 when feature length doesn't match (guard)", () => {
    // model expects 2 features + bias; feed 3
    expect(scoreFeatures([0, 0, 0], fakeModel([0, 0, 0]))).toBe(0.5);
  });
});
