import { promises as fs } from "node:fs";
import path from "node:path";
import { runScreen } from "@/lib/run-screen";
import type { ScreenResult } from "@/lib/types";
import { ScreenView } from "./screen-view";

export const dynamic = "force-static";
export const revalidate = false;

async function loadBakedScreen(): Promise<ScreenResult | null> {
  try {
    const file = path.resolve(process.cwd(), "public/data/screen.json");
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as ScreenResult;
  } catch {
    return null;
  }
}

export default async function Home() {
  const baked = await loadBakedScreen();
  const result = baked ?? (await runScreen({ kind: "average" }));
  return <ScreenView initial={result} />;
}
