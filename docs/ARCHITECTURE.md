# Architecture

## Overview

- **API** (`app/api`): HTTP server that talks to LND, persists state in SQLite, and exposes REST endpoints for the UI and treasury operations.
- **Web** (`app/web`): React app for node status, channels, and (future) treasury dashboards.
- **LND**: Lightning node; the app uses gRPC (via ln-service) for wallet info, channels, invoices, forwards, payments, and channel opens.

Data flow is **sync-driven**: a periodic job (and optional manual trigger) pulls LND state into the DB (node info, peers, channels, inbound payments, forwarding history). Payments and treasury actions are then driven off this persisted state plus live LND calls where needed.

## Node roles

The app distinguishes three roles derived from the node’s identity and treasury channel:

- **treasury**: This node’s pubkey equals the configured treasury pubkey. Can access all treasury endpoints (metrics, fee policy, liquidity health, expansion, capital policy).
- **member**: Has an active channel to the treasury. Can use the pay endpoint and see node/channel status.
- **external**: No treasury channel or not synced. Limited to health and (if exposed) read-only node info.

Role is stored in `lnd_node_info.node_role` and updated on each sync. Treasury-only routes enforce `node_role === "treasury"` and return 403 otherwise.

## Sync loop

On a timer (and on startup), the API:

1. Fetches LND wallet info, peers, and channels.
2. Persists peers and channels to `lnd_peers` and `lnd_channels`.
3. Determines whether the node has a treasury channel and if it’s active, then computes `membership_status` (e.g. `active_member`, `no_treasury_channel`) and `node_role`.
4. Writes node info (and history) to `lnd_node_info` / `lnd_node_info_history`.
5. Syncs confirmed inbound invoices to `payments_inbound`.
6. Paginates LND forwarding history into `payments_forwarded`.

So the DB always holds a recent view of node identity, channels, and payment/forward history for metrics and guardrails.

## Main flows

- **Pay:** Client POSTs a BOLT11 invoice. API decodes it, checks membership and rate limits (using `payments_outbound`), calls LND to pay, then records the attempt (success or failure) in `payments_outbound`.
- **Treasury metrics:** Read layer aggregates `payments_inbound`, `payments_outbound`, `payments_forwarded`, and `lnd_channels` to compute all-time/24h net flow, liquidity, and capital efficiency. Treasury-only.
- **Fee policy:** Treasury can GET/POST routing fee policy; POST persists to `treasury_fee_policy` and applies to LND via ln-service. Treasury-only.
- **Liquidity health:** Per-channel imbalance ratio and classification (e.g. outbound_starved, healthy), plus 24h forward velocity and a recommended action. Treasury-only.
- **Expansion:** Treasury can fetch expansion recommendations (from liquidity health) and execute a channel open to a peer. Execution is guarded by capital policy and recorded in `treasury_expansion_executions`. Treasury-only.
- **Capital guardrails:** Before any channel open, the API checks a stored capital policy (reserve, deploy ratio, pending opens, per-peer caps, cooldowns, daily limits) and rejects with 429 if a limit would be exceeded.

## Configuration

Environment variables drive behavior (see `app/api/src/config/env.ts`). Examples:

- **Identity / network:** `TREASURY_PUBKEY`, `BITCOIN_NETWORK`, `LND_GRPC_HOST`
- **Pay limits:** `RATE_LIMIT_TX_PER_MINUTE`, `RATE_LIMIT_SATS_PER_MINUTE`, `RATE_LIMIT_SATS_PER_HOUR`, `RATE_LIMIT_MAX_SINGLE_PAYMENT`
- **Debug:** `DEBUG`, `NODE_ENV`

Paths for LND TLS and macaroon are fixed under `/lnd` for the container; DB path under `/data/db`.
