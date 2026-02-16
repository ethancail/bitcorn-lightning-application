# Database

SQLite (single file under `/data/db` in the container). Migrations run on API startup from `app/api/src/db/migrations/`, in filename order. Applied migrations are recorded in `migrations`.

## Migrations overview

| Migration | Purpose |
|-----------|---------|
| `001_lnd_node_info.sql` | Node identity and sync state (single row + history) |
| `002_channels.sql` | Channel list from LND (capacity, balances, active) |
| `003_peers.sql` | Peer list from LND |
| `004_add_block_drift.sql` | Block drift on node info |
| `005_add_treasury_flag.sql` | `has_treasury_channel` on node info |
| `006_add_membership_status.sql` | `membership_status` on node info |
| `007_payments_outbound.sql` | Outbound payment attempts (pay endpoint) |
| `008_payments_inbound.sql` | Confirmed inbound invoices (sync from LND) |
| `009_payments_forwarded.sql` | Forwarding history for routing revenue |
| `010_add_node_role.sql` | `node_role` (treasury / member / external) on node info |
| `011_treasury_fee_policy.sql` | Single-row routing fee policy and last-applied time |
| `012_treasury_expansions.sql` | Expansion recommendations log and execution audit (pending/success/failure) |
| `013_treasury_capital_policy.sql` | Single-row capital guardrail policy (reserve, deploy ratio, per-peer and daily limits) |

## Table roles (summary)

- **lnd_node_info / lnd_node_info_history:** Current and historical node state (pubkey, alias, block height, synced, treasury channel, membership, role).
- **lnd_peers / lnd_channels:** Snapshot of LND peers and channels used for liquidity and expansion logic.
- **payments_inbound / payments_outbound / payments_forwarded:** Payment and forwarding history for treasury metrics and rate limiting.
- **treasury_fee_policy:** Routing fee settings and when last applied to LND.
- **treasury_expansion_recommendations / treasury_expansion_executions:** Expansion recommendations and per-attempt audit (requested/submitted/failed).
- **treasury_capital_policy:** Limits used by the capital guardrail (reserve, deploy ratio, pending opens, per-peer and daily caps).

All timestamps are stored as milliseconds (or as returned by the app) unless noted in a migration.
