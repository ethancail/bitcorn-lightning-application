# API Reference

Base URL is the API container (see `docker-compose.yml`). All responses are JSON unless noted. CORS allows `*` for configured methods (`GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS`); allowed request headers are `Content-Type` and `x-bitcorn-confirm` (see Per-Action Confirmation below).

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

## Per-Action Confirmation (capital-moving routes)

Routes that move funds require an `x-bitcorn-confirm` header carrying a value
derived from **that same request's own consequential caller-supplied fields**.
The server recomputes it from what actually arrived and compares.

This proves PARAMETER KNOWLEDGE, not identity. It stops a blind scanner, a
replay carrying different parameters, and a mis-click. It does **not** stop an
in-page script or a determined caller on the tailnet — those are the
capital-guardrail layer's problem, not this one. There is no login, no stored
credential, and treasury reads stay open.

The route table and per-route field lists live in
`app/api/src/utils/action-confirmation.ts` and are the authority; the coverage
test re-derives which routes need this from the source and fails if the table
drifts.

**Value:** `sha256_hex` of the fields joined as `name=value&name=value`, in the
order the route's field list declares — not alphabetical, and not the order
they appear in your JSON. Numeric fields are normalised through `Number()`, so
`250000` and `"250000"` produce the same value. Text fields are hashed exactly
as sent, with no trimming.

**Shell idiom** — build the body, derive the value from it, send both. `jq -rj`
matters: `-j` suppresses the trailing newline, and hashing one would give a
value the server rejects.

```bash
# POST /api/pay
BODY='{"payment_request":"lnbc1..."}'
CONFIRM=$(jq -rj '"payment_request=" + .payment_request' <<<"$BODY" | sha256sum | cut -d' ' -f1)
curl -sS -X POST http://localhost:3101/api/pay \
  -H 'Content-Type: application/json' -H "x-bitcorn-confirm: $CONFIRM" -d "$BODY"
```

```bash
# POST /api/treasury/rebalance/circular   (fields: outgoing_channel, incoming_channel, tokens)
BODY='{"outgoing_channel":"842391119757312","incoming_channel":"901234567890123","tokens":250000,"max_fee_sats":500}'
CONFIRM=$(jq -rj '"outgoing_channel=" + .outgoing_channel
                + "&incoming_channel=" + .incoming_channel
                + "&tokens=" + (.tokens|tostring)' <<<"$BODY" | sha256sum | cut -d' ' -f1)
```

```bash
# POST /api/treasury/rebalance/loop-out   (fields: channel_id, amount_sats)
BODY='{"channel_id":"842391119757312","amount_sats":500000,"max_swap_fee_sats":5000}'
CONFIRM=$(jq -rj '"channel_id=" + .channel_id
                + "&amount_sats=" + (.amount_sats|tostring)' <<<"$BODY" | sha256sum | cut -d' ' -f1)
```

```bash
# POST /api/treasury/expansion/execute    (fields: peer_pubkey, capacity_sats)
BODY='{"peer_pubkey":"02b759...","capacity_sats":2000000}'
CONFIRM=$(jq -rj '"peer_pubkey=" + .peer_pubkey
                + "&capacity_sats=" + (.capacity_sats|tostring)' <<<"$BODY" | sha256sum | cut -d' ' -f1)
```

Note that `max_fee_sats` and `max_swap_fee_sats` above are **not** part of the
hash — only the fields the route's entry declares are. Sending extra body fields
is fine and does not change the value.

**Responses**

- **400 `confirmation_required`** — header absent or empty, or a declared field
  is missing/empty so no value can be derived. Empty is rejected on both sides:
  an empty header never matches anything.
- **409 `confirmation_mismatch`** — a value arrived but does not match the
  parameters in this request. This is what a replay with changed parameters gets.

**Default-require.** Classification is default-require on mutations with a
derived exempt list, not opt-in on the capital routes. A mutation route that
matches neither table is refused with 400 `confirmation_required` rather than
waved through, so a newly added route fails closed until someone classifies it.

Reads (`GET`/`HEAD`), `OPTIONS` preflight, and `/health` are untouched.

## Error Handling

- **400:** Bad request (invalid body or parameters), or `confirmation_required`
- **403:** Forbidden (not treasury, or membership not active for pay)
- **409:** `confirmation_mismatch` — see Per-Action Confirmation above
- **413:** Request body over the 1 MiB gate limit on a confirmed route
- **429:** Rate limit or capital policy violation
- **500:** Server or LND error
- **502:** Upstream (Cloudflare Worker or Loop) down
- **503:** Required env var unset (e.g. `COINBASE_WORKER_URL`)

Error body shape: `{ "error": "message" }`. Some endpoints include a machine-readable `code` (e.g. `coinbase_not_configured`) for UI mapping.
