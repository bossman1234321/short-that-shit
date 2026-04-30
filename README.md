# Short That Shit

A stock screener that filters S&P 500 names matching **two simultaneous conditions**:

1. **Debt-to-equity above threshold** (universe average by default, or a custom number).
2. **Revenue declining year-over-year for two consecutive years** — strict monotonic
   `Rev_t < Rev_t-1 < Rev_t-2` across the last three reported fiscal years.

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
  - `threshold=avg` (default): use universe-average D/E
  - `threshold=2.5`: any positive number
  - `tickers=AAPL,MSFT,...`: optional override universe
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
- **Annual only.** TTM revenue is not used. Companies with off-calendar fiscal
  years (e.g. AAPL ends in late September) will show data shifted from
  calendar-year peers.
- **Tag transitions.** Pre/post-ASC 606 revenue tags are merged automatically;
  `RevenueFromContractWithCustomerExcludingAssessedTax` is preferred for recent
  data, with `Revenues` and `SalesRevenueNet` as fallbacks.
- **Liabilities derivation.** Many issuers (e.g. Intel) don't file a direct
  `Liabilities` GAAP tag. The screener falls back to
  `LiabilitiesAndStockholdersEquity − StockholdersEquity` when needed.
- **Negative equity** is flagged red and counted as "high leverage" rather than
  producing a negative D/E.
- **Research note, not investment advice.** Do not trade off this output without
  primary-source verification.

## License

Internal research tool. No license granted.
