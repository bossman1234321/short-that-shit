# Short That Shit

A stock screener that filters S&P 500 names matching **two simultaneous conditions**:

1. **Debt-to-equity above threshold** (universe average by default, or a custom number).
2. **Revenue declining year-over-year for two consecutive years** — strict monotonic
   `Rev_t < Rev_t-1 < Rev_t-2` across the last three reported fiscal years.

**Financials, Real Estate (REITs), and Utilities are excluded by default** — D/E is
structurally meaningless as a distress signal in those sectors (bank liabilities are
deposits, REITs are designed to be highly levered, utility capital structures are set
by regulator). Toggle "include excluded sectors" in the UI, or pass
`?includeAllSectors=1` to the API, to override.

**TTM trend overlay.** The screener also pulls the most recent 10-Q to compute trailing
12-month revenue and a partial-year YoY rate. Two informational flags:
- `ttm ↑` (recovering): annual decline matched but YTD has turned positive — the
  thesis may be expiring. Use the "TTM-confirmed only" toggle to hide these.
- `ttm ↓↓` (accelerating): YTD declining faster than the most recent annual — the
  thesis is strengthening.

Data comes from **SEC EDGAR** XBRL company facts. No API key required.

## Stack

- Next.js 14 App Router · TypeScript · Tailwind
- Server-side EDGAR client with disk cache (24h TTL) + token-bucket rate limiter
- Vitest for the screening logic

## Quickstart

```sh
cp .env.example .env.local
# Edit .env.local — set SEC_USER_AGENT to "Your Name your@email.com"
npm install
npm run dev
```

Open `http://localhost:3000`. The first screen run hits EDGAR for ~250 tickers
(throttled at ~8 req/sec, so first paint takes ~30-45s). Subsequent loads serve
from the disk cache and complete in under a second.

### Tests

```sh
npm test
```

### Production build

```sh
npm run build
npm start
```

## API

- `GET /api/screen?threshold=avg|<number>` — runs the screen across the universe.
  - `threshold=avg` (default): use universe-average D/E (eligible sectors only)
  - `threshold=2.5`: any positive number
  - `tickers=AAPL,MSFT,...`: optional override universe
  - `includeAllSectors=1`: include Financials/REITs/Utilities in matching
    and in the threshold average (default off)
- `GET /api/fundamentals/[ticker]` — raw fundamentals for a single ticker.

## Project layout

```
app/
  page.tsx                          server-side screen run
  screen-view.tsx                   client-side filter/sort/threshold UI
  api/screen/route.ts               GET /api/screen
  api/fundamentals/[ticker]/route.ts GET /api/fundamentals/:ticker
  layout.tsx, globals.css           shell + dark research-terminal styling
lib/
  edgar.ts        EDGAR client (ticker map, companyfacts, tag merging)
  screen.ts       D/E + revenue-decline math
  run-screen.ts   parallel universe run + threshold pass
  universe.ts     S&P 500 starter universe (~250 tickers, see HANDOFF.md to expand)
  cache.ts        disk cache with 24h TTL
  rate-limit.ts   token-bucket throttle for EDGAR
  types.ts
scripts/
  verify-tickers.ts   smoke test against INTC, MMM, WBA, AAPL, NVDA
  debug-ticker.ts     introspect raw GAAP tags for a ticker
```

## Caveats (also surfaced in the UI footer)

- **Filing lag.** EDGAR data is whatever has been filed; 10-Ks lag fiscal year-end
  by 60-90 days. A company in active decline may not yet show three years of
  losses in EDGAR.
- **TTM is informational, not a match condition.** The core "matched" flag still
  uses annual revenue only. TTM is shown alongside and powers the optional
  "TTM-confirmed only" filter, plus the `ttm ↑` / `ttm ↓↓` flags.
- **TTM falls back to null** when a ticker has no 10-Q quarterly data on EDGAR
  (older filers, foreign issuers using 20-F only). Affected rows still match on
  annual data but show "—" in the Rev TTM column.
- **Tag transitions.** Pre/post-ASC 606 revenue tags are merged automatically;
  `RevenueFromContractWithCustomerExcludingAssessedTax` is preferred for recent
  data, with `Revenues` and `SalesRevenueNet` as fallbacks.
- **Liabilities derivation.** Many issuers (e.g. Intel) don't file a direct
  `Liabilities` GAAP tag. The screener falls back to
  `LiabilitiesAndStockholdersEquity − StockholdersEquity` when needed.
- **Negative equity** is flagged red and counted as "high leverage" rather than
  producing a negative D/E.
- **Sector exclusion is sector-only**, not company-by-company. A bank with
  unusually weak fundamentals will still be suppressed; toggle "include excluded
  sectors" if you want to evaluate it.
- **Research note, not investment advice.** Do not trade off this output without
  primary-source verification.

## License

Internal research tool. No license granted.
