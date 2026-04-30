// Token-bucket-ish gate. EDGAR allows ~10 req/sec; we stay below that
// by serializing through a shared promise chain with a minimum spacing.

const MIN_SPACING_MS = 120;
let lastFire = 0;
let chain: Promise<void> = Promise.resolve();

export function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const wait = Math.max(0, lastFire + MIN_SPACING_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFire = Date.now();
  });
  chain = next.catch(() => undefined);
  return next.then(fn);
}
