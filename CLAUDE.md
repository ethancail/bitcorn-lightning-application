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
| `docs/COINBASE_INTEGRATION.md` | Future Coinbase OAuth2 flow (not yet implemented) |

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
Channel expansion engine, capital guardrails (reserve, deploy ratio, per-peer caps, cooldowns, daily limits), circular rebalance engine, auto channel selection, rebalance scheduler, rebalance cost ledger, treasury metrics API, dual-role web UI (treasury dashboard + member dashboard with in-app channel creation), gossip-aware peer detection for frictionless member onboarding.

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
SQLite at `data/bitcorn.db`. Migrations in `src/db/migrations/` (001–018). Migrations must be idempotent and run on startup. Never mutate schema manually.

Key tables: `lnd_node_info`, `lnd_channels`, `lnd_peers`, `payments_inbound`, `payments_outbound`, `payments_forwarded`, `treasury_fee_policy`, `treasury_capital_policy`, `treasury_expansion_recommendations`, `treasury_expansion_executions`, `treasury_rebalance_costs`, `treasury_rebalance_executions`.

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

## Role-Based Access Control

- **Public**: `/health`, `/api/node`, `/api/peers`, `/api/channels`, `/api/member/stats`, `POST /api/member/open-channel`
- **Member** (active treasury channel): `POST /api/pay`
- **Treasury only**: All `/api/treasury/*` endpoints

Role is derived from identity + treasury channel state — not bearer tokens.

`/api/member/stats` returns: `hub_pubkey`, `membership_status`, `node_role`, `is_peered_to_hub` (bool — live LND peer check, best-effort), `treasury_channel` (balances/capacity/active or null), `forwarded_fees` (24h / 30d / all-time).

`POST /api/member/open-channel` accepts `{ capacity_sats, partner_socket? }`. Validates capacity ≥ 100,000 sats, optionally calls `connectToPeer(hubPubkey, socket)` if socket provided, then calls `openTreasuryChannel`. Returns `{ ok, funding_txid }`.

## Frontend Architecture

**Stack:** React 18 + TypeScript + Vite, react-router-dom v6, amber-on-black design system.

**Design system** lives entirely in `app/web/src/styles.css`. Key CSS custom properties: `--bg`, `--amber`, `--green`, `--red`, `--mono`, `--sans`. Key classes: `.panel`, `.panel-header`, `.panel-title`, `.panel-body`, `.stat-card`, `.stat-value`, `.stat-label`, `.stat-sub`, `.dashboard-grid`, `.data-table`, `.td-mono`, `.td-num`, `.badge-green/.red/.amber/.blue/.muted`, `.btn`, `.btn-primary/.outline/.ghost`, `.form-input`, `.loading-shimmer`, `.empty-state`, `.alert.critical/.warning/.info/.healthy`, `.wizard-*`, `.fade-in`.

**Dual-role routing** (`App.tsx`): `useAppStatus()` fetches `/api/node` → branches on `node_role`:
- `"treasury"` + `localStorage.bitcorn_setup_done === "1"` → `AppShell` (treasury dashboard)
- `"treasury"` without localStorage flag → wizard (`/setup`)
- any other role (`"member"`, `"external"`, `"unsynced"`, errors) → `MemberShell`

All non-treasury nodes get the same `MemberShell`. `MemberDashboard` handles the no-channel state contextually with a `ConnectToHub` form — no routing-level gate based on membership status.

`TREASURY_PUBKEY` is **hard-coded** in `docker-compose.yml` as `02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca`. This means all member installs get correct role detection automatically without configuration.

**Key frontend files:**
| File | Purpose |
|------|---------|
| `app/web/src/App.tsx` | Root router, both shells (AppShell + MemberShell), all page stubs |
| `app/web/src/api/client.ts` | `apiFetch<T>` helper, namespaced `api.*` object, all types |
| `app/web/src/pages/Dashboard.tsx` | Treasury dashboard (monolithic: Panel, AlertsBar, NetYield, ChannelROI, PeerScores, Rotation, DynamicFees) |
| `app/web/src/pages/Wizard.tsx` | 5-screen treasury setup wizard |
| `app/web/src/pages/MemberDashboard.tsx` | Member view: `ConnectToHub` form (no channel) or hub channel stats + forwarded fees |
| `app/web/src/styles.css` | Full design system (727 lines) |
| `app/web/src/config/api.ts` | `API_BASE` constant |

**`ConnectToHub` component** (inside `MemberDashboard.tsx`): shown when `treasury_channel` is null. Shows capacity presets (500k / 1M / 2M sats), number input (min 100k), and either a green "Already connected via gossip" banner (when `is_peered_to_hub: true`) or an optional hub address field. Calls `api.openMemberChannel()` → transitions to a success state showing the funding txid.

**3-column stat grids:** `dashboard-grid` CSS class defaults to `1fr 1fr`. Override inline with `style={{ gridTemplateColumns: "1fr 1fr 1fr" }}` when 3 cards are needed (hub channel stats, forwarded fees).

**API client pattern:** All calls go through `api.*` methods defined in `client.ts`. Add new endpoints there as `api.methodName: () => apiFetch<ReturnType>("/api/path")`. Types live in the same file.

## Capital Guardrails

Before any channel open, `capital-guardrails.ts` checks: minimum on-chain reserve, max deploy ratio, max pending opens, per-peer capacity cap, peer cooldown period, daily expansion limit, daily total deploy limit. Returns 429 on violation.

## Liquidity Management

Imbalance ratio: `local / (local + remote)`. Classifications: `healthy`, `outbound_starved`, `critical`. Circular rebalance forces a payment over path `outgoing_channel → ... → incoming_channel`. Scheduler enabled via `REBALANCE_SCHEDULER_ENABLED=true`, runs every 60s.

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
