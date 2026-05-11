# Database

SQLite (single file under `/data/db` in the container). Migrations run on API startup from `app/api/src/db/migrations/`, in filename order. Applied migrations are recorded in `migrations`.

## Migrations Overview

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
| `012_treasury_expansions.sql` | Expansion recommendations log and execution audit |
| `013_treasury_capital_policy.sql` | Single-row capital guardrail policy |
| `014_rebalance_costs.sql` | Rebalance cost ledger (circular, loop_out, loop_in, manual) |
| `015_treasury_rebalance_executions.sql` | Audit log for rebalance runs |
| `016_channel_fee_log.sql` | Per-channel fee adjustment history (target/applied rates, classification snapshot) |
| `017_rotation_executions.sql` | Channel rotation audit log (capacity, ROI, reason, outcome) |
| `018_add_loss_cap.sql` | Adds `max_daily_loss_sats` column to `treasury_capital_policy` |
| `019_coinbase_onramp_sessions.sql` | Persisted Coinbase Onramp session tokens (per-node, per-wallet) |
| `020_contacts.sql` | Contacts address book (pubkey UNIQUE, tags as comma-string) |
| `021_member_keysend_status.sql` | Tracks peers that reject keysend (24h skip window) |
| `022_network_payments.sql` | Invoice-based payment records (direction, status, USD, counterparty, memo) |
| `023_rebalance_clusters.sql` | Cluster definitions + channel membership (rebalance engine v1) |
| `024_rebalance_execution.sql` | Cluster engine execution tables: fee policy, events, runs, candidates, outcomes, pair history |
| `025_rebalance_topology_inventory.sql` | Topology monitor recommendations + treasury inventory snapshots |
| `026_member_liquidity_actions.sql` | Treasury-side member liquidity: recommendations, estimates, outcomes, config |
| `027_member_liquidity_advisor.sql` | Member-side advisor: channel classifications + advisor config |
| `028_advisor_min_channel_capacity.sql` | Adds `min_channel_capacity_sat` to advisor config (undersized-channel detection) |
| `029_swap_subsystem.sql` | Loop-based swap subsystem: `swap_requests`, `swap_executions`, `swap_events`, `liquidity_actions` |
| `030_swap_withdrawal_config.sql` | Adds `max_daily_withdrawal_sat`, `min_withdrawal_sat` to advisor config |
| `031_swap_egress_peers.sql` | Approved external peers for swap egress routing (operator-managed allowlist) |
| `032_channel_role.sql` | Adds `channel_role` to `member_liquidity_advisor_config` (merchant/farmer/unknown) |
| `033_valuation_manual_inputs.sql` | Local audit cache for the 8 manually-entered valuation metrics |
| `034_coinbase_autobuy.sql` | Coinbase Auto-Buy: credentials (encrypted), config, runs (state machine), sweeps |
| `035_valuation_manual_calendar.sql` | Per-day calendar variant of manual valuation inputs (date-keyed upserts) |
| `036_member_subscription.sql` | On-chain monthly subscription: `subscription_policy`, `subscription`, `subscription_payment`, `subscription_pending_attribution` |
| `037_subscription_first_run_ack.sql` | Adds `first_run_acknowledged_at` to `subscription_policy` — Path B first-run gate |

The migration set is contiguous from `001` through `037` with no gaps. Always allocate the next sequential number for new migrations.

## Key Tables

**Identity & sync**
- `lnd_node_info` / `lnd_node_info_history` — current + historical node state (pubkey, alias, block height, synced, treasury channel flag, membership, role)
- `lnd_peers` / `lnd_channels` — snapshot of LND peers and channels (used by liquidity/expansion logic)

**Payments**
- `payments_inbound` — confirmed inbound invoices
- `payments_outbound` — outbound attempts (pay endpoint + network pay; used for rate limiting)
- `payments_forwarded` — forwarding history for routing revenue
- `network_payments` — invoice-based payment records (direction, status, USD conversion, counterparty, memo)

**Treasury policy & audit**
- `treasury_fee_policy` — routing fee settings + last applied
- `treasury_expansion_recommendations` / `treasury_expansion_executions` — recommendations and per-attempt audit (requested/submitted/succeeded/failed)
- `treasury_capital_policy` — capital guardrail limits (reserve, deploy ratio, per-peer, daily caps)
- `treasury_rebalance_costs` — rebalance cost ledger (type, tokens, fee_paid_sats, related_channel)
- `treasury_rebalance_executions` — per-run audit (type, tokens, channels, max_fee, status, payment_hash, fee_paid_sats, error)

**Contacts**
- `contacts` — address book with tags
- `member_keysend_status` — tracks peers that reject keysend (24h skip window)

**Cluster rebalance engine v1 (legacy — gated off by default)**

These tables are populated only when `CLUSTER_REBALANCE_ENABLED=true`, which is off in steady-state operation. The cluster engine is no longer the active rebalancing model; see `docs/ARCHITECTURE.md` § Liquidity Management for the member-driven role-based model.

- `rebalance_clusters` — cluster definitions
- `rebalance_cluster_channels` — channel → cluster membership
- `rebalance_fee_policy` — per-cluster fee bands and current state
- `rebalance_fee_events` — fee steering history
- `rebalance_runs` — per-execution run log
- `rebalance_candidates` — enumerated candidates per run
- `rebalance_outcomes` — execution outcomes
- `rebalance_pair_history` — success rate per (from, to) pair
- `rebalance_topology_recommendations` — topology monitor recommendations
- `treasury_inventory_snapshots` — periodic inventory snapshots

**Member liquidity (treasury-side)**
- `member_liquidity_recommendations` — pending/resolved top-up recommendations
- `member_liquidity_estimates` — keysend push fee/route estimates (60s TTL)
- `member_liquidity_outcomes` — execution outcomes
- `member_liquidity_config` — per-cluster thresholds

**Member advisor (member-side)**
- `member_channel_classifications` — per-run classification history
- `member_liquidity_advisor_config` — advisor settings including `channel_role`

**Subscription (member, on-chain)**
- `subscription_policy` — single-row policy: price (sats), period (days), tier grace windows, underpay tolerance
- `subscription` — one row per member: deposit address, BIP32 path, `paid_through`, last payment, `current_tier`
- `subscription_payment` — append-only ledger; `kind ∈ {onchain, admin_override}`; UNIQUE (txid, vout) where txid is non-null
- `subscription_pending_attribution` — confirmed receipts that fell below the underpay tolerance, awaiting admin resolution

All timestamps are stored as milliseconds unless noted in a migration.

## Querying the DB on Umbrel

`sqlite3` is not installed inside the API Docker image. From the Umbrel host:

```bash
sudo sqlite3 /home/umbrel/umbrel/app-data/bitcorn-lightning-node/data/db/bitcorn.sqlite
```

`sudo` is required — the `data/db/` directory is owned by root. Without sudo, `ls` shows an empty directory.

## Seed Scripts

Seed scripts in `seeds/` are run manually by the treasury operator after migrations create the tables. `seeds/001_initial_clusters.sql` provisions initial cluster configuration from live `lnd_channels` + `contacts` data.
