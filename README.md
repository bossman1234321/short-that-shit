# Short That Shit

A stock screener that filters S&P 500 names matching **two simultaneous conditions**:

1. **Debt-to-equity above threshold** (universe average by default, or a custom number).
2. **Revenue declining year-over-year for two consecutive years** — strict monotonic
   `Rev_t < Rev_t-1 < Rev_t-2` across the last three reported fiscal years.

**No sector is excluded by default.** An earlier version excluded Financials, Real
Estate, and Utilities a priori on the grounds that D/E means something different in
those sectors. The historical backtest didn't support the exclusion — Utilities
(n=19, hit 63%) and REITs (n=3, hit 67%) were actually *better* short setups than
several included sectors. The empty `EXCLUDED_SECTORS` constant remains as
scaffolding so a future evidence-based exclusion can be re-armed if warranted.

**TTM trend overlay.** The screener also pulls the most recent 10-Q to compute trailing
12-month revenue and a partial-year YoY rate. Two informational flags:
- `ttm ↑` (recovering): annual decline matched but YTD has turned positive — the
  thesis may be expiring. Use the "TTM-confirmed only" toggle to hide these.
- `ttm ↓↓` (accelerating): YTD declining faster than the most recent annual — the
  thesis is strengthening.

**Backtest + ML overlay.** A historical backtest replays the screen across every
ticker's full EDGAR history and computes 1y forward returns vs SPY (`scripts/backtest-aggregate.ts`).
Aggregate hit rates by sector are surfaced in the page footer. A logistic-regression
model is then trained on the historical events with a **walk-forward train/test split**
(train pre-2020, test 2020+) — the model produces an ML score in [0, 1] for current
candidates. Read the train/test AUCs in the footer before trusting the score; a
small dataset means the test AUC is the only number that matters.

**Portfolio simulator.** `scripts/portfolio-sim.ts` evaluates 25+ strategy variants
against a $10,000 starting balance, walking actual Yahoo monthly bars per ticker
to apply stop-loss / take-profit / max-hold logic. Key finding: **naked shorts on
the screen lose money** (mean S&P stocks rise over time). **Pair trades** (short
the matched name, long SPY for the same dollar amount) capture the alpha
predicted by the screen *without* market-direction risk and produce $10K → $18K
over 15 years (+5.3% annualized, 93% win rate, 1.8% max drawdown). The robustness
check (excluding FY2019 events that caught the COVID crash) still produces +4.1%
annualized — the alpha isn't entirely a one-time regime windfall.

**Levers**: D/E threshold (universe-avg / custom), conviction mode (matched / high-only),
sector exclusion (financials/REITs/utilities default-off), TTM-confirmed filter,
**decline duration (1y / 2y / 3y)**, and per-sector filter.

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
