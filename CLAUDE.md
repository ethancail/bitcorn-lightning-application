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
| `docs/LOOP_SETUP.md` | Loop Out submarine swap rebalancing setup and API reference |

These docs are the authoritative reference for how the system works. The sections below are a summary.

### Files to share when getting external AI assistance

When using Claude chat or another AI for brainstorming, the docs describe *what* exists — but the source code shows *how* it works. Paste the relevant source files for the area you're discussing:

| Area | Files to share |
|------|---------------|
| Channel ROI / peer scoring (Phase 2) | `src/api/treasury-channel-metrics.ts`, `src/api/treasury-liquidity-health.ts`, `src/api/treasury.ts` |
| Capital guardrails | `src/utils/capital-guardrails.ts`, migration `013_treasury_capital_policy.sql` |
| Rebalance engine v1 (clusters) | `src/rebalance/rebalanceScheduler.ts`, `src/rebalance/clusterState.ts`, `src/rebalance/feeSteering.ts`, `src/rebalance/pairSelector.ts`, `src/rebalance/cycleEnumerator.ts`, `src/rebalance/cycleScorer.ts`, `src/rebalance/rebalanceExecutor.ts`, `src/rebalance/topologyMonitor.ts`, migrations `023`, `024`, `025` |
| Rebalance logic (Loop Out) | `src/lightning/loop.ts`, `src/lightning/rebalance-loop.ts`, `src/lightning/rebalance-scheduler.ts`, `src/lightning/rebalance-circular.ts`, migrations `014`, `015` |
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

### Current Capabilities (through v1.9.53)

**Core treasury engine:**
- Channel expansion engine with capital guardrails (reserve, deploy ratio, per-peer caps, cooldowns, daily limits)
- Auto-cleans stale `requested`/`submitted` expansion executions after 1 hour via sync loop
- Loop Out submarine swap rebalancing via Lightning Terminal / loopd
- **Cluster-based rebalance engine v1** — 3 levers (fee steering, circular rebalance, topology monitor), 15-min interval
- Treasury metrics API, rebalance cost ledger, forwarding fee tracking

**Merchant/farmer lane model** (stable purpose + dynamic state):
- **Purpose** (stable): `merchant_lane` / `farmer_lane` / `external_peer` / `unclassified` — determined only by contact tags, never by balance heuristics
- **State** (dynamic): computed from balance, interpreted through purpose lens
- Treasury Channels page: Merchant Lanes / Farmer Lanes / External Routing Peers / Unclassified, consistent 6-column layout with % widths
- Closing channels filtered out of lane tables (shown only in the CLOSING section)

**Role-aware member liquidity advisor** (v1.9.12+):
- `channel_role` stored in `member_liquidity_advisor_config` (migration 032), defaults to `'unknown'` — never silently auto-classified
- Merchant path: low outbound → Loop In; undersized (< 2M) or 3+ exhaustion runs → channel upgrade
- Farmer path: high local → Loop Out; undersized (< 1M) or 3+ filling runs → channel upgrade
- Unknown: prompts user to set role via Settings page
- **Close/reopen never recommended** — Loop In/Out are the normal maintenance path

**Role-aware member UI** (v1.9.50+):
- `MemberShell` fetches role from advisor status and passes to sidebar
- Farmer sidebar: "Cash Out" ↗ → `/cashout` (Loop Out); button: "Cash Out Earnings →"
- Merchant sidebar: "Refill Channel" ↙ → `/refill` (Loop In placeholder; currently shares Withdraw page); button: "Refill Channel →"
- Unknown: defaults to "Cash Out" with dashboard prompt to set role
- Farmer dashboard gauge fills up like a grain bin (green→amber→red as earnings accumulate)
- Merchant dashboard shows outbound capacity remaining

**Treasury Peers page** (v1.9.25):
- Connect to new nodes by pasting a URI (`pubkey@host:port`)
- Shows treasury's own pubkey for sharing with new members
- Onboarding guide: what to ask for, what to tell new members
- Live connected peers table with contact name resolution, direction, ping

**Treasury Settings page** (v1.9.47):
- **Routing Fee Policy** panel: base_fee_msat + fee_rate_ppm with live % display and example calc, applies to all channels via `lncli updatechanpolicy` equivalent
- **Capital Guardrails** panel: compact side-by-side rows (label+help left, input right) with unit labels outside the field
- **Appearance** consolidated panel: theme chips, text-size slider, 2x2 font grid
- Entire page constrained to 720px max-width, centered

**Channel open UX** (v1.9.10+):
- Formatted capacity inputs: commas + "sats" suffix, free-form entry, 100k minimum validation
- **Confirmation Speed selector**: Economy (~1 sat/vB, 1–3h, ~155 sats) / Normal (~5 sat/vB, ~30min, ~770 sats) / Priority (~15 sat/vB, ~10min, ~2,300 sats)
- Both member ConnectToHub and treasury Open Channel panels
- Pending channel detection on member dashboard — polls `/api/channels/pending` every 15s, shows "Channel Opening Submitted" across page reloads

**Member withdrawal page** (v1.9.18+):
- Prominent **Available Balance** card (amber-tinted) showing treasury channel local + max withdraw
- Max button with fee cushion calculation (local − 50k buffer − 2k fee cushion, capped at 2M)
- Accurate fee display: net fee (swap + miner, ~1-2k) separated from prepay hold (~30k, returned in on-chain payment)
- Formatted amount input with commas, sats label, preset buttons (250k/500k/1M/2M/Max)
- Connect to Hub three-state peering: connected / hub address available / manual input

**Treasury Dashboard** (v1.9.46 — simplified):
- Node Balances → Fund Node → Bitcoin Price → Alerts (if any) → Treasury Revenue
- Revenue panel: forwarding fees / rebalance costs / net revenue (24h + all-time) + capital deployed / active channels / revenue yield
- Removed: KPI strip, Peer Scores, Channel ROI, Rotation Candidates, Dynamic Fees (accessible from dedicated pages)

**Network Topology graph** (v1.9.34+):
- Liquidity page shows SVG hub-and-spoke visualization
- Treasury at center, peers arranged radially, color-coded by role (amber merchant, green farmer, blue external, gray unknown)
- Scroll to zoom (40–300%), click-drag to pan, zoom controls + percentage, Reset button
- Channel line width proportional to capacity; colored fill shows treasury local %
- Hover a node for detailed capacity/local/remote breakdown

**Swap Operations page** (v1.9.37+, treasury):
- Loop Out / Loop In tabs
- **Visual channel picker**: compact chips showing peer name, capacity, balance bar (Auto-select + one chip per channel)
- Formatted amount inputs with presets
- Accurate fee display (swap + miner, with prepay explained as temporary hold)
- Swap history table

**Charts and commodity prices:**
- Bitcoin Power Law Trend (log-scale, percentile bands, 2042 projection) — fills gap days with live Coinbase price
- Price ticker strip: BTC (Coinbase) + gold (goldapi.io) + corn/soybeans/wheat (USDA NASS) — cached 24h in Cloudflare KV
- BTC Moving Averages (50/100/200-day MAs, 1M/1Y/5Y/10Y periods)
- Corn-Bitcoin ratio (bushels per BTC from USDA monthly data, interpolated to daily)
- Corn Moving Averages (reuses `computeMA` + `interpolateCornPrices` helpers)

**Other:**
- Coinbase Onramp integration (sessionToken via Cloudflare Worker)
- Mobile-responsive navigation (hamburger menu + slide-in sidebar under 768px)
- Contacts page: CRUD address book with **tag editor** (merchant/farmer lane toggles + custom tag pills), sync-from-peers imports both channel peers AND live connected peers
- Network payments (invoice-based request/pay, auto-settlement sync in 15s loop — v1.9.49)
- Forced treasury channel routing (member payments route through hub via `outgoing_channel`)
- Treasury-side member liquidity management (detects imbalances, operator approves/rejects top-ups via Member Liquidity page)
- Treasury Peers API: `GET /api/treasury/peers/live`, `POST /api/treasury/peers/connect`

### Future Direction
Channel-level ROI scoring, peer profitability ranking, yield-driven capital reallocation, fully autonomous LSP behavior.

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

**Frontend dependencies:** `react`, `react-dom`, `react-router-dom`, `recharts` (for BitcoinPriceGraph, PowerLawChart, MovingAveragesChart), `date-fns` (date formatting in chart tooltips).

## Branching Model

- `main` — production; pushes trigger Docker image builds via GitHub Actions
- `develop` — integration branch between feature work and main
- `feature/*` — feature branches off develop (e.g. `feature/btc-price-graph`)

Merge path: `feature/*` → `develop` → sideload test on Umbrel → `main`.

## Umbrel Deployment

Docker images are built and pushed to `ghcr.io` automatically by `.github/workflows/docker-publish.yml` on push to `main` (when `app/api/**`, `app/web/**`, or `umbrel-app.yml` change). The workflow reads the version from `umbrel-app.yml` and tags images accordingly. **Version in `umbrel-app.yml` must match image tags in `bitcorn-lightning-node/docker-compose.yml`** — if they drift, Umbrel will pull stale images.

**If Umbrel install fails (flips back to "Install" at 0%):** The Docker images likely don't exist on ghcr.io. Check `gh run list` for a failed build. Common cause: transient npm 403 errors (e.g. `npm install -g serve` in the web Dockerfile getting rate-limited by registry.npmjs.org). Fix: re-run the failed workflow with `gh run rerun <run-id> --failed`. Always verify the build is green after pushing a version bump.

**If Umbrel install reaches ~50% then resets:** A port conflict is likely. Check `sudo journalctl -u umbreld -n 100` for "already allocated" errors. Remove the conflicting container (`sudo docker rm -f <name>`) and retry.

**Deploying hotfixes without a version bump:** Umbrel won't auto-detect image changes under the same tag. Force-pull and restart: `sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/api:<version> && sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node`.

## Architecture

### Hub-and-Spoke Model
- **Treasury Node** (hub): Provides liquidity; has access to all treasury endpoints
- **Member Nodes** (spokes): Pay invoices via treasury channel
- **Node role** is computed on each sync cycle and stored in SQLite (`node_role` column)
  - `treasury`: pubkey matches `TREASURY_PUBKEY` env var
  - `member`: has active treasury channel
  - `external`: no treasury channel

### Sync-Driven State
A sync loop runs every 15s (`src/lightning/sync.ts`), pulling LND state into SQLite. The database is the source of truth for metrics, guardrails, and membership. Live LND calls are only used for critical operations (payments, channel opens, apply fee policy). The sync loop upserts current channels/peers and deletes stale rows (closed channels, disconnected peers) each cycle to keep SQLite in sync with LND.

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
SQLite at `data/db/bitcorn.sqlite` (mounted at `/data` inside the API container; on Umbrel host: `/home/umbrel/umbrel/app-data/bitcorn-lightning-node/data/db/bitcorn.sqlite`). Migrations in `src/db/migrations/` (001–032). Migrations must be idempotent and run on startup. Never mutate schema manually. Note: `sqlite3` is not installed in the API Docker image — to query the DB directly, use `sudo sqlite3` on the Umbrel host (the `data/db/` directory is owned by root).

Key tables: `lnd_node_info`, `lnd_channels`, `lnd_peers`, `payments_inbound`, `payments_outbound`, `payments_forwarded`, `treasury_fee_policy`, `treasury_capital_policy`, `treasury_expansion_recommendations`, `treasury_expansion_executions`, `treasury_rebalance_costs`, `treasury_rebalance_executions`, `coinbase_onramp_sessions`, `contacts`, `member_keysend_status`, `network_payments`, `rebalance_clusters`, `rebalance_cluster_channels`, `rebalance_fee_policy`, `rebalance_fee_events`, `rebalance_runs`, `rebalance_candidates`, `rebalance_outcomes`, `rebalance_pair_history`, `rebalance_topology_recommendations`, `treasury_inventory_snapshots`, `member_liquidity_recommendations`, `member_liquidity_estimates`, `member_liquidity_outcomes`, `member_liquidity_config`, `member_channel_classifications`, `member_liquidity_advisor_config`.

**Seed scripts** in `seeds/` are run manually by the treasury operator after migrations create the tables. `seeds/001_initial_clusters.sql` provisions initial cluster configuration from live `lnd_channels` + `contacts` data.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | All HTTP routes (600+ lines) |
| `src/lightning/sync.ts` | Main sync orchestrator |
| `src/lightning/persist-channels.ts` | Channel + peer sync to SQLite (upsert current, delete stale) |
| `src/lightning/lnd.ts` | LND client, TLS + macaroon setup |
| `src/lightning/loop.ts` | loopd gRPC client (Lightning Terminal subserver) |
| `src/lightning/rebalance-loop.ts` | Loop Out rebalance execution + auto-select + monitoring |
| `src/lightning/rebalance-scheduler.ts` | Scheduled Loop Out rebalance loop |
| `src/lightning/rebalance-circular.ts` | Circular rebalance execution (legacy — not used in hub-and-spoke) |
| `src/rebalance/rebalanceScheduler.ts` | Cluster rebalance engine orchestrator — 15-min interval, fee steering + circular rebalance + topology |
| `src/rebalance/clusterState.ts` | Reads cluster definitions + live LND balances + forwarding volumes → `ClusterState[]` |
| `src/rebalance/feeSteering.ts` | Per-cluster fee adjustment (below_band → raise, above_band → lower, hysteresis return to baseline) |
| `src/rebalance/cycleEnumerator.ts` | Candidate enumeration: amount bucketing, channel selection, route probing |
| `src/rebalance/cycleScorer.ts` | Benefit/cost scoring, picks best candidate or no_action |
| `src/rebalance/rebalanceExecutor.ts` | Executes circular payment, records outcome, updates pair history |
| `src/rebalance/topologyMonitor.ts` | Detects structural issues, emits recommendations, takes inventory snapshots |
| `src/api/treasury.ts` | Aggregate treasury metrics |
| `src/api/treasury-liquidity-health.ts` | Per-channel liquidity assessment |
| `src/api/treasury-expansion.ts` | Channel expansion recommendations & execution |
| `src/utils/capital-guardrails.ts` | Pre-expansion policy enforcement |
| `src/config/env.ts` | All environment variables with defaults |
| `src/lightning/pay.ts` | Pay invoice — auto-detects treasury channel via `TREASURY_PUBKEY` and forces `outgoing_channel` so member payments always route through the hub |
| `src/lightning/network-payments.ts` | Network payment business logic (create invoice, pay, history, settlement sync) |
| `src/memberLiquidity/liquidityDetector.ts` | Treasury-side: detects member channel imbalances from cluster data |
| `src/memberLiquidity/liquidityAdvisor.ts` | Treasury-side: computes keysend push estimates for member top-ups |
| `src/memberLiquidity/liquidityExecutor.ts` | Treasury-side: executes keysend push to member |
| `src/memberLiquidity/liquidityRoutes.ts` | Treasury-side: route handlers for `/api/member-liquidity/*` |
| `src/memberAdvisor/channelClassifier.ts` | Member-side: classifies treasury channel state (5 states × 3 urgencies) |
| `src/memberAdvisor/loopAvailability.ts` | Member-side: checks Loop daemon availability and terms |
| `src/memberAdvisor/recommendationEngine.ts` | Member-side: role-aware recommendations — separate merchant (Loop In), farmer (Loop Out), unknown (set role) paths; channel upgrade for structural undersizing |
| `src/memberAdvisor/liquidityAdvisorRoutes.ts` | Member-side: route handlers for `/api/liquidity/*` |
| `src/memberAdvisor/advisorScheduler.ts` | Member-side: 15-min scheduler (skips treasury nodes) |
| `src/api/coinbase-onramp.ts` | Calls Cloudflare Worker to obtain a Coinbase session token |
| `cloudflare-worker/src/index.ts` | Cloudflare Worker: Coinbase Onramp (POST /), commodity prices (GET /prices), KV caching |

## Role-Based Access Control

- **Public**: `/health`, `/api/node`, `/api/node/balances`, `/api/node/preflight`, `/api/coinbase/onramp-url`, `/api/commodity-prices`, `/api/peers`, `/api/channels`, `/api/channels/pending`, `/api/member/stats`, `POST /api/member/open-channel`, `/api/contacts`, `POST /api/contacts`, `PATCH /api/contacts/:pubkey`, `DELETE /api/contacts/:pubkey`, `POST /api/contacts/sync-peers`, `GET /api/exchange-rate`, `POST /api/network/invoice`, `POST /api/network/decode`, `GET /api/network/payments`, `POST /api/network/sync-settlements`, `GET /api/liquidity/status`, `GET /api/liquidity/history`, `PATCH /api/liquidity/config`
- **Member** (active treasury channel): `POST /api/pay`, `POST /api/network/pay`
- **Treasury only**: All `/api/treasury/*` endpoints (includes Loop Out: `GET /api/treasury/rebalance/loop-out/terms`, `GET .../quote`, `GET .../status`, `POST .../loop-out`, `POST .../loop-out/auto`; Peers: `GET /api/treasury/peers/live`, `POST /api/treasury/peers/connect`), all `/api/member-liquidity/*` endpoints (cluster overview, recommendations, estimates, approve/reject, outcomes)

Role is derived from identity + treasury channel state — not bearer tokens.

`/api/member/stats` returns: `hub_pubkey`, `membership_status`, `node_role`, `is_peered_to_hub` (bool — live LND peer check, best-effort), `treasury_channel` (balances/capacity/active or null), `forwarded_fees` (24h / 30d / all-time), `keysend_enabled`.

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
| `app/web/src/components/PowerLawChart.tsx` | Bitcoin Power Law chart — recharts ComposedChart, log Y axis, percentile bands (p2.5/p16.5/p83.5/p97.5), trend line, live spot price overlay, downsampling; fills gap days with live Coinbase price so chart extends to today |
| `app/web/src/components/MovingAveragesChart.tsx` | BTC Moving Averages chart — recharts LineChart, linear Y axis, 50/100/200-day MA lines over daily BTC price; reuses power-law-data.json, computes MAs client-side over full dataset before slicing to visible window; exports `computeMA`; periods: 1M/1Y/5Y/10Y |
| `app/web/src/components/CornBitcoinChart.tsx` | Corn-Bitcoin ratio chart — recharts LineChart, shows bushels of corn per 1 BTC; fetches monthly corn history from `/api/corn-history`, interpolates to daily, divides BTC price by corn price; exports `interpolateCornPrices`; periods: 1M/1Y/5Y/10Y |
| `app/web/src/components/CornMovingAveragesChart.tsx` | Corn Price Moving Averages chart — recharts LineChart, corn price (green) with 50/100/200-day MA overlays; imports `computeMA` from MovingAveragesChart and `interpolateCornPrices` from CornBitcoinChart; periods: 1M/1Y/5Y/10Y |
| `app/web/src/components/CommodityPricesPanel.tsx` | Price ticker strip — BTC + 4 commodities (gold, corn, soy, wheat) with color-coded SVG icons; fetches from `/api/commodity-prices`, 60min refresh; wraps on mobile |
| `app/web/src/data/power-law-data.json` | Power law dataset — ~10,000 daily entries from 2015-01-01 to 2042-05-31, includes btc price + trend + percentile bands; bundled by Vite; BTC prices go stale — chart fills nulls up to today with live Coinbase price |
| `app/web/src/pages/Charts.tsx` | Charts page — PowerLawChart (1Y/5Y/All/2042), PriceTickerStrip, MovingAveragesChart (1M/1Y/5Y/10Y), CornBitcoinChart (1M/1Y/5Y/10Y), CornMovingAveragesChart (1M/1Y/5Y/10Y); fetches Coinbase spot price and passes to charts; available to both treasury and member shells |
| `app/web/src/pages/Contacts.tsx` | Contacts page — full CRUD address book, search, inline edit/delete, channel balance bars, tag pills, sync-from-peers; `resolveContactName()` in `client.ts` maps pubkeys to contact names |
| `app/web/src/pages/Dashboard.tsx` | Treasury dashboard (simplified v1.9.46): Node Balances → Fund Node → Bitcoin Price → Alerts (if any) → Treasury Revenue (forwarding fees / rebalance costs / net revenue 24h + all-time + capital stats). Other data moved to dedicated pages. |
| `app/web/src/pages/WithdrawBitcoin.tsx` | Member Loop Out withdrawal page. Prominent Available Balance card (amber-tinted), amount input with commas + sats + Max button, destination address with auto-generate, fee breakdown showing net fee separated from prepay hold, recent withdrawals table. Routes: `/withdraw` + `/cashout` (farmer) + `/refill` (merchant — currently shares page) |
| `app/web/src/pages/SwapOperations.tsx` | Treasury Loop Out / Loop In tabs, visual channel picker (compact chips), formatted amount inputs, swap history |
| `app/web/src/components/NetworkGraph.tsx` | SVG hub-and-spoke network topology with zoom/pan (40–300%). Treasury at center, peers radial with color-coded roles. Rendered on Liquidity page (v1.9.34+) |
| `app/web/src/pages/Wizard.tsx` | 5-screen treasury setup wizard |
| `app/web/src/pages/MemberDashboard.tsx` | Member view: `ConnectToHub` form (no channel, with pending channel detection), or role-aware earnings panel (merchant: outbound capacity gauge; farmer: grain-bin fill gauge; unknown: set-role prompt) + advisor-driven alerts + forwarded fees |
| `app/web/src/pages/Peers.tsx` | Treasury view: connect to new nodes by URI, onboarding guide, live connected peers table with contact name resolution |
| `app/web/src/pages/MemberLiquidity.tsx` | Treasury view: Member Liquidity page — cluster overview, pending top-up recommendations with approve/reject, top-up history, member channel health observability table |
| `app/web/src/pages/Payments.tsx` | Network payments: Request Payment (QR + BOLT11), Pay Invoice (paste + decode + pay), Payment History table with clickable rows (detail view shows QR/BOLT11 for received, summary for sent) |
| `app/web/src/styles.css` | Full design system |
| `app/web/src/config/api.ts` | `API_BASE` constant |

**`ConnectToHub` component** (inside `MemberDashboard.tsx`): shown when `treasury_channel` is null and no pending treasury channel opening. Checks `/api/channels/pending` every 15s — if a pending open to the treasury exists, shows "Channel Opening Submitted" instead of the form. Shows capacity presets (1M / 5M / 10M sats), formatted text input with commas + sats label (free-form entry, 100k minimum validation message), and one of three peering states: green "Connected to hub — ready to open a channel" (direct LND peer check via `getLndPeers()`), amber "Hub address available — will connect automatically when you open a channel" (Worker socket available), or manual address input. Calls `api.openMemberChannel()` → transitions to a success state showing the funding txid. Keysend preflight check removed (v1.9.9).

**3-column stat grids:** `dashboard-grid` CSS class defaults to `1fr 1fr`. Override inline with `style={{ gridTemplateColumns: "1fr 1fr 1fr" }}` when 3 cards are needed (hub channel stats, forwarded fees).

**API client pattern:** All calls go through `api.*` methods defined in `client.ts`. Add new endpoints there as `api.methodName: () => apiFetch<ReturnType>("/api/path")`. Types live in the same file.

**`FundNodePanel` component** (`app/web/src/components/FundNodePanel.tsx`): rendered below `NodeBalancePanel` on both dashboards. Calls `api.getNodeBalances()` on mount (one-shot, no poll) and displays on-chain balance; falls back to `0 sats` on fetch error (no infinite shimmer). "Fund Node via Coinbase →" button calls `api.getCoinbaseOnrampUrl()` → opens the returned URL in a new tab (`window.open`, `noopener,noreferrer`). Maps machine-readable API error `coinbase_not_configured` to operator-readable message. Returns 503 if `COINBASE_APP_ID` or `COINBASE_WORKER_URL` env var is unset. Flow: button → `GET /api/coinbase/onramp-url` → `coinbase-onramp.ts` POSTs to Cloudflare Worker → Worker signs CDP JWT, calls `POST api.developer.coinbase.com/onramp/v1/token` → returns `{ sessionToken }` → API builds `https://pay.coinbase.com/buy/select-asset?appId=...&sessionToken=...` and returns it to the frontend.

**`NodeBalancePanel` component** (`app/web/src/components/NodeBalancePanel.tsx`): shared component rendered at the top of both `Dashboard.tsx` (treasury) and `MemberDashboard.tsx`. Calls `api.getNodeBalances()` on mount, polls every 15s. Shows three stat cards: Total Node Balance, Bitcoin Balance, Lightning Wallet — each displaying sats and BTC (8 decimal places). Uses loading shimmer while data is pending; silently swallows fetch errors (cards stay in shimmer state).

**`PriceTickerStrip` component** (`app/web/src/components/CommodityPricesPanel.tsx`): horizontal strip of 5 compact price tickers (BTC, Gold, Corn, Soy, Wheat) rendered below the Power Law chart on `Charts.tsx`. BTC price is passed down from Charts (Coinbase Spot API); commodity prices fetched from `api.getCommodityPrices()` with 60-minute refresh. Each ticker has a color-coded SVG icon in a tinted pill, colored label, formatted price with dimmed `$`, and unit. Desktop: all 5 in one `flex` row. Mobile (< 600px): `flex-wrap` into 2-column grid (no horizontal scroll). CSS classes: `.price-ticker-strip`, `.price-ticker`, `.price-ticker-icon`, `.price-ticker-label`, `.price-ticker-value`, `.price-ticker-unit`.

**`/api/commodity-prices` endpoint** (public, in `app/api/src/index.ts`): proxies `GET` requests to the Cloudflare Worker's `/prices` endpoint using `COINBASE_WORKER_URL` env var. Returns `{ gold, corn, soybeans, wheat }` where each is `{ price, unit, label, updated_at } | null`. Returns 503 if `COINBASE_WORKER_URL` is unset, 502 if the Worker is down.

**Scroll layout constraint:** `.app-shell` in `styles.css` uses `height: 100vh` (not `min-height`). This is intentional — it constrains the CSS grid to the viewport so that `overflow-y: auto` on `.main-content` triggers correctly. Changing it to `min-height` will break scrolling (the grid grows to fit content, body scrolls instead, and the sidebar disappears). `.main-content` uses `padding-bottom: 64px` to ensure the last panel has breathing room.

**Mobile navigation (< 768px):** On screens under 768px, the sidebar is hidden and replaced by a hamburger menu (☰) in the topbar. Clicking it slides the sidebar in from the left (`transform: translateX(-100%) → translateX(0)`, 200ms ease) over a dark backdrop overlay (`rgba(0,0,0,0.6)`). Menu closes via: X button inside the drawer, clicking the backdrop, or clicking any nav link. Both `AppShell` and `MemberShell` manage a `menuOpen` boolean state, passed as `open`/`onClose` props to their respective sidebar components and `onMenuToggle` to `Topbar`. On mobile, `.dashboard-grid` collapses to single column, `.data-table` gets `min-width: 600px` for horizontal scroll, and `.main-content` padding is reduced. Desktop layout (768px+) is completely unchanged — CSS-only via `@media (max-width: 767px)`.

## Capital Guardrails

Before any channel open, `capital-guardrails.ts` checks: minimum on-chain reserve, max deploy ratio, max pending opens, per-peer capacity cap, peer cooldown period, daily expansion limit, daily total deploy limit. Returns 429 on violation.

## Liquidity Management

Imbalance ratio: `local / (local + remote)`. Classifications: `healthy`, `outbound_starved`, `critical`. Two rebalancing systems:

**Cluster Rebalance Engine v1** (`src/rebalance/`): Three-lever architecture operating on per-peer clusters. Lever 1: fee steering adjusts routing fees based on balance deviation (passive). Lever 2: circular rebalance probes routes and executes self-paying invoices to move sats between clusters (active). Lever 3: topology monitor detects structural issues and emits advisory recommendations. Runs on a 15-min interval, gated by `CLUSTER_REBALANCE_ENABLED=true`. Clusters are provisioned via `seeds/001_initial_clusters.sql` and define target bands (min/mid/max local balance percentages) per peer.

**Loop Out** is the complementary strategy for restoring inbound capacity: submarine swaps via Lightning Terminal (loopd) move sats off-chain through a channel and return them on-chain minus fees — total balance preserved, receive capacity restored. Only targets critical channels (>85% local). Verified on mainnet with Loop v0.31.8-beta (terms: 250k–240M sats per swap). See `docs/LOOP_SETUP.md` for setup. Keysend push rebalance is disabled (sends sats as one-way payments).

**Loop Out production notes:** loopd runs inside litd (Lightning Terminal) on port 8443. The gRPC client uses `grpc.ssl_target_name_override: "localhost"` because litd's TLS cert SANs don't include Docker DNS names. litd must be configured with `--httpslisten=0.0.0.0:8443` (default binds localhost only). The `OutQuoteResponse` proto uses `htlc_sweep_fee_sat` for the miner fee field. Loop prepay is ~30,000 sats flat per swap. Minimum swap is 250,000 sats with a 50% channel capacity safety cap. Channel ID conversion: ln-service short format (`NxNxN`) must be converted to uint64 for loopd proto via `(block << 40) | (tx << 16) | output` using BigInt; proto-loader uses `longs: String` to preserve precision. **Minimum channel capacity for Loop Out:** routing peers like ACINQ cap `max_value_in_flight_msat` at ~45% of channel capacity — a 500k channel only allows 225k HTLCs, below Loop's 250k minimum. Need ≥556k capacity to the routing peer. After restarting LND, litd must also be restarted (`apps.restart.mutate --appId lightning-terminal`) or its Loop subserver will show "not ready".

**Treasury-side member liquidity** (`src/memberLiquidity/`): Detects member channel imbalances from cluster data (Step 9 in rebalance scheduler, 2-consecutive-run debounce). Computes keysend push estimates (60s TTL, ~0 routing fee). Treasury operator approves/rejects via Member Liquidity page. Execution: `keysendPush()` to member. Single action type: `treasury_push_topup`. Migration 026 (4 tables). Endpoints: `GET /api/member-liquidity/clusters`, `GET .../recommendations`, `GET .../estimate`, `POST .../approve`, `POST .../reject`, `GET .../outcomes`.

**Member-side liquidity advisor** (`src/memberAdvisor/`): Runs locally on member nodes every 15 minutes (skips treasury nodes). Classifies treasury channel into 5 states: `healthy` (30–70% member-local), `send_heavy` (>70%), `send_saturated` (>85%), `receive_heavy` (<30%), `receive_exhausted` (<15%). Urgency escalates on consecutive non-healthy runs. **Role-aware recommendations** (v1.9.12): `channel_role` stored in `member_liquidity_advisor_config` (migration 032), defaults to `unknown`. Merchant path: low outbound → Loop In, undersized (< 2M recommended) or repeated depletion (3+ runs) → channel upgrade. Farmer path: high local → Loop Out, undersized (< 1M recommended) or repeated filling → channel upgrade. Unknown: prompts to set role. Close/reopen is never recommended. `PATCH /api/liquidity/config` sets the role. Channel Role picker in Settings page (v1.9.13). Endpoints: `GET /api/liquidity/status`, `GET /api/liquidity/history`, `PATCH /api/liquidity/config`. Migrations 027, 028, 032.

**Loop Out prepay model**: The ~30,000 sat prepay is a temporary hold sent during the swap and returned as part of the on-chain payment — it is NOT an additional fee. Actual net fee is swap_fee + miner_fee (~1-2k sats). The withdrawal quote UI shows net fee separately from the prepay explanation. Policy checks and stored `quoted_fee_sat` use net fee (v1.9.16–v1.9.21). `maxPrepay` sent to loopd is a constant 50,000 (safe ceiling).

**Expansion execution lifecycle**: `treasury_expansion_executions` tracks channel opens. Status transitions: `requested` → `succeeded` (on funding tx broadcast) or `failed` (on error). The sync loop auto-cleans stale `requested`/`submitted` records older than 1 hour to prevent ghost pending sats from blocking capital guardrails (v1.9.26).

Keysend enforcement: backend `member_keysend_status` table tracks peers that reject keysend; auto-rebalancer skips disabled peers for 24h then retries. `MEMBER_KEYSEND_DISABLED` alert (warning severity) shows on treasury dashboard. **Keysend preflight UI removed from member dashboard** (v1.9.9) — the preflight check, "Configuration Required" block, and keysend warning banner are no longer shown to members.

**LND 0.20.0 compatibility** (v1.9.24): `getForwards` pagination changed — `limit` cannot be passed alongside a pagination `token`. The sync loop's `syncForwardingHistory` now only passes `limit` on the first page.

## v1.9 Changelog Summary

The v1.9 series was a comprehensive UX and architecture pass. Key landmarks:

| Version | Area | Change |
|---------|------|--------|
| 1.9.0 | Member dashboard | Earnings-focused redesign |
| 1.9.1 | Treasury Channels | Merchant/Farmer/External lanes |
| 1.9.4 | Contacts | Tag editor with merchant/farmer toggle buttons |
| 1.9.5 | **Architecture** | Separate lane purpose (stable) from lane state (dynamic) |
| 1.9.7 | Member Connect | Accurate "Connected to hub" copy (peer check, not gossip) |
| 1.9.8 | Member Connect | Pending channel survives page reload |
| 1.9.9 | Member | Removed keysend UI warnings |
| 1.9.10–11 | Inputs | Formatted capacity inputs (commas, sats label, validation) |
| 1.9.12 | **Architecture** | Role-aware liquidity advisor (merchant/farmer/unknown) |
| 1.9.13 | Member Settings | Channel Role picker |
| 1.9.15–21 | Withdrawal | Prepay is a hold not a fee — propagated through quote/policy/stored-fee/loopd |
| 1.9.17 | Farmer UX | Grain bin gauge fills up |
| 1.9.22 | Treasury | Formatted channel open inputs |
| 1.9.23–24 | LND 0.20 | Sync error logging + `getForwards` pagination fix |
| 1.9.25 | **New page** | Treasury Peers (connect + onboarding guide) |
| 1.9.26 | Treasury | Auto-clean stale expansion executions |
| 1.9.28 | Contacts | Sync-peers includes connected peers without channels |
| 1.9.30 | Treasury Settings | Formatted capital guardrails inputs |
| 1.9.33 | Member payment | Pre-flight checks treasury channel, not total balance |
| 1.9.34–36 | **New feature** | Network Topology graph with zoom/pan |
| 1.9.37–38 | Treasury Swaps | Channel picker + clean layout |
| 1.9.40–43 | Treasury Settings | Compact layout, consolidated Appearance, max-width |
| 1.9.44–45 | Channel open | Fee rate selector (Economy/Normal/Priority) with cost/time estimates |
| 1.9.46 | **Architecture** | Dashboard revamp — 1100 → 170 lines, revenue-focused |
| 1.9.47 | Treasury Settings | Routing Fee Policy panel (no more `lncli` commands) |
| 1.9.49 | Sync | Auto-settle invoice receives every 15s |
| 1.9.50 | **Architecture** | Role-aware sidebar — Cash Out (farmer) vs Refill Channel (merchant) |
| 1.9.53 | Withdrawal | Prominent Available Balance card |

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
- Three endpoints:
  - `POST /` — Coinbase Onramp: accepts `{ address: string }` → returns `{ sessionToken: string }`
  - `GET /prices` — Commodity prices (gold, corn, soybeans, wheat) cached in KV for 24h
  - `GET /prices/corn-history` — Historical monthly corn PRICE RECEIVED from USDA NASS (2014+), cached in KV for 24h; returns `[{ year, month, price }]`
- Secrets stored in Cloudflare (never in git): `CDP_KEY_NAME`, `CDP_PRIVATE_KEY`, `USDA_NASS_KEY`, `GOLD_API_KEY`
- CDP keys are SEC1 format (`-----BEGIN EC PRIVATE KEY-----`); Worker converts to PKCS#8 for the Web Crypto API via `sec1ToPkcs8Pem()`
- Gold price from goldapi.io (100 requests/month free tier); grain prices from USDA NASS API (free, no limit)
- KV namespace `PRICES_CACHE` caches the combined JSON for 24 hours to minimize upstream API calls

### Redeploying the Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy          # redeploy code changes
# Update secrets (paste value, then Ctrl-D):
npx wrangler secret put CDP_KEY_NAME
npx wrangler secret put CDP_PRIVATE_KEY
npx wrangler secret put USDA_NASS_KEY
npx wrangler secret put GOLD_API_KEY
```

**Secret format:** paste the raw key name / raw PEM from the CDP JSON file — do **not** wrap in quotes. Wrangler tails: `npx wrangler tail` for live Worker logs.

**Clear price cache** (e.g. after changing API keys): `npx wrangler kv key delete commodity_prices --namespace-id=62c68c41830141cc8b0b6e7cdb193461`

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
- `REBALANCE_MAX_FEE_PPM` — default `1000` (0.1%); max fee-to-amount ratio the scheduler will tolerate. Prevents net-negative micro-rebalances when token amounts are small due to tight liquidity. At default, a 5,000 sat rebalance caps effective fee at 5 sats.
- `LOOP_GRPC_HOST` — default `lightning-terminal_web_1` (litd container DNS on Umbrel)
- `LOOP_GRPC_PORT` — default `8443` (litd unified gRPC port)
- `LOOP_TLS_CERT_PATH` — default `/loop-data/.lit/tls.cert`
- `LOOP_MACAROON_PATH` — default `/loop-data/.loop/mainnet/loop.macaroon`
- `LOOP_MAX_SWAP_FEE_PCT` — default `0.5` (max swap fee as % of amount)
- `LOOP_MAX_MINER_FEE_SATS` — default `20000`
- `LOOP_MIN_REBALANCE_SATS` — default `50000` (auto-mode minimum)
- `LOOP_CONF_TARGET` — default `6` (on-chain confirmation target)
- `CLUSTER_REBALANCE_ENABLED` — default `false`; set to `true` to enable the cluster-based rebalance engine (fee steering + circular rebalance + topology monitoring)
- `CLUSTER_REBALANCE_INTERVAL_MS` — default `900000` (15 minutes); interval between rebalance engine runs
- `COINBASE_APP_ID` — Coinbase Developer Platform Project ID; set in `docker-compose.yml`; if unset, `GET /api/coinbase/onramp-url` returns 503. **Not a secret** — it is embedded in the Onramp URL visible to users.
- `COINBASE_WORKER_URL` — URL of the Cloudflare Worker that holds CDP credentials and mints session tokens (e.g. `https://bitcorn-onramp.ethancail.workers.dev`); set in `docker-compose.yml`. Required; if unset, `GET /api/coinbase/onramp-url` returns 503.
