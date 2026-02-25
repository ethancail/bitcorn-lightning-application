# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read First

Before working on any feature or bug, read the relevant docs:

| Doc | When to read |
|-----|-------------|
| `docs/ARCHITECTURE.md` | Understanding data flow, node roles, sync loop |
| `docs/IMPLEMENTATION.md` | Finding exact file locations for any major flow |
| `docs/API.md` | Full endpoint reference |
| `docs/DATABASE.md` | Schema details and table relationships |
| `docs/COINBASE_INTEGRATION.md` | Coinbase Onramp session-token flow via Cloudflare Worker (OAuth2 notes are legacy/unused) |

These docs are the authoritative reference for how the system works. The sections below are a summary.

### Files to share when getting external AI assistance

When using Claude chat or another AI for brainstorming, the docs describe *what* exists — but the source code shows *how* it works. Paste the relevant source files for the area you're discussing:

| Area | Files to share |
|------|---------------|
| Channel ROI / peer scoring (Phase 2) | `src/api/treasury-channel-metrics.ts`, `src/api/treasury-liquidity-health.ts`, `src/api/treasury.ts` |
| Capital guardrails | `src/utils/capital-guardrails.ts`, migration `013_treasury_capital_policy.sql` |
| Rebalance logic | `src/lightning/rebalance-circular.ts`, `src/lightning/rebalance-auto.ts`, `src/utils/rebalance-liquidity.ts`, migrations `014`, `015` |
| Expansion engine | `src/api/treasury-expansion.ts`, `src/utils/capital-guardrails.ts` |
| Metrics / net yield | `src/api/treasury.ts`, migrations `007`–`009`, `014` |
| Schema / data model | All files in `src/db/migrations/` |
| All routes | `src/index.ts` |
| Coinbase Onramp | `app/api/src/api/coinbase-onramp.ts`, `cloudflare-worker/src/index.ts` |

Always include `CLAUDE.md` + `docs/IMPLEMENTATION.md` as base context.

---

## Mission & Vision

Bitcorn Lightning is a **Lightning Treasury Capital Allocation Engine** — not a wallet, not a UI product, not a generic routing node.

**Core objective:** Maximize risk-adjusted net sats by deploying capital into channels, rebalancing intelligently, enforcing strict capital guardrails, and tracking true profitability:

```
Net Sats = inbound + forwarding fees − outbound fees − rebalance costs
```

Economic truth > vanity metrics. Do not optimize for channel count, node size, or gossip presence.

### Architectural Roles

**Treasury node** — capital allocator, expansion authority, rebalance scheduler, profitability engine, guardrail enforcer. All intelligence lives here.

**Member nodes** — liquidity consumers only. Not capital allocators. Not strategy engines.

### Non-Negotiables

- Guardrails cannot be bypassed by automation
- Capital reserve floors must always be respected
- Deploy ratio limits must always be enforced
- Rebalance costs must always be accounted for
- Automation must be auditable and deterministic
- Safety > growth

### Current Capabilities
Channel expansion engine, capital guardrails (reserve, deploy ratio, per-peer caps, cooldowns, daily limits), circular rebalance engine, auto channel selection, rebalance scheduler, rebalance cost ledger, treasury metrics API, dual-role web UI (treasury dashboard + member dashboard with in-app channel creation), gossip-aware peer detection for frictionless member onboarding, node balance panel (total/on-chain/lightning displayed at the top of both dashboards), Coinbase Onramp integration (sessionToken via Cloudflare Worker — fresh on-chain address per session, audit log in SQLite), Bitcoin price graph (recharts AreaChart, Coinbase public API, 24h/7d/30d/1y/5y selector, 60s auto-refresh, displayed on both dashboards), mobile-responsive navigation (hamburger menu under 768px, slide-in sidebar drawer with backdrop overlay), Charts page with Bitcoin Power Law Trend chart (log-scale, percentile bands, 2042 projection, shared across both shells).

### Future Direction
Channel-level ROI scoring, peer profitability ranking, dynamic fee adjustment based on imbalance, yield-driven capital reallocation, fully autonomous LSP behavior.

---

## Project Overview

Bitcorn Lightning is a hub-and-spoke Lightning Service Provider (LSP) Umbrel Community Store app. The treasury node is the hub; member nodes are spokes. All Lightning is routed-native (no custodial shortcuts). This is a production Lightning application — ask before touching networking, auth, Lightning flows, or Umbrel manifests.

## Build Commands

**API (`app/api/`):**
```bash
npm run build   # tsc -p tsconfig.json → dist/
npm start       # node dist/index.js
```

**Web (`app/web/`):**
```bash
npm run build   # vite build → dist/
npm start       # serve -s dist -l 3200
```

**Full stack (Docker):**
```bash
docker compose up -d --build
```

**Web dev server:**
```bash
cd app/web && npm run dev   # Vite dev server, hot reload
```

No automated test suite exists yet. Migrations run automatically on API startup.

**Frontend dependencies:** `react`, `react-dom`, `react-router-dom`, `recharts` (for BitcoinPriceGraph + PowerLawChart), `date-fns` (date formatting in PowerLawChart tooltip).

## Branching Model

- `main` — production; pushes trigger Docker image builds via GitHub Actions
- `develop` — integration branch between feature work and main
- `feature/*` — feature branches off develop (e.g. `feature/btc-price-graph`)

Merge path: `feature/*` → `develop` → sideload test on Umbrel → `main`.

## Umbrel Deployment

Docker images are built and pushed to `ghcr.io` automatically by `.github/workflows/docker-publish.yml` on push to `main` (when `app/api/**`, `app/web/**`, or `umbrel-app.yml` change). The workflow reads the version from `umbrel-app.yml` and tags images accordingly. **Version in `umbrel-app.yml` must match image tags in `bitcorn-lightning-node/docker-compose.yml`** — if they drift, Umbrel will pull stale images.

**If Umbrel install fails (flips back to "Install" at 0%):** The Docker images likely don't exist on ghcr.io. Check `gh run list` for a failed build. Common cause: transient npm 403 errors (e.g. `npm install -g serve` in the web Dockerfile getting rate-limited by registry.npmjs.org). Fix: re-run the failed workflow with `gh run rerun <run-id> --failed`. Always verify the build is green after pushing a version bump.

## Architecture

### Hub-and-Spoke Model
- **Treasury Node** (hub): Provides liquidity; has access to all treasury endpoints
- **Member Nodes** (spokes): Pay invoices via treasury channel
- **Node role** is computed on each sync cycle and stored in SQLite (`node_role` column)
  - `treasury`: pubkey matches `TREASURY_PUBKEY` env var
  - `member`: has active treasury channel
  - `external`: no treasury channel

### Sync-Driven State
A sync loop runs every 15s (`src/lightning/sync.ts`), pulling LND state into SQLite. The database is the source of truth for metrics, guardrails, and membership. Live LND calls are only used for critical operations (payments, channel opens, apply fee policy).

### Three-Layer Pattern
1. `src/lightning/` — LND gRPC integration via `ln-service`
2. `src/api/` — Business logic (treasury metrics, fees, liquidity health, rebalance)
3. `src/utils/` — Guards: membership, rate limits, capital guardrails, liquidity scoring

### Port Assignments (DO NOT change without approval)
| Port | Purpose |
|------|---------|
| 3101 | User/Admin API (JWT, Umbrel-aware) |
| 3109 | Node-to-Node API (HMAC only, never proxied) |
| 3200 | Web UI |

Do not reuse ports 3001 or 3009. Do not expose port 3109 via Umbrel app-proxy.

### Database
SQLite at `data/db/bitcorn.sqlite` (mounted at `/data` inside the API container; on Umbrel host: `/home/umbrel/umbrel/app-data/bitcorn-lightning-node/data/db/bitcorn.sqlite`). Migrations in `src/db/migrations/` (001–019). Migrations must be idempotent and run on startup. Never mutate schema manually. Note: `sqlite3` is not installed in the API Docker image — to query the DB directly, install it on the Umbrel host (`sudo apt install sqlite3`) and access the file at the host path.

Key tables: `lnd_node_info`, `lnd_channels`, `lnd_peers`, `payments_inbound`, `payments_outbound`, `payments_forwarded`, `treasury_fee_policy`, `treasury_capital_policy`, `treasury_expansion_recommendations`, `treasury_expansion_executions`, `treasury_rebalance_costs`, `treasury_rebalance_executions`, `coinbase_onramp_sessions`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | All HTTP routes (600+ lines) |
| `src/lightning/sync.ts` | Main sync orchestrator |
| `src/lightning/lnd.ts` | LND client, TLS + macaroon setup |
| `src/lightning/rebalance-circular.ts` | Circular rebalance execution |
| `src/lightning/rebalance-auto.ts` | Auto-select donor/receiver channels |
| `src/lightning/rebalance-scheduler.ts` | Scheduled rebalance loop |
| `src/api/treasury.ts` | Aggregate treasury metrics |
| `src/api/treasury-liquidity-health.ts` | Per-channel liquidity assessment |
| `src/api/treasury-expansion.ts` | Channel expansion recommendations & execution |
| `src/utils/capital-guardrails.ts` | Pre-expansion policy enforcement |
| `src/config/env.ts` | All environment variables with defaults |
| `src/api/coinbase-onramp.ts` | Calls Cloudflare Worker to obtain a Coinbase session token |
| `cloudflare-worker/src/index.ts` | Cloudflare Worker: signs CDP JWT, converts SEC1→PKCS#8, exchanges for session token |

## Role-Based Access Control

- **Public**: `/health`, `/api/node`, `/api/node/balances`, `/api/coinbase/onramp-url`, `/api/peers`, `/api/channels`, `/api/member/stats`, `POST /api/member/open-channel`
- **Member** (active treasury channel): `POST /api/pay`
- **Treasury only**: All `/api/treasury/*` endpoints

Role is derived from identity + treasury channel state — not bearer tokens.

`/api/member/stats` returns: `hub_pubkey`, `membership_status`, `node_role`, `is_peered_to_hub` (bool — live LND peer check, best-effort), `treasury_channel` (balances/capacity/active or null), `forwarded_fees` (24h / 30d / all-time).

`POST /api/member/open-channel` accepts `{ capacity_sats, partner_socket? }`. Validates capacity ≥ 100,000 sats, optionally calls `connectToPeer(hubPubkey, socket)` if socket provided, then calls `openTreasuryChannel`. Returns `{ ok, funding_txid }`.

## Frontend Architecture

**Stack:** React 18 + TypeScript + Vite, react-router-dom v6, amber-on-black design system.

**Design system** lives entirely in `app/web/src/styles.css`. Key CSS custom properties: `--bg`, `--amber`, `--green`, `--red`, `--mono`, `--sans`. Key classes: `.panel`, `.panel-header`, `.panel-title`, `.panel-body`, `.stat-card`, `.stat-value`, `.stat-label`, `.stat-sub`, `.dashboard-grid`, `.data-table`, `.td-mono`, `.td-num`, `.badge-green/.red/.amber/.blue/.muted`, `.btn`, `.btn-primary/.outline/.ghost`, `.form-input`, `.loading-shimmer`, `.empty-state`, `.alert.critical/.warning/.info/.healthy`, `.wizard-*`, `.fade-in`. Mobile classes (inside `@media max-width: 767px`): `.hamburger-btn`, `.sidebar-overlay`, `.sidebar-close-btn`, `.sidebar-mobile-header`, `.sidebar.open`.

**Dual-role routing** (`App.tsx`): `useAppStatus()` fetches `/api/node` → branches on `node_role`:
- `"treasury"` + `localStorage.bitcorn_setup_done === "1"` → `AppShell` (treasury dashboard)
- `"treasury"` without localStorage flag → wizard (`/setup`)
- any other role (`"member"`, `"external"`, `"unsynced"`, errors) → `MemberShell`

All non-treasury nodes get the same `MemberShell`. `MemberDashboard` handles the no-channel state contextually with a `ConnectToHub` form — no routing-level gate based on membership status.

`TREASURY_PUBKEY` is **hard-coded** in `docker-compose.yml` as `02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca`. This means all member installs get correct role detection automatically without configuration.

**Key frontend files:**
| File | Purpose |
|------|---------|
| `app/web/src/App.tsx` | Root router, both shells (AppShell + MemberShell), mobile hamburger menu state, all page stubs |
| `app/web/src/api/client.ts` | `apiFetch<T>` helper, namespaced `api.*` object, all types |
| `app/web/src/components/NodeBalancePanel.tsx` | Shared balance panel (Total/Bitcoin/Lightning) — rendered at top of both dashboards |
| `app/web/src/components/FundNodePanel.tsx` | Coinbase Onramp panel — shows on-chain balance + "Fund Node via Coinbase →" button; rendered below NodeBalancePanel on both dashboards |
| `app/web/src/components/BitcoinPriceGraph.tsx` | BTC/USD price graph — recharts AreaChart, Coinbase public API, 24h/7d/30d/1y/5y selector, 60s auto-refresh |
| `app/web/src/components/PowerLawChart.tsx` | Bitcoin Power Law chart — recharts ComposedChart, log Y axis, percentile bands (p2.5/p16.5/p83.5/p97.5), trend line, live spot price overlay, downsampling |
| `app/web/src/data/power-law-data.json` | Power law dataset — ~10,000 daily entries from 2015-01-01 to 2042-05-31, includes btc price + trend + percentile bands; bundled by Vite |
| `app/web/src/pages/Charts.tsx` | Charts page — period selector (1Y/5Y/All/2042), spot price fetch, PowerLawChart + legend; available to both treasury and member shells |
| `app/web/src/pages/Dashboard.tsx` | Treasury dashboard (monolithic: NodeBalancePanel, FundNodePanel, BitcoinPriceGraph, AlertsBar, NetYield, ChannelROI, PeerScores, Rotation, DynamicFees) |
| `app/web/src/pages/Wizard.tsx` | 5-screen treasury setup wizard |
| `app/web/src/pages/MemberDashboard.tsx` | Member view: `ConnectToHub` form (no channel) or hub channel stats + forwarded fees |
| `app/web/src/styles.css` | Full design system |
| `app/web/src/config/api.ts` | `API_BASE` constant |

**`ConnectToHub` component** (inside `MemberDashboard.tsx`): shown when `treasury_channel` is null. Shows capacity presets (500k / 1M / 2M sats), number input (min 100k), and either a green "Already connected via gossip" banner (when `is_peered_to_hub: true`) or an optional hub address field. Calls `api.openMemberChannel()` → transitions to a success state showing the funding txid.

**3-column stat grids:** `dashboard-grid` CSS class defaults to `1fr 1fr`. Override inline with `style={{ gridTemplateColumns: "1fr 1fr 1fr" }}` when 3 cards are needed (hub channel stats, forwarded fees).

**API client pattern:** All calls go through `api.*` methods defined in `client.ts`. Add new endpoints there as `api.methodName: () => apiFetch<ReturnType>("/api/path")`. Types live in the same file.

**`FundNodePanel` component** (`app/web/src/components/FundNodePanel.tsx`): rendered below `NodeBalancePanel` on both dashboards. Calls `api.getNodeBalances()` on mount (one-shot, no poll) and displays on-chain balance; falls back to `0 sats` on fetch error (no infinite shimmer). "Fund Node via Coinbase →" button calls `api.getCoinbaseOnrampUrl()` → opens the returned URL in a new tab (`window.open`, `noopener,noreferrer`). Maps machine-readable API error `coinbase_not_configured` to operator-readable message. Returns 503 if `COINBASE_APP_ID` or `COINBASE_WORKER_URL` env var is unset. Flow: button → `GET /api/coinbase/onramp-url` → `coinbase-onramp.ts` POSTs to Cloudflare Worker → Worker signs CDP JWT, calls `POST api.developer.coinbase.com/onramp/v1/token` → returns `{ sessionToken }` → API builds `https://pay.coinbase.com/buy/select-asset?appId=...&sessionToken=...` and returns it to the frontend.

**`NodeBalancePanel` component** (`app/web/src/components/NodeBalancePanel.tsx`): shared component rendered at the top of both `Dashboard.tsx` (treasury) and `MemberDashboard.tsx`. Calls `api.getNodeBalances()` on mount, polls every 15s. Shows three stat cards: Total Node Balance, Bitcoin Balance, Lightning Wallet — each displaying sats and BTC (8 decimal places). Uses loading shimmer while data is pending; silently swallows fetch errors (cards stay in shimmer state).

**Scroll layout constraint:** `.app-shell` in `styles.css` uses `height: 100vh` (not `min-height`). This is intentional — it constrains the CSS grid to the viewport so that `overflow-y: auto` on `.main-content` triggers correctly. Changing it to `min-height` will break scrolling (the grid grows to fit content, body scrolls instead, and the sidebar disappears). `.main-content` uses `padding-bottom: 64px` to ensure the last panel has breathing room.

**Mobile navigation (< 768px):** On screens under 768px, the sidebar is hidden and replaced by a hamburger menu (☰) in the topbar. Clicking it slides the sidebar in from the left (`transform: translateX(-100%) → translateX(0)`, 200ms ease) over a dark backdrop overlay (`rgba(0,0,0,0.6)`). Menu closes via: X button inside the drawer, clicking the backdrop, or clicking any nav link. Both `AppShell` and `MemberShell` manage a `menuOpen` boolean state, passed as `open`/`onClose` props to their respective sidebar components and `onMenuToggle` to `Topbar`. On mobile, `.dashboard-grid` collapses to single column, `.data-table` gets `min-width: 600px` for horizontal scroll, and `.main-content` padding is reduced. Desktop layout (768px+) is completely unchanged — CSS-only via `@media (max-width: 767px)`.

## Capital Guardrails

Before any channel open, `capital-guardrails.ts` checks: minimum on-chain reserve, max deploy ratio, max pending opens, per-peer capacity cap, peer cooldown period, daily expansion limit, daily total deploy limit. Returns 429 on violation.

## Liquidity Management

Imbalance ratio: `local / (local + remote)`. Classifications: `healthy`, `outbound_starved`, `critical`. Circular rebalance forces a payment over path `outgoing_channel → ... → incoming_channel`. Scheduler enabled via `REBALANCE_SCHEDULER_ENABLED=true`, runs every 60s.

## Coinbase Onramp

The "Fund Node via Coinbase" feature lets operators buy bitcoin directly into their node's on-chain wallet. Coinbase Onramp **requires a server-side session token** (Secure Initialization is enabled on the CDP project). CDP credentials (private key) cannot live in the public repo or on user nodes — a **Cloudflare Worker** holds them securely.

### Architecture

```
FundNodePanel (browser)
  → GET /api/coinbase/onramp-url (API container)
    → coinbase-onramp.ts
      → POST https://bitcorn-onramp.ethancail.workers.dev  (Cloudflare Worker)
        → signs ES256 JWT with CDP private key
        → POST https://api.developer.coinbase.com/onramp/v1/token
        → returns { sessionToken }
    → builds https://pay.coinbase.com/buy/select-asset?appId=...&sessionToken=...
  → window.open(url)  (Coinbase Onramp page opens in new tab)
```

### Cloudflare Worker (`cloudflare-worker/`)

- Source: `cloudflare-worker/src/index.ts`
- Deployed at: `https://bitcorn-onramp.ethancail.workers.dev`
- Accepts `POST { address: string }` → returns `{ sessionToken: string }`
- Secrets stored in Cloudflare (never in git): `CDP_KEY_NAME` (key ID) and `CDP_PRIVATE_KEY` (EC private key PEM)
- CDP keys are SEC1 format (`-----BEGIN EC PRIVATE KEY-----`); Worker converts to PKCS#8 for the Web Crypto API via `sec1ToPkcs8Pem()`

### Redeploying the Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy          # redeploy code changes
# Update secrets (paste value, then Ctrl-D):
npx wrangler secret put CDP_KEY_NAME
npx wrangler secret put CDP_PRIVATE_KEY
```

**Secret format:** paste the raw key name / raw PEM from the CDP JSON file — do **not** wrap in quotes. Wrangler tails: `npx wrangler tail` for live Worker logs.

## Security Constraints

- Secrets are generated on first run and stored under `/data/secrets` — never hardcode or commit secrets
- User/Admin API (3101): JWT auth
- Node-to-Node API (3109): HMAC + timestamp + nonce; rejects replayed/stale requests
- No `docker.sock` mounts, no privileged containers, no host networking

## Environment Variables

See `src/config/env.ts` for all variables. Key ones:
- `TREASURY_PUBKEY` — hard-coded in `docker-compose.yml` as `02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca`; identifies the treasury node and enables role detection for all member installs
- `LND_GRPC_HOST` — default `lightning_lnd_1:10009`
- `BITCOIN_NETWORK` — default `mainnet`
- `REBALANCE_SCHEDULER_ENABLED` — default `false`
- `RATE_LIMIT_MAX_SINGLE_PAYMENT` — default `250000` sats
- `COINBASE_APP_ID` — Coinbase Developer Platform Project ID; set in `docker-compose.yml`; if unset, `GET /api/coinbase/onramp-url` returns 503. **Not a secret** — it is embedded in the Onramp URL visible to users.
- `COINBASE_WORKER_URL` — URL of the Cloudflare Worker that holds CDP credentials and mints session tokens (e.g. `https://bitcorn-onramp.ethancail.workers.dev`); set in `docker-compose.yml`. Required; if unset, `GET /api/coinbase/onramp-url` returns 503.
