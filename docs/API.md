# API Reference

Base URL is the API container (see `docker-compose.yml`). All responses are JSON unless noted. CORS allows `*` for configured methods (`GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS`).

## Access Rules

- **Public:** No role check
- **Member:** Requires `membership_status === "active_member"`
- **Treasury:** Requires `node_role === "treasury"`; returns 403 otherwise
- **Member-node local (stablecoin):** identity is the local node's own pubkey; gated by local-network CORS — no role check, no bearer token

Role is derived from identity + treasury channel state — not bearer tokens.

## Public Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness and DB check |
| POST | `/lnd/sync` | Trigger full LND sync |
| GET | `/api/node` | Current node info (`node_role`, `membership_status`, etc.) |
| GET | `/api/node/balances` | Total / on-chain / lightning balances |
| GET | `/api/node/preflight` | Pre-flight check array (e.g. `keysend_enabled`) |
| GET | `/api/peers` | Persisted peers |
| GET | `/api/channels` | Persisted channels |
| GET | `/api/channels/pending` | Pending channel opens (for ConnectToHub reload persistence) |
| GET | `/api/member/stats` | Hub pubkey, membership, role, is_peered_to_hub, treasury_channel, forwarded_fees (24h/30d/all-time), keysend_enabled |
| POST | `/api/member/open-channel` | Open channel to hub (`{ capacity_sats, partner_socket? }`, min 100k) |
| GET | `/api/contacts` | List contacts |
| POST | `/api/contacts` | Create contact |
| PATCH | `/api/contacts/:pubkey` | Update contact |
| DELETE | `/api/contacts/:pubkey` | Delete contact |
| POST | `/api/contacts/sync-peers` | Import channel peers + live connected peers |
| GET | `/api/exchange-rate` | BTC/USD from Coinbase Spot (best-effort) |
| POST | `/api/network/invoice` | Create BOLT11 invoice (Request Payment) |
| POST | `/api/network/decode` | Decode BOLT11 for preview |
| GET | `/api/network/payments` | Payment history |
| POST | `/api/network/sync-settlements` | Match pending receives against `payments_inbound` |
| GET | `/api/liquidity/status` | Member-side advisor classification + recommendation |
| GET | `/api/liquidity/history` | Past classifications |
| PATCH | `/api/liquidity/config` | Set member advisor config (including `channel_role`) |
| GET | `/api/coinbase/onramp-url` | Build Coinbase Onramp URL via Cloudflare Worker session token |
| GET | `/api/commodity-prices` | Gold / corn / soybeans / wheat (proxied from Worker) |
| GET | `/api/corn-history` | Historical monthly corn price (proxied from Worker) |

## Member Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/pay` | Pay a BOLT11 invoice (`{ payment_request }`). Forces `outgoing_channel` to treasury. |
| POST | `/api/network/pay` | Pay via network payment flow (recorded in `network_payments` + `payments_outbound`) |

## Stablecoin Endpoints (member-node local)

Member-facing surface of the BASE/USDC rail (**pre-mainnet** — currently runs against Base Sepolia). Identity is the local node's own pubkey — same trust model as the subscription endpoints: local-node identity + local-network CORS, not role checks or bearer tokens. See `docs/ARCHITECTURE.md` § Stablecoin Rail.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/stablecoin/wallet/challenge` | Issue SIWE challenge (single-use nonce) for wallet registration |
| POST | `/api/stablecoin/wallet` | Register BASE wallet — verifies the signed SIWE message (EOA or ERC-1271 smart wallet) |
| GET | `/api/stablecoin/wallet` | Wallet registration status |
| DELETE | `/api/stablecoin/wallet` | Unlink the registered wallet |
| GET | `/api/stablecoin/balance` | Cached USDC balance for the registered wallet (from the sync loop) |
| GET | `/api/stablecoin/contract-state` | Cached SettlementRouter governance state (feeBps, paused, fee recipient) + staleness |
| GET | `/api/stablecoin/sync-cursor` | BASE sync-loop cursor + staleness signal |
| GET | `/api/stablecoin/settlements` | Indexed settlement history for the registered wallet (query: `limit`, `before_block` paging) |

## Treasury Endpoints

**Metrics & policy**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/treasury/metrics` | Aggregate metrics (flow, liquidity, capital efficiency) |
| GET | `/api/treasury/channel-metrics` | Per-channel profitability and payback |
| GET | `/api/treasury/fee-policy` | Current routing fee policy |
| POST | `/api/treasury/fee-policy` | Set policy and apply to LND |
| GET | `/api/treasury/liquidity-health` | Per-channel health + recommendations |
| GET | `/api/treasury/capital-policy` | Current capital guardrails |
| POST | `/api/treasury/capital-policy` | Update guardrails (partial body) |
| GET | `/api/treasury/alerts` | Operator alert list, computed on read |

**Alerts** (`GET /api/treasury/alerts`)

Computed on read — nothing is persisted. Each entry is
`{ type, severity: "info" \| "warning" \| "critical", message, data, at }`. Polled every
60s by the treasury Dashboard, which renders only `critical` and `warning`, so an
`info` alert is not shown in the alert list.

Types: `ROTATION_CANDIDATES_PRESENT` · `DAILY_LOSS_CAP_EXCEEDED` ·
`DAILY_LOSS_CAP_NEAR` · `DAILY_EXPANSION_LIMIT_REACHED` · `DAILY_DEPLOY_LIMIT_NEAR` ·
`ONCHAIN_RESERVE_BREACHED` · `ONCHAIN_RESERVE_NEAR` · `SCHEDULER_SIMULATION_MODE` ·
`LOOP_OUT_AVAILABLE` · `LOOP_NOT_INSTALLED` · `MEMBER_KEYSEND_DISABLED` ·
`VALUATION_MANUAL_STALE` · **`LND_FAULT`** · **`ONCHAIN_RESERVE_CHECK_SKIPPED`**

The last two are emitted when the on-chain reserve check cannot complete. Before they
existed, an LND fault made `ONCHAIN_RESERVE_BREACHED` / `_NEAR` silently vanish,
leaving this array **byte-identical to a comfortably-funded treasury** — a capital
guardrail that read healthy because it was silent, not because it passed.

**`ONCHAIN_RESERVE_CHECK_SKIPPED`** — always `critical`. Emitted whenever the reserve
check did not run, whatever the cause. It is deliberately a separate type from
`LND_FAULT`: the fault is *why* the check is missing, this is *what that costs*, and a
consumer must be able to tell "reserve is fine" from "nobody checked". `data.reason` is
`lnd_fault` (a scope reported a fault), `transient` (the follow-up probe found nothing),
or `probe_failed` (the probe itself threw). There are now three observable states where
there were two: breached, passing, and could-not-tell.

**`LND_FAULT`** — emitted only when a scope actually reports a fault. Runs the same
three-scope probe as `/api/node/lnd-probe` (all of `info:read`, `offchain:read`,
`onchain:read`, not just the `onchain:read` the reserve call used — one scope cannot
distinguish a narrowed credential from a broken one). `data.kinds` lists the distinct
fault kinds and `data.scopes` carries the full per-scope report **including the healthy
scopes**, so a partial fault stays legible. Severity is the worst among faulted scopes:
`auth` / `permission` / `files_absent` → `critical`; `malformed` / `connectivity` →
`warning`. That single severity is a display priority forced by the alert shape — no
kind is collapsed.

⚠ A **wedged-but-connected** LND surfaces as `connectivity`/`warning`, which
under-weights it: a permanently wedged LND is as serious as a broken credential. The
distinction is readable in `data.scopes[].detail` (`ETIMEDOUT` for wedged,
`ECONNREFUSED` for refused). The remedy is a distinct seventh fault kind, deferred.

⚠ The probe is deadline-bound (3s), but `getLndChainBalance()` — the reserve call
itself, which runs *before* this path — still carries no deadline, so a wedged LND can
still hang this endpoint. Pre-existing, not addressed by these alert types.

**Expansion**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/treasury/expansion/recommendations` | Recommendations derived from liquidity health |
| POST | `/api/treasury/expansion/execute` | Open channel (`{ peer_pubkey, capacity_sats, is_private? }`) |

**Circular rebalance (legacy — unused in hub-and-spoke)**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/treasury/rebalance/circular` | Manual circular rebalance. Body: `tokens`, `max_fee_sats` (required); `outgoing_channel`, `incoming_channel` (optional — auto-selects best donor/receiver if omitted) |
| GET | `/api/treasury/rebalance/executions` | Rebalance execution history (query: `limit` default 50, max 500) |

**Loop Out (submarine swap)**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/treasury/rebalance/loop-out/terms` | Min/max swap amounts from loopd |
| GET | `/api/treasury/rebalance/loop-out/quote?amount_sats=N` | Quote breakdown (swap fee, miner fee, prepay hold) |
| GET | `/api/treasury/rebalance/loop-out/status` | Loop availability + in-flight swaps |
| POST | `/api/treasury/rebalance/loop-out` | Manual swap (`{ channel_id, amount_sats }`) |
| POST | `/api/treasury/rebalance/loop-out/auto` | Auto-rebalance all critical channels |

**Peers**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/treasury/peers/live` | Live connected peers (with contact resolution, ping) |
| POST | `/api/treasury/peers/connect` | Connect by URI (`pubkey@host:port`) |

**Admin — subscriptions (treasury-only, `assertTreasury`)**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/members` | Stage 5b members list: per-channel-peer subscription state, lane, tier, paid-through, last payment |
| GET | `/api/admin/subscription/revenue` | Per-member on-chain revenue sums (kind=`onchain` only) + dashboard aggregates: total earned (sats/USD-at-receipt), recurring entitlement vs actual for the current policy window, paying/enrolled counts ("paying" = ≥1 confirmed on-chain payment, not tier). Names are joined client-side from contacts |

**Member liquidity (treasury-side, edge-case only)**

Treasury-operator-approved push flow used for initial channel provisioning or edge-case maintenance; not part of steady-state rebalancing. Steady-state member rebalancing is driven by the Member Liquidity Advisor on the member node — see `/api/liquidity/*` above.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/member-liquidity/clusters` | Cluster overview |
| GET | `/api/member-liquidity/recommendations` | Pending top-up recommendations |
| GET | `/api/member-liquidity/estimate` | Keysend push estimate (60s TTL) |
| POST | `/api/member-liquidity/approve` | Approve and execute top-up |
| POST | `/api/member-liquidity/reject` | Reject recommendation |
| GET | `/api/member-liquidity/outcomes` | Top-up history |

**LND credential/connectivity probe**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/node/lnd-probe` | Per-scope LND fault report. Treasury-only (403 elsewhere) |

Report-only: it changes no behaviour and moves no capital. It gives the fault
classifier in `app/api/src/lightning/lndHealth.ts` a consumer — before it, no LND
credential, permission or connectivity fault was observable anywhere in the app,
because `isLndAvailable()` only checks that the two files EXIST (a present-but-wrong,
revoked or under-scoped macaroon reads as available) and the 15s sync loop discarded
the resulting `err.code`/`err.details` into a `console.warn`.

Probes three read-only scopes independently — `info:read`, `offchain:read`,
`onchain:read` — and reports **one result per scope with no aggregate verdict**. The
absence is deliberate: the dangerous state is PARTIAL (`onchain:read` alive,
`offchain:read` lost), where `/api/node/balances` still returns 200 with one live
number and one silently-frozen one. Any rollup hides exactly that case, so a consumer
computes its own.

Each scope reports one `kind` — `ok` · `files_absent` · `connectivity` · `auth` ·
`permission` · `malformed` — plus the raw gRPC `code` and `detail`, which are
preserved rather than discarded so an unrecognised fault stays diagnosable. On LND
0.20.0-beta every credential fault arrives as gRPC 2 UNKNOWN, so `auth` and
`permission` are separated only by the detail text.

Each probe is bound by a 3s deadline (`lightning/lndProbeRoute.ts`). Without it a
wedged-but-connected LND would hang the request, since neither the LND client nor the
classifier carries a timeout. A timed-out probe reports `connectivity` with
`ETIMEDOUT` in `detail` — no seventh kind — so a caller distinguishing "wedged" from
"refused" must read `detail`, not `kind`.

```
GET /api/node/lnd-probe
{ "checked_at": 1755634800000, "files_present": true, "probe_calls_attempted": 3,
  "scopes": [
    { "scope": "info:read",     "kind": "ok",         "code": null, "detail": "" },
    { "scope": "offchain:read", "kind": "permission", "code": 2,    "detail": "…permission denied…" },
    { "scope": "onchain:read",  "kind": "ok",         "code": null, "detail": "" } ] }
```

⚠ **Ships with NO caller authentication, by decision.** The 403 is
`assertTreasury(node_role)` — a *node-role* check ("am I the treasury node?"), which
passes for every caller once this node is the treasury. It is not caller
authentication. Port 3101 is published on `0.0.0.0`, so on the treasury node anything
that can route there can read this; the disclosure is named and accepted in
`bitcorn-research/decisions/2026-08-19-lnd-health-endpoint-unauthenticated-treasury-only.md`,
which also records the obligation to move the endpoint behind caller auth once that
mechanism lands.

⚠ Because `node_role` is itself derived from a successful `getLndInfo()`, a treasury
node that has never completed a first LND sync has no `lnd_node_info` row and this
endpoint returns 403 — the total pre-existing-fault case is not readable. Pre-existing
mechanism, not introduced here.

## Error Handling

- **400:** Bad request (invalid body or parameters)
- **403:** Forbidden (not treasury, or membership not active for pay)
- **429:** Rate limit or capital policy violation
- **500:** Server or LND error
- **502:** Upstream (Cloudflare Worker or Loop) down
- **503:** Required env var unset (e.g. `COINBASE_WORKER_URL`)

Error body shape: `{ "error": "message" }`. Some endpoints include a machine-readable `code` (e.g. `coinbase_not_configured`) for UI mapping.
