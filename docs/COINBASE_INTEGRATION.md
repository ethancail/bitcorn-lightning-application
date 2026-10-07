# Coinbase Onramp Integration

The "Fund Node via Coinbase" feature lets operators buy bitcoin directly into their node's on-chain wallet.

**Historical note:** An earlier design for this doc described an OAuth2 flow with buy + send. That approach was abandoned. The shipped integration uses Coinbase Onramp with a server-signed session token.

## Why a Cloudflare Worker?

Coinbase Onramp requires a **server-side session token** (Secure Initialization is enabled on the CDP project). CDP credentials (private key) cannot live in the public repo or on user nodes — a **Cloudflare Worker** holds them securely and mints session tokens on demand. All member installs share the same Worker.

## Flow

```
FundNodePanel (browser)
  → GET /api/coinbase/onramp-url (API container)
    → src/api/coinbase-onramp.ts
      → POST https://bitcorn-onramp.ethancail.workers.dev  (Cloudflare Worker)
        → signs ES256 JWT with CDP private key
        → POST https://api.developer.coinbase.com/onramp/v1/token
        → returns { sessionToken }
    → builds https://pay.coinbase.com/buy/select-asset?appId=...&sessionToken=...
  → window.open(url, '_blank', 'noopener,noreferrer')
```

## Cloudflare Worker

- Source: `cloudflare-worker/src/index.ts`
- Deployed at: `https://bitcorn-onramp.ethancail.workers.dev`

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/` | Coinbase Onramp — accepts `{ address }` → returns `{ sessionToken }` |
| GET | `/prices` | Live commodity futures prices (gold, corn, soybeans, wheat), cached 10 min in KV |
| GET | `/prices/corn-history` | Historical monthly corn PRICE RECEIVED from USDA NASS (2014+), cached 24h in KV |
| GET | `/recommended-peers` | Curated external peer list |
| GET | `/treasury-info` | Treasury node connection info (member auto-connect) |
| GET | `/valuation/current` | Latest composite Z-score + zone |
| GET | `/valuation/history` | Daily composite history series |
| GET | `/valuation/inputs` | Per-input snapshot map |
| POST | `/valuation/manual` | Treasury-signed manual metric entries (HMAC) |
| GET | `/valuation/manual/day` | All 8 metric values for a date |
| GET | `/valuation/manual/calendar` | Per-day completeness summary across a range |
| POST | `/valuation/refresh` | Manually trigger the valuation engine cron (HMAC) |
| GET | `/daybreak/edition` | Daybreak member read — subscriber-base (any subscriber token): current edition + held-over status. Worker-owned fields rebuilt by allowlist (reason codes, never detail); an available Z carries the `bands` stamped at intake from KV key `daybreak_powerlaw_bands_v1` (table + classification, or unavailable with a reason; never read at request time — shape in `docs/API.md` § Daybreak; the key is seeded by the operator, not by code); a store or KV failure is 503 `daybreak_read_failed`. No cache |
| POST | `/daybreak/draft` | Daybreak drafting-agent write (Radar) — **bearer secret** `DAYBREAK_DRAFT_SECRET` in `Authorization: Bearer`, compared in constant time and checked BEFORE the body is read; not JWT-gated, not HMAC. Body `{ date, sections }`, capped at 32 KiB. Writes ONLY `daybreak:<date>:draft`, via intake, and only when `date` is the next due date (the earliest due date whose 6:00 AM Central is strictly after now). Sections are validated against the section-key contract and rejected otherwise. Intake fetches the corn and Bitcoin closes from Yahoo through `src/daybreak/yahooCloses.ts` (see § Price Sources) and computes the Z from them. When it cannot, the Z is unavailable with one of intake's reason codes: `params_unavailable` if the power-law params are unseeded, `fetch_failed` for any Yahoo failure (429 included), or `future_dated_close` / `stale_close` / `computation_failed` (listed in `docs/API.md` § Daybreak). Codes only: 200 `{ date, z: { status, reason? } }`; 503 `daybreak_draft_not_configured`; 401 `missing_bearer` / `invalid_bearer`; 413 `body_too_large`; 400 `invalid_json` / `invalid_body` / `invalid_date` / `invalid_sections` / `unknown_section` / `invalid_section` / `invalid_link` (the last four and `invalid_body` may carry `field`); 422 `not_next_due_date`; 503 `daybreak_draft_write_failed` |
| GET | `/daybreak/editor` | Daybreak CMS read — **bearer secret** `DAYBREAK_EDITOR_SECRET` in `Authorization: Bearer` (constant time; not JWT-gated, not HMAC; `DAYBREAK_DRAFT_SECRET` and member JWTs are refused), checked before any KV read. Called only by the treasury API's proxy. Takes no date: returns both editable editions, `{ next, recent }` — `next` is N, the next due date (the earliest due date whose 6:00 AM Central is strictly after now), and `recent` is P, the most recent due date (the latest at or before now), published or not. Each is `{ date, published, content }` with the working copy, else the draft, its Worker-owned block rebuilt by the member read's allowlist (`sanitizeEditionContent`); or `{ date, published, code: "no_draft" }`. `published` is yes/no, never a time. Codes only: 503 `daybreak_editor_not_configured`; 401 `missing_bearer` / `invalid_bearer`; 503 `daybreak_editor_failed` |
| POST | `/daybreak/editor/save` | Daybreak CMS save — same bearer, checked BEFORE the body is read. Body `{ date, sections }`, capped at 32 KiB; `date` must be N or P. Sections are validated against the section-key contract before anything is written (a supplied `workerOwned` is rejected, not discarded). With no draft for the date, the save first creates it through intake with the same sections (Yahoo closes, Worker-stamped Z — so a no-draft save for P can store an unavailable Z with `future_dated_close`), then writes `daybreak:<date>:working` via `saveWorking`. No author or caller detail is stored. Codes only: 200 `{ date, z: { status, reason? } }` (the working key's Z after the save); 503 `daybreak_editor_not_configured`; 401 `missing_bearer` / `invalid_bearer`; 413 `body_too_large`; 400 `invalid_json` / `invalid_body` / `invalid_date` / `invalid_sections` / `unknown_section` / `invalid_section` / `invalid_link` (the last four and `invalid_body` may carry `field`); 422 `not_editable_date`; 503 `daybreak_editor_failed` |
| POST | `/daybreak/editor/publish` | Daybreak CMS publish — same bearer, checked BEFORE the body is read. Body `{ date }`, capped at 32 KiB; `date` must be N or P. `publishEdition`: copies working, else draft, to `daybreak:<date>:published`, overwriting any earlier publish with no mark, time or author. Codes only: 200 `{ date }`; 503 `daybreak_editor_not_configured`; 401 `missing_bearer` / `invalid_bearer`; 413 `body_too_large`; 400 `invalid_json` / `invalid_body` (+ `field`) / `invalid_date`; 422 `not_editable_date`; 409 `nothing_to_publish`; 503 `daybreak_editor_failed` |
| GET | `/base/contract-info` | Stablecoin rail — public: SettlementRouter address + live state |
| POST | `/base/contract-state` | Stablecoin rail — payment-scope: allowlisted ABI read wrapper |
| GET | `/base/balance` | Stablecoin rail — payment-scope: convenience ERC-20 `balanceOf` |
| POST | `/base/events` | Stablecoin rail — payment-scope: allowlisted `eth_getLogs` wrapper |

### Secrets (stored in Cloudflare, never in git)

- `CDP_KEY_NAME`
- `CDP_PRIVATE_KEY` — SEC1 format (`-----BEGIN EC PRIVATE KEY-----`); Worker converts to PKCS#8 for the Web Crypto API via `sec1ToPkcs8Pem()`
- `USDA_NASS_KEY`
- `DAYBREAK_DRAFT_SECRET` — bearer secret for `POST /daybreak/draft`, held by Radar (the Daybreak drafting agent) in Hyperagent locked to this Worker's host. **Worker-only:** it is never on a member node, and no app, compose or `.env` configuration carries it. Set with `npx wrangler secret put DAYBREAK_DRAFT_SECRET`; unset → the route returns 503 `daybreak_draft_not_configured`
- `DAYBREAK_EDITOR_SECRET` — bearer secret for the three CMS editor routes (`GET /daybreak/editor`, `POST /daybreak/editor/save`, `POST /daybreak/editor/publish`). The SAME value is held server-side by the **treasury** API, which proxies Kevin's editor to these routes; it never reaches the browser and is never handed to a member node. Distinct from `DAYBREAK_DRAFT_SECRET`: neither opens the other's routes. Set with `npx wrangler secret put DAYBREAK_EDITOR_SECRET`; unset → each editor route returns 503 `daybreak_editor_not_configured`

### Price Sources

| Commodity | API | Key | Notes |
|-----------|-----|-----|-------|
| Bitcoin | Coinbase Spot (client-side, not via Worker) | No | Spot price |
| Gold | TradingView futures scanner (`COMEX:GC1!`) | No | ~10-min-delayed front-month futures |
| Corn, Soybeans, Wheat | TradingView futures scanner (`CBOT:ZC1!`/`ZS1!`/`ZW1!`) | No | ~10-min-delayed front-month futures |
| Corn (historical only) | USDA NASS QuickStats via `/prices/corn-history` | `USDA_NASS_KEY` | Monthly PRICE RECEIVED, 2014+ |
| Corn + Bitcoin, Daybreak Z only | Yahoo Finance v8 chart (`ZC=F`, `BTC-USD`), `range=5d&interval=1d`, via `src/daybreak/yahooCloses.ts` | No | Fetched once per symbol at draft intake (`POST /daybreak/draft`); no cache, and every failure fails closed. **Only the latest FINISHED daily close is used.** Bitcoin: the last bar dated BEFORE the clock's UTC date, so neither the in-progress bar nor a future-dated one is ever returned. Corn: the day's bar once 1:20 PM Central has passed on its date (CBOT's close, hardcoded). Corn arrives in cents (`USX`) and is divided by 100; a currency other than `USX`/`USD` fails closed. Not the Market Snapshot tile, which still reads `CBOT:ZC1!`. |

The live `/prices` surface is the TradingView **futures scanner** (`scanner.tradingview.com/futures/scan`) — an undocumented public endpoint with no API key, no SLA, and no versioning. Prices are front-month continuous futures contracts (not spot), delayed ~10 minutes upstream. KV namespace `PRICES_CACHE` caches the live response for 10 minutes (matched to the upstream delay) plus a 24-hour last-known-good fallback; corn history is cached 24 hours. See `cloudflare-worker/src/handlers/prices.ts` for the operational-risk notes.

## Environment Variables

Required in the API container (`docker-compose.yml`):

- `COINBASE_APP_ID` — Coinbase Developer Platform Project ID. **Not a secret** — embedded in the Onramp URL visible to users. If unset, `GET /api/coinbase/onramp-url` returns 503.
- `COINBASE_WORKER_URL` — URL of the Cloudflare Worker (e.g. `https://bitcorn-onramp.ethancail.workers.dev`). If unset, returns 503.
- `VALUATION_SUBMIT_HMAC` — shared HMAC secret between the treasury API and the Worker for the `POST /valuation/manual` endpoint. **Sensitive** — never commit. Set via `bitcorn-lightning-node/.env` (see `.env.example` in that directory). If unset, `POST /api/valuation/manual` returns 503.
- `VALUATION_WORKER_URL` — optional override; defaults to `COINBASE_WORKER_URL` (both endpoints live on the same Worker today).
- `DAYBREAK_EDITOR_SECRET` — **treasury only.** The bearer secret the treasury API's three proxies (`GET /api/daybreak/editor`, `POST /api/daybreak/editor/save`, `POST /api/daybreak/editor/publish`) send to the Worker's `/daybreak/editor*` routes, at `COINBASE_WORKER_URL`; the SAME value as the Worker's `DAYBREAK_EDITOR_SECRET` above. **Sensitive** — never commit. Set in the treasury's `bitcorn-lightning-node/.env` exactly as `VALUATION_SUBMIT_HMAC` is below (`openssl rand -hex 32`, then `npx wrangler secret put DAYBREAK_EDITOR_SECRET` with the same value, then restart the app). The compose line ships empty to every node; it is never set on a member node. If unset, each proxy returns 503 `editor_not_configured`.

### Setting the operator secret (Umbrel install)

On Umbrel, the deployed docker-compose.yml lives at `~/umbrel/app-data/bitcorn-lightning-node/docker-compose.yml`. Put operator secrets in a sibling `.env` file — Docker Compose auto-reads it, and `.env` is gitignored:

```bash
# 1. Generate the secret
openssl rand -hex 32   # copy the output

# 2. Put it on the Umbrel node
sudo nano /home/umbrel/umbrel/app-data/bitcorn-lightning-node/.env
# Add a line:  VALUATION_SUBMIT_HMAC=<hex from step 1>
# Save and exit.

# 3. Put the SAME value on the Worker
cd cloudflare-worker
npx wrangler secret put VALUATION_SUBMIT_HMAC
# paste the hex, Ctrl-D
npx wrangler deploy

# 4. Restart the app so the api container picks up the new env
sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node
```

After restart, the treasury-only `/valuation-input` page (sidebar link) works end-to-end: values save locally, HMAC-sign, POST to the Worker, land in KV key `valuation_manual_v1`, and feed the composite Z-score used by Auto-Buy.

## Redeploying the Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy          # redeploy code changes

# Update secrets (paste value, then Ctrl-D):
npx wrangler secret put CDP_KEY_NAME
npx wrangler secret put CDP_PRIVATE_KEY
npx wrangler secret put USDA_NASS_KEY

# Live Worker logs:
npx wrangler tail
```

**Secret format:** paste the raw key name / raw PEM from the CDP JSON file — do **not** wrap in quotes.

## Clearing the Price Cache

After changing API keys or forcing a refresh:

```bash
npx wrangler kv key delete commodity_prices --namespace-id=62c68c41830141cc8b0b6e7cdb193461
```

## UI Integration

`app/web/src/components/FundNodePanel.tsx` is rendered below `NodeBalancePanel` on both dashboards. One-shot fetch (no poll) on mount; falls back to `0 sats` on fetch error (no infinite shimmer). Maps the machine-readable `coinbase_not_configured` API error to an operator-readable message.

## Price Ticker (Worker `/prices`)

`PriceTickerStrip` in `app/web/src/components/CommodityPricesPanel.tsx` renders a 5-ticker strip (BTC, Gold, Corn, Soy, Wheat) below the Power Law chart on the Charts page. BTC comes from Coinbase Spot (client-side); commodities come from `api.getCommodityPrices()` with 60-minute refresh. `/api/commodity-prices` (in `app/api/src/index.ts`) proxies `GET` requests to the Worker's `/prices` endpoint. Returns 503 if `COINBASE_WORKER_URL` is unset, 502 if the Worker is down.

## Known Upstream Quirks

- **TradingView free widgets** restrict futures symbols; ETF symbols show fund share prices, not spot prices (e.g. GLD ~$475 vs gold spot ~$5,165)
- **Frankfurter API** does NOT support XAU — only fiat
- **metals.dev** has 25 req/month free — too tight even with 24h caching
- **PAXG on Coinbase** trades at premium over gold spot — not a substitute
- **Yahoo chart daily bars** (Daybreak's closes; captures of 2026-09-28/29 in `cloudflare-worker/tests/daybreak/fixtures/yahoo/README.md`):
  - **Timestamps are local midnights.** Corn bars are stamped at New York midnight and Bitcoin bars at UTC midnight. A bar's date is its timestamp's UTC date; through Central time, both land on the day before.
  - **The last bar is usually in progress.** Bitcoin's current UTC day is always the last bar. Corn's reported trading period is a whole-day envelope, not CBOT's session.
  - **The finished corn bar changes value later.** After the day-session close it holds the last trade, and it is later replaced by CME's settlement.
  - **Yahoo returns 429** to this repo's own network, and has not been tried from Cloudflare.
