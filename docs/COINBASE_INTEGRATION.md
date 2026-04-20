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
| GET | `/prices` | Commodity prices (gold, corn, soybeans, wheat), cached 24h in KV |
| GET | `/prices/corn-history` | Historical monthly corn PRICE RECEIVED from USDA NASS (2014+), cached 24h in KV |

### Secrets (stored in Cloudflare, never in git)

- `CDP_KEY_NAME`
- `CDP_PRIVATE_KEY` — SEC1 format (`-----BEGIN EC PRIVATE KEY-----`); Worker converts to PKCS#8 for the Web Crypto API via `sec1ToPkcs8Pem()`
- `USDA_NASS_KEY`
- `GOLD_API_KEY`

### Price Sources

| Commodity | API | Key | Free Tier |
|-----------|-----|-----|-----------|
| Bitcoin | Coinbase Spot | No | Unlimited |
| Gold | goldapi.io | `GOLD_API_KEY` | 100 req/month |
| Corn, Soybeans, Wheat | USDA NASS QuickStats | `USDA_NASS_KEY` | Unlimited |

KV namespace `PRICES_CACHE` caches the combined JSON for 24 hours to minimize upstream API calls.

## Environment Variables

Required in the API container (`docker-compose.yml`):

- `COINBASE_APP_ID` — Coinbase Developer Platform Project ID. **Not a secret** — embedded in the Onramp URL visible to users. If unset, `GET /api/coinbase/onramp-url` returns 503.
- `COINBASE_WORKER_URL` — URL of the Cloudflare Worker (e.g. `https://bitcorn-onramp.ethancail.workers.dev`). If unset, returns 503.
- `VALUATION_SUBMIT_HMAC` — shared HMAC secret between the treasury API and the Worker for the `POST /valuation/manual` endpoint. **Sensitive** — never commit. Set via `bitcorn-lightning-node/.env` (see `.env.example` in that directory). If unset, `POST /api/valuation/manual` returns 503.
- `VALUATION_WORKER_URL` — optional override; defaults to `COINBASE_WORKER_URL` (both endpoints live on the same Worker today).

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
npx wrangler secret put GOLD_API_KEY

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
