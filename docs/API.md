# API Reference

Base URL is the API container (see `docker-compose.yml`). All responses are JSON unless noted. CORS allows `*` for the configured methods.

## Access rules

- **Public:** No role check (e.g. health, optional node read).
- **Member:** Requires `membership_status === "active_member"` (used for pay).
- **Treasury:** Requires `node_role === "treasury"`. Returns 403 if not treasury.

## Endpoints

| Method | Path | Access | Purpose |
|--------|------|--------|---------|
| GET | `/health` | Public | Liveness and DB check |
| POST | `/lnd/sync` | Public | Trigger full LND sync |
| GET | `/api/node` | Public | Current node info (including `node_role`, `membership_status`) |
| GET | `/api/peers` | Public | Persisted peers list |
| GET | `/api/channels` | Public | Persisted channels list |
| POST | `/api/pay` | Member | Pay a BOLT11 invoice (body: `{ "payment_request": "..." }`) |
| GET | `/api/treasury/metrics` | Treasury | Aggregate treasury metrics (flow, liquidity, capital efficiency) |
| GET | `/api/treasury/channel-metrics` | Treasury | Per-channel profitability and payback |
| GET | `/api/treasury/fee-policy` | Treasury | Current routing fee policy |
| POST | `/api/treasury/fee-policy` | Treasury | Set routing fee policy and apply to LND |
| GET | `/api/treasury/liquidity-health` | Treasury | Per-channel liquidity health and recommendations |
| GET | `/api/treasury/capital-policy` | Treasury | Current capital guardrail policy |
| POST | `/api/treasury/capital-policy` | Treasury | Update capital guardrail policy (partial body) |
| GET | `/api/treasury/expansion/recommendations` | Treasury | Expansion recommendations from liquidity health |
| POST | `/api/treasury/expansion/execute` | Treasury | Open a channel to a peer (body: `peer_pubkey`, `capacity_sats`, optional `is_private`) |
| POST | `/api/treasury/rebalance/circular` | Treasury | Run a circular rebalance (body: `tokens`, `outgoing_channel`, `incoming_channel`, `max_fee_sats`). Returns `{ ok, rebalance: { tokens, fee_paid_sats, outgoing_channel, incoming_channel, payment_hash } }`. |
| GET | `/api/treasury/rebalance/executions` | Treasury | List rebalance execution history. Query: `limit` (default 50, max 500). |

## Error handling

- **400:** Bad request (e.g. invalid body or parameters).
- **403:** Forbidden (e.g. not treasury, or membership not active for pay).
- **429:** Rate limit or capital policy limit exceeded (e.g. pay rate limit, expansion guardrails).
- **500:** Server or LND error.

Error body shape: `{ "error": "message" }`.
