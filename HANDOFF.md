# Handoff

Operational notes for the next person picking this up.

## EDGAR rate limit

SEC EDGAR allows ~10 requests/second per IP. We throttle at ~8 req/s
(`MIN_SPACING_MS = 120` in [lib/rate-limit.ts](lib/rate-limit.ts)) with a
shared promise chain. Going faster gets you 429s and a temporary IP block.

EDGAR also **requires** a `User-Agent` header identifying the requester.
Set `SEC_USER_AGENT` in `.env.local` to something like
`"Your Name your@email.com"`. Generic strings like `"Mozilla/5.0"` will be
rejected. See `lib/edgar.ts:fetchJson`.

## Cache strategy

Two-layer cache, both in `lib/cache.ts`:

1. **Disk cache** (`.cache/edgar/*.json`), 24h TTL. Keys:
   - `ticker-map` — the company_tickers.json lookup
   - `fundamentals-{TICKER}` — full processed fundamentals object
2. **Process-local memo** for `tickerMapCache` only (in `lib/edgar.ts`).

To force a refresh, delete `.cache/`. The next request rebuilds.

The cache is keyed on processed output, not raw EDGAR responses — so logic
changes to the GAAP tag merging require a cache flush.

## Extending the universe

[lib/universe.ts](lib/universe.ts) ships ~250 S&P 500 names. To expand to the
full 500 (or to Russell 1000):

1. Pull a current list — e.g. `https://www.slickcharts.com/sp500` or the
   official S&P methodology PDF — and replace `SP500_UNIVERSE`. Tickers must
   be in EDGAR's preferred form (no dots — `BRKB` not `BRK.B`, `BFB` not
   `BF.B`). Cross-check against `https://www.sec.gov/files/company_tickers.json`.
2. The `Sector` enum covers all 11 GICS sectors. Any new ticker needs one
   assigned for the sector filter to work.
3. Bump `CONCURRENCY` in `lib/run-screen.ts` cautiously — the rate limiter is
   the real ceiling, not concurrency. 6 workers is fine; more saturates the
   token bucket and adds no throughput.

For the Russell 1000 you'll cross 1000 EDGAR fetches on a cold cache. At
8 req/s that's ~2 minutes for the first run. Subsequent runs are cache-served.

## Tickers absent from the active map

Some tickers (de-listed, de-registered, acquired) aren't in
`company_tickers.json`. Examples: WBA (acquired by Sycamore Partners 2025).
EDGAR's `companyfacts` endpoint still serves their CIKs.

Add manual overrides to `CIK_OVERRIDES` in [lib/edgar.ts](lib/edgar.ts):

```ts
const CIK_OVERRIDES: Record<string, { cik: string; entityName: string }> = {
  WBA: { cik: "0001618921", entityName: "WALGREENS BOOTS ALLIANCE, INC." },
};
```

CIKs can be looked up via the EDGAR full-text search UI.

## GAAP tag selection — gotchas

The screener resolves three numbers per company. Each has tag fallbacks:

### Revenue

Order tried (first match drives the merge — but see below):

1. `RevenueFromContractWithCustomerExcludingAssessedTax` (post-ASC 606, modern)
2. `RevenueFromContractWithCustomerIncludingAssessedTax`
3. `Revenues`
4. `SalesRevenueNet` (pre-ASC 606)
5. `SalesRevenueGoodsNet`

`mergeAnnualSeries` actually unions across **all** of these and dedupes by
fiscal year, preferring the most recent filing. This avoids the trap where
`Revenues` has a few stale entries (2016-2018) and the rest of the history
lives in `RevenueFromContractWithCustomer*`.

### Liabilities

1. `Liabilities` (preferred, when filed)
2. **Derived:** `LiabilitiesAndStockholdersEquity − StockholdersEquity` (matched by FY)

The derivation step is critical — many large issuers (Intel, others) only
report total assets on the balance sheet without a `Liabilities` line item.

### Stockholders Equity

1. `StockholdersEquity`
2. `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`

Negative equity is detected and flagged separately rather than producing a
negative D/E ratio.

## Debugging a single ticker

```sh
npx tsx scripts/debug-ticker.ts INTC
```

Prints all revenue-like and balance-sheet-like GAAP tags with date ranges.
Use this when a ticker is missing data or behaving unexpectedly.

For the smoke test against the named tickers:

```sh
npx tsx scripts/verify-tickers.ts
```

## Polygon fallback (not implemented)

The `.env.example` reserves `POLYGON_API_KEY` for a fallback to Polygon's
`/vX/reference/financials` endpoint when EDGAR rate-limits. If/when you wire
this up, the natural seam is `lib/edgar.ts:fetchFundamentals` — wrap the
EDGAR call in a try/catch on `429` and fall through to a Polygon adapter
that produces the same `Fundamentals` shape. Keep the cache key the same so
both sources share one cache.

## Known limitations

- **TTM revenue not used.** Annual figures only. A company with three
  declining annuals but a recovering TTM won't be caught as "recovering."
- **Sector filter is naive.** It uses the static map in `lib/universe.ts`,
  not GICS lookups from EDGAR.
- **No dual-class handling.** GOOG vs GOOGL, FOX vs FOXA — treated as
  separate names. Some duplication possible if both share classes are listed.
- **No CSV export.** Trivial to add: serialize `data.rows` to CSV in the
  client and trigger a download. Mentioned in the original spec as optional.
