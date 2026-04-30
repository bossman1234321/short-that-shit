import { NextRequest } from "next/server";
import { fetchFundamentals } from "@/lib/edgar";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const ticker = params.ticker.toUpperCase();
  try {
    const f = await fetchFundamentals(ticker);
    if (!f) {
      return Response.json(
        { error: `Could not resolve ticker: ${ticker}` },
        { status: 404 }
      );
    }
    return Response.json(f);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
