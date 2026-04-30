import { NextRequest } from "next/server";
import { runScreen, type ThresholdInput } from "@/lib/run-screen";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams;
  const thresholdParam = search.get("threshold") || "avg";
  const tickersParam = search.get("tickers");

  let threshold: ThresholdInput;
  if (thresholdParam === "avg" || thresholdParam === "average") {
    threshold = { kind: "average" };
  } else {
    const v = Number(thresholdParam);
    if (!Number.isFinite(v) || v < 0) {
      return Response.json(
        { error: `invalid threshold: ${thresholdParam}` },
        { status: 400 }
      );
    }
    threshold = { kind: "fixed", value: v };
  }

  const tickers = tickersParam
    ? tickersParam
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  try {
    const result = await runScreen(threshold, tickers);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
