import { promises as fs } from "node:fs";
import path from "node:path";

// On serverless platforms (Vercel) the project root is read-only. Fall back
// to /tmp, which is writable but ephemeral within a single warm function.
// Local dev and build keep using .cache/edgar/ in cwd.
const DEFAULT_CACHE_DIR =
  process.env.CACHE_DIR ||
  (process.env.VERCEL ? "/tmp/edgar-cache" : ".cache/edgar");

const TTL_MS = 24 * 60 * 60 * 1000;

type Entry<T> = { ts: number; data: T };

function keyToPath(key: string): string {
  const safe = key.replace(/[^a-z0-9._-]/gi, "_");
  return path.resolve(process.cwd(), DEFAULT_CACHE_DIR, `${safe}.json`);
}

export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(keyToPath(key), "utf8");
    const entry = JSON.parse(raw) as Entry<T>;
    if (Date.now() - entry.ts > TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  const file = keyToPath(key);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const entry: Entry<T> = { ts: Date.now(), data };
    await fs.writeFile(file, JSON.stringify(entry), "utf8");
  } catch {
    // Read-only filesystem (e.g. unexpected Vercel path) — silently skip.
  }
}
