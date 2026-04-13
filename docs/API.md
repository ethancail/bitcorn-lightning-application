# API Reference

Base URL is the API container (see `docker-compose.yml`). All responses are JSON unless noted. CORS allows `*` for configured methods (`GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS`).

## Access Rules

- **Public:** No role check
- **Member:** Requires `membership_status === "active_member"`
- **Treasury:** Requires `node_role === "treasury"`; returns 403 otherwise

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

**Member liquidity (treasury-side)**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/member-liquidity/clusters` | Cluster overview |
| GET | `/api/member-liquidity/recommendations` | Pending top-up recommendations |
| GET | `/api/member-liquidity/estimate` | Keysend push estimate (60s TTL) |
| POST | `/api/member-liquidity/approve` | Approve and execute top-up |
| POST | `/api/member-liquidity/reject` | Reject recommendation |
| GET | `/api/member-liquidity/outcomes` | Top-up history |

## Error Handling

- **400:** Bad request (invalid body or parameters)
- **403:** Forbidden (not treasury, or membership not active for pay)
- **429:** Rate limit or capital policy violation
- **500:** Server or LND error
- **502:** Upstream (Cloudflare Worker or Loop) down
- **503:** Required env var unset (e.g. `COINBASE_WORKER_URL`)

Error body shape: `{ "error": "message" }`. Some endpoints include a machine-readable `code` (e.g. `coinbase_not_configured`) for UI mapping.
