# Implementation Notes

Short guide for engineers: what exists and where it lives. No secrets or deep internals.

## Payments and membership

- **Pay:** Decode BOLT11 → enforce active membership → enforce rate limits (DB-backed) → call LND `payViaPaymentRequest` → record result in `payments_outbound`. See `app/api/src/index.ts` (POST `/api/pay`) and `app/api/src/lightning/pay.ts`.
- **Membership:** Derived in sync from LND sync status, presence of a treasury channel, and that channel’s active flag. Stored in `lnd_node_info.membership_status`. Guard in `app/api/src/utils/membership.ts`.
- **Rate limits:** Configurable caps (tx/min, sats/min, sats/hour, max single payment) applied against `payments_outbound`. See `app/api/src/utils/rate-limit.ts`.

## LND and sync

- **Client:** TLS + macaroon in `app/api/src/lightning/lnd.ts`. Wrappers for wallet info, peers, channels, invoices, forwards, chain balance, and channel open.
- **Sync:** `app/api/src/lightning/sync.ts` runs the full sync; persist logic in `persist.ts`, `persist-channels.ts`, `persist-inbound.ts`, `persist-forwarded.ts`, `persist-payments.ts`. Node role is derived in sync and written with node info.

## Treasury metrics and fee policy

- **Metrics:** `app/api/src/api/treasury.ts` aggregates inbound, outbound, outbound fees, and forwarded fees (all-time and last 24h), computes net flow and liquidity from DB, and adds capital efficiency (yield, revenue per 1M sats, runway). Used by GET `/api/treasury/metrics`.
- **Channel metrics:** `app/api/src/api/treasury-channel-metrics.ts` aggregates forwards by channel, joins with `lnd_channels`, and computes volume, fees, fee-per-1k, ROI, liquidity efficiency, and payback days (from 24h fee rate). Used by GET `/api/treasury/channel-metrics`.
- **Fee policy:** Stored in `treasury_fee_policy`; read/write in `app/api/src/api/treasury-fee-policy.ts`. Apply to LND in `app/api/src/lightning/fees.ts` via ln-service. GET/POST `/api/treasury/fee-policy` in `index.ts`.

## Liquidity health

- **Health:** `app/api/src/api/treasury-liquidity-health.ts` uses `lnd_channels` and `payments_forwarded` (24h) to compute per-channel imbalance ratio, health classification (e.g. outbound_starved, healthy), 24h velocity, and a recommended action (none / monitor / expand). GET `/api/treasury/liquidity-health` returns this list.

## Expansion engine

- **Recommendations:** `app/api/src/api/treasury-expansion.ts` builds recommendations from liquidity health (e.g. outbound_starved/critical with negative velocity), suggests capacity to move toward a target local ratio, and assigns a priority score. Optionally persisted to `treasury_expansion_recommendations`. GET `/api/treasury/expansion/recommendations`.
- **Execute:** POST `/api/treasury/expansion/execute` validates treasury + synced, then runs capital guardrails (see below), then checks balance and peer connected, creates a row in `treasury_expansion_executions`, calls LND to open channel, and updates the row with funding txid or error. LND helpers in `lnd.ts` (`openTreasuryChannel`, `getLndChainBalance`, etc.).

## Capital guardrails

- **Policy:** Single-row table `treasury_capital_policy` (migration 013). Read/write in `app/api/src/api/treasury-capital-policy.ts`. GET/POST `/api/treasury/capital-policy` for treasury-only view/update.
- **Enforcement:** `app/api/src/utils/capital-guardrails.ts` exports `assertCanExpand(peerPubkey, capacitySats)`. It loads policy, reads pending/deployed/daily/peer stats from DB, gets chain balance from LND, and enforces: min on-chain reserve, max deploy ratio, max pending opens, max sats per peer, peer cooldown, max expansions per day, max daily deploy. Throws `CapitalGuardrailError` with a clear message on violation. Called in the expansion execute flow before creating an execution or opening a channel; 429 returned on violation.

## Frontend

- **Web app:** `app/web/src/App.tsx` fetches `/api/node` and `/api/channels` on an interval and shows node status (including membership/role) and channel list. API base URL from `app/web/src/config/api.ts`.

## Types and config

- **LND types:** `app/api/src/types/ln-service.d.ts` declares ln-service interfaces used by the app.
- **Node type:** `app/api/src/types/node.ts` (e.g. `NodeInfo`, `NodeRole`).
- **Env:** `app/api/src/config/env.ts` centralizes environment variables (treasury pubkey, network, rate limits, debug).
