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
   - `fundamentals-v{N}-{TICKER}` — full processed fundamentals object. The
     `v{N}` is `FUNDAMENTALS_CACHE_VERSION` in `lib/edgar.ts` — bump it when
     the `Fundamentals` shape changes so old entries are skipped automatically.
2. **Process-local memo** for `tickerMapCache` only (in `lib/edgar.ts`).

To force a refresh, delete `.cache/` or bump the cache version. The next
request rebuilds.

The cache is keyed on processed output, not raw EDGAR responses — so logic
changes to the GAAP tag merging require a cache flush (or a version bump).

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

## Backtest aggregator

`scripts/backtest-aggregate.ts` replays the screen across every ticker's
full EDGAR history. For each historical (ticker × FY end) where the screen
would have matched (decline + leverage, sector-eligible), it:

1. Resolves the **earliest 10-K filing date** for that period (avoids
   look-ahead bias from later restatements — every entry's `filed`
   timestamp is the most-recent filing by default).
2. Fetches Yahoo monthly bars for the ticker + SPY (cached to
   `.cache/edgar/yahoo-monthly-{TICKER}.json`).
3. Computes 6m / 1y / 2y forward returns, plus alpha vs SPY.

Output: `public/data/backtest.json` with both per-event records (used as
ML training data downstream) and aggregate hit-rate stats by sector / year
/ D/E bucket.

Re-run: `npx tsx scripts/backtest-aggregate.ts`. Takes ~30s on a warm
cache.

## ML model

`scripts/train-model.ts` reads `backtest.json`, builds feature vectors via
`lib/ml-score.ts:buildFeatureVector`, and trains a logistic regression with
L2 regularization. Walk-forward split: events with `endYear < SPLIT_YEAR`
(2020 by default) are training, later events are test. Outputs:
`public/data/ml-model.json` with coefficients, standardization
parameters, and train/test AUC.

`lib/screen.ts:buildRow` loads the persisted model at run time and applies
it **only to declineMatched rows** — the model was trained on screen
triggers exclusively, so applying it to non-triggered names is
out-of-distribution and produces misleading extreme scores (saw NCLH
score 1.000 simply for high D/E with growing revenue).

To retrain after fundamentals change:
```sh
npx tsx scripts/backtest-aggregate.ts && npx tsx scripts/train-model.ts && npm run bake
```

The current model is small (38 train, 24 test events). Test AUC tracks
modestly above random or worse; sector dummies dominate the coefficients.
This is the honest output of the available data — don't try to inflate it
without expanding the universe to include delisted tickers (would address
survivorship bias) or moving to richer features (price action, IV).

## TTM revenue extraction

`lib/edgar.ts:extractTtmRevenue` pairs the most recent 10-Q YTD revenue
with its prior-year same-period comparable to compute trailing-12-month
revenue and partial-year YoY. Mechanics:

- Iterate all entries across `REVENUE_TAGS` (handles ASC-606 transitions).
- Bucket each entry by period length (3, 6, 9, or 12 months); reject other
  durations (transition stubs etc.).
- Among non-FY entries that end after the latest annual, prefer the longest
  YTD bucket (12 → 9 → 6 → 3) for the most precise TTM.
- Match prior year by end date ±7 days, same bucket.
- TTM = `lastAnnual.val + current.val − priorYear.val` (or `current.val`
  directly when the bucket is 12).

Returns `null` when:
- no quarterly entries exist (older filers, 20-F only),
- no prior-year comparable can be found,
- the latest YTD ends on or before the latest annual.

`lib/screen.ts:classifyTtmTrend` consumes `partialYoy` and the latest annual
YoY to set two flags: `ttm_recovering` (YTD ≥ −1%, i.e. flat or growing)
and `ttm_accelerating` (YTD at least 3pp worse than annual). The thresholds
are the constants `TTM_RECOVERING_PCT` and `TTM_ACCELERATING_DELTA` at the
top of `lib/screen.ts`.

## Sector exclusion (empirically removed)

`lib/run-screen.ts:EXCLUDED_SECTORS` is now an empty array. The original
exclusion (Financials, Real Estate, Utilities) was based on the a-priori
argument that D/E means something different in those sectors — which is
true, but doesn't answer the empirical question of whether the screen
*still produces useful signal there*.

Backtest study (run on 2026-05-03) said no:

| Sector       | n  | mean α₁y | hit rate | was excluded? |
|--------------|----|----------|----------|---------------|
| Utilities    | 19 | −7.3%    | 63%      | yes           |
| Real Estate  | 3  | −14.8%   | 67%      | yes           |
| Financials   | 60 | +0.7%    | 40%      | yes           |
| Industrials  | 20 | +6.9%    | 40%      | no            |
| ConsumerDisc | 19 | +10.5%   | 32%      | no            |

Utilities and REITs were *better* than every "included" sector except
Consumer Staples. Financials tracked Industrials/Consumer Discretionary
(no consistency argument). The exclusion was removed; ML model retrained
on the larger 130-event dataset (was 62) — train AUC dropped 0.81 → 0.75
(less overfitting), test AUC essentially unchanged.

The constant stays in code so the infrastructure can be re-armed if a
future study justifies it. The `sectorIneligible` row field also remains;
it's just always false now. To re-arm:

```ts
export const EXCLUDED_SECTORS: ReadonlyArray<Sector> = [
  // add sectors here based on backtest evidence
];
```

`scripts/backtest-aggregate.ts` always includes all sectors in the events
array. It produces two aggregate views — `aggregates` (filters out
EXCLUDED_SECTORS) and `aggregatesIncludingExcluded` (the full universe).
Useful for testing future re-armament hypotheses.

## Known limitations

- **TTM is informational, not a match condition.** Core matching is still
  annual-only. TTM powers the `ttm ↑` / `ttm ↓↓` flags and the optional
  "TTM-confirmed only" UI filter. To make TTM affect the core match, change
  `buildRow` in `lib/screen.ts` (e.g. `matched = matched && !ttmRecovering`).
- **Sector filter is naive.** It uses the static map in `lib/universe.ts`,
  not GICS lookups from EDGAR.
- **No dual-class handling.** GOOG vs GOOGL, FOX vs FOXA — treated as
  separate names. Some duplication possible if both share classes are listed.
- **No CSV export.** Trivial to add: serialize `data.rows` to CSV in the
  client and trigger a download. Mentioned in the original spec as optional.
