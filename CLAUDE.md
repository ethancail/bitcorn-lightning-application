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

These docs are the authoritative reference for how the system works. The sections below are a summary.

---

## Mission & Vision

Bitcorn Lightning is building a **self-managing Lightning Treasury Engine** — a capital optimization engine for Lightning, not a general wallet or passive routing node.

**The treasury node is:**
- The capital allocator
- The expansion authority
- The rebalance scheduler
- The profitability engine

**Member nodes are liquidity consumers only.**

### Design Principles

- **Capital safety first** — guardrails are non-negotiable; automation must never bypass them
- **Automation with control** — all automated behavior must be deterministic, observable, auditable, and policy-driven
- **Economic truth over vanity metrics** — optimize for net sats earned, channel ROI, and yield on deployed capital; not channel count or gossip visibility
- **Treasury-only intelligence** — all allocation decisions originate from the treasury

### Development Phases

| Phase | Status | Focus |
|-------|--------|-------|
| 1 — Infrastructure & Risk Controls | Completed | Expansion engine, capital guardrails, circular rebalance, scheduler, cost ledger, metrics API |
| 2 — Intelligent Capital Allocation | In Progress | Channel-level ROI, liquidity scoring, peer performance scoring, expansion ranking |
| 3 — Adaptive LSP Behavior | Future | Dynamic fees, yield-driven reallocation, peer reputation, autonomous pruning |

**Success is:** positive net yield after rebalance costs, controlled capital deployment, measurable ROI on deployed sats.

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
SQLite at `data/bitcorn.db`. Migrations in `src/db/migrations/` (001–015). Migrations must be idempotent and run on startup. Never mutate schema manually.

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

- **Public**: `/health`, `/api/node`, `/api/peers`, `/api/channels`
- **Member** (active treasury channel): `POST /api/pay`
- **Treasury only**: All `/api/treasury/*` endpoints

Role is derived from identity + treasury channel state — not bearer tokens.

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
- `TREASURY_PUBKEY` — required; identifies the treasury node
- `LND_GRPC_HOST` — default `lightning_lnd_1:10009`
- `BITCOIN_NETWORK` — default `mainnet`
- `REBALANCE_SCHEDULER_ENABLED` — default `false`
- `RATE_LIMIT_MAX_SINGLE_PAYMENT` — default `250000` sats
