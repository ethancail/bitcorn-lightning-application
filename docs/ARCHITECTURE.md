# Architecture

## Mission

Bitcorn Lightning is a **Lightning Treasury Capital Allocation Engine** — not a wallet, not a UI product, not a generic routing node.

**Core objective:** Maximize risk-adjusted net sats by deploying capital into channels, rebalancing intelligently, enforcing strict capital guardrails, and tracking true profitability:

```
Net Sats = inbound + forwarding fees − outbound fees − rebalance costs
```

Economic truth > vanity metrics. Do not optimize for channel count, node size, or gossip presence.

### Architectural Roles

- **Treasury node** — capital allocator, expansion authority, rebalance scheduler, profitability engine, guardrail enforcer. All intelligence lives here.
- **Member nodes** — liquidity consumers only. Not capital allocators. Not strategy engines.

### Non-Negotiables

- Guardrails cannot be bypassed by automation
- Capital reserve floors must always be respected
- Deploy ratio limits must always be enforced
- Rebalance costs must always be accounted for
- Automation must be auditable and deterministic
- Safety > growth

## Hub-and-Spoke Topology

- **Treasury Node** (hub): Provides liquidity; has access to all treasury endpoints
- **Member Nodes** (spokes): Pay invoices via treasury channel
- **Node role** is computed on each sync cycle and stored in SQLite (`node_role` column)
  - `treasury`: pubkey matches `TREASURY_PUBKEY` env var
  - `member`: has active treasury channel
  - `external`: no treasury channel

`TREASURY_PUBKEY` is hard-coded in `docker-compose.yml` so all member installs get correct role detection without configuration.

## Sync-Driven State

A sync loop runs every 15s (`src/lightning/sync.ts`), pulling LND state into SQLite. The database is the source of truth for metrics, guardrails, and membership. Live LND calls are only used for critical operations (payments, channel opens, apply fee policy).

The sync loop:
1. Fetches LND wallet info, peers, channels
2. Upserts current channels/peers and **deletes stale rows** (closed channels, disconnected peers) — keeps SQLite in sync with LND
3. Computes `membership_status` and `node_role`
4. Writes node info + history
5. Syncs confirmed inbound invoices
6. Paginates LND forwarding history
7. Auto-cleans stale `requested`/`submitted` expansion executions older than 1h
8. Auto-settles inbound network payments by matching against `payments_inbound`

## Three-Layer Pattern

1. `src/lightning/` — LND gRPC integration via `ln-service`
2. `src/api/` — Business logic (treasury metrics, fees, liquidity health, rebalance)
3. `src/utils/` — Guards: membership, rate limits, capital guardrails, liquidity scoring

## Port Assignments

| Port | Purpose |
|------|---------|
| 3101 | User/Admin API (JWT, Umbrel-aware) |
| 3109 | Node-to-Node API (HMAC only, never proxied) — **stub only, unimplemented** |
| 3200 | Web UI |

Do not reuse ports 3001 or 3009. Do not expose port 3109 via Umbrel app-proxy. **Port 3109 has only stub code in `ports.ts`, `hmac.ts`, `node-api.ts` — never bound, never exposed.** No N2N infrastructure exists; member liquidity coordination does not use 3109.

## Database

SQLite at `data/db/bitcorn.sqlite` (mounted at `/data` inside the API container; on Umbrel host: `/home/umbrel/umbrel/app-data/bitcorn-lightning-node/data/db/bitcorn.sqlite`). Migrations run automatically on API startup. Migrations must be idempotent. Never mutate schema manually.

`sqlite3` is not installed in the API Docker image — to query the DB directly, use `sudo sqlite3` on the Umbrel host (the `data/db/` directory is owned by root).

See `docs/DATABASE.md` for the full migration and table list.

## Capital Guardrails

Before any channel open, `src/utils/capital-guardrails.ts` checks:
- Minimum on-chain reserve
- Max deploy ratio
- Max pending opens
- Per-peer capacity cap
- Peer cooldown period
- Daily expansion limit
- Daily total deploy limit

Returns 429 on violation. Policy stored in `treasury_capital_policy` (single row). Read/write via `/api/treasury/capital-policy`.

## Liquidity Management

Imbalance ratio: `local / (local + remote)`. Classifications: `healthy`, `outbound_starved`, `critical`.

### Cluster Rebalance Engine v1

`src/rebalance/` — three-lever architecture operating on per-peer clusters. Runs every 15 min (configurable via `CLUSTER_REBALANCE_INTERVAL_MS`), gated by `CLUSTER_REBALANCE_ENABLED=true`.

- **Lever 1 — Fee steering** (passive): adjusts routing fees based on balance deviation. `below_band` → raise; `above_band` → lower; hysteresis return to baseline.
- **Lever 2 — Circular rebalance** (active): probes routes and executes self-paying invoices to move sats between clusters.
- **Lever 3 — Topology monitor** (advisory): detects structural issues, emits recommendations, takes inventory snapshots.

Clusters are provisioned via `seeds/001_initial_clusters.sql` and define target bands (min/mid/max local balance percentages) per peer. Modules: `clusterState`, `feeSteering`, `pairSelector`, `cycleEnumerator`, `cycleScorer`, `rebalanceExecutor`, `topologyMonitor`, `rebalanceScheduler`.

### Loop Out (Submarine Swap)

Complementary strategy for restoring inbound capacity. Sats go off-chain through a channel → Loop server returns them on-chain minus fees → balance preserved, receive capacity restored.

- Only targets critical channels (>85% local)
- Min swap: 250k sats; need ≥556k channel capacity (ACINQ caps `max_value_in_flight_msat` at 45% of channel capacity)
- Verified mainnet via Loop v0.31.8-beta
- Prepay (~30k) is a **temporary hold returned in the on-chain payment**, not a fee
- Net fee = swap_fee + miner_fee (~1–2k typical)

See `docs/LOOP_SETUP.md` for setup, configuration, and gotchas.

### Treasury-Side Member Liquidity

`src/memberLiquidity/` — treasury detects member channel imbalances from cluster data (Step 9 in rebalance scheduler, 2-consecutive-run debounce) and proposes keysend top-ups.

- **Detection**: per-cluster config in `member_liquidity_config`; member-local < 30% → Top Up to 60%
- **Estimate**: `liquidityAdvisor` computes keysend push estimate (60s TTL, ~0 routing fee)
- **Execution**: `liquidityExecutor` calls `keysendPush()` to member
- **Operator approval**: treasury operator approves/rejects via Member Liquidity page
- **Single action type**: `treasury_push_topup`
- **Migration 026**: 4 tables (recommendations, estimates, outcomes, config)

### Member-Side Liquidity Advisor

`src/memberAdvisor/` — runs locally on member nodes every 15 minutes; **skips treasury nodes**.

Classifies treasury channel into 5 states by member-local %:
- `healthy` (30–70%)
- `send_heavy` (>70%)
- `send_saturated` (>85%)
- `receive_heavy` (<30%)
- `receive_exhausted` (<15%)

Urgency escalates on consecutive non-healthy runs.

**Role-aware recommendations**: `channel_role` stored in `member_liquidity_advisor_config` (migration 032), defaults to `'unknown'` — never silently auto-classified.
- **Merchant**: low outbound → Loop In; undersized (< 2M) or 3+ exhaustion runs → channel upgrade
- **Farmer**: high local → Loop Out; undersized (< 1M) or 3+ filling runs → channel upgrade
- **Unknown**: prompts user to set role via Settings

**Close/reopen is never recommended** — Loop In/Out are the normal maintenance path.

### Keysend Status

Keysend push rebalance is **disabled** (sends sats as one-way payments, not true rebalancing). Keysend enforcement is retained: backend `member_keysend_status` table tracks peers that reject keysend; auto-rebalancer skips disabled peers for 24h, then retries. `MEMBER_KEYSEND_DISABLED` alert (warning severity) shows on treasury dashboard.

## Lane Model

Channel purpose (stable) is separate from channel state (dynamic):

- **Purpose**: `merchant_lane` / `farmer_lane` / `external_peer` / `unclassified` — determined only by contact tags, never by balance heuristics
- **State**: computed from balance, interpreted through purpose lens

Treasury Channels page renders four sections (Merchant Lanes / Farmer Lanes / External Routing Peers / Unclassified) with consistent 6-column layout. Closing channels filtered out of lane tables (shown only in CLOSING section).

## Routing & Payments

- **Member payments forced through treasury channel**: `payInvoice()` auto-detects treasury channel via `TREASURY_PUBKEY` and sets `outgoing_channel`. Prevents members with direct peer channels from bypassing treasury (treasury earns nothing if member-to-member direct route is picked by LND pathfinding).
- **Network payments are invoice-based** (BOLT11). Two modes: Request Payment (create invoice + QR) and Pay Invoice (paste, decode, confirm, pay).
- **Settlement sync**: 15s sync loop matches pending receives in `network_payments` against `payments_inbound`. Auto-settles invoices.
- **Dual recording**: outbound network payments recorded in both `network_payments` and `payments_outbound` for rate limiting compatibility.

## Configuration

See `app/api/src/config/env.ts` — that file is authoritative for all env vars and defaults. `docs/LOOP_SETUP.md` documents Loop-specific vars. `CLAUDE.md` lists only the small handful that change behavior in ways not obvious from reading the code.

## Current Capabilities

The full per-version changelog lives in `git log`. Snapshot of capabilities currently shipped:

**Core treasury engine**
- Channel expansion engine with capital guardrails
- Loop Out submarine swap rebalancing
- Cluster rebalance engine v1 (fee steering + circular + topology, 15-min interval)
- Treasury metrics API, rebalance cost ledger, forwarding fee tracking
- Auto-cleans stale `requested`/`submitted` expansion executions after 1h

**Merchant/farmer lane model** — purpose stable from tags, state dynamic from balance.

**Role-aware liquidity advisors** — both treasury-side (push top-ups) and member-side (Loop In/Out recommendations).

**Member UI**
- `MemberShell` fetches role and renders role-aware sidebar (Cash Out for farmer, Refill Channel for merchant)
- Farmer dashboard: grain-bin gauge fills as earnings accumulate
- Merchant dashboard: outbound capacity remaining
- Withdrawal page: prominent Available Balance card, accurate fee display (net fee separated from prepay hold), Max button with fee cushion

**Treasury UI**
- Dashboard: Node Balances → Fund Node → Bitcoin Price → Alerts → Treasury Revenue (forwarding fees / rebalance costs / net revenue)
- Treasury Channels page with lane sections
- Treasury Peers page: connect by URI, onboarding guide, live peers table
- Treasury Settings page (max-width 720px): Routing Fee Policy + Capital Guardrails + Appearance
- Swap Operations page: Loop Out / Loop In tabs with visual channel picker
- Member Liquidity page: cluster overview, top-up approvals, history
- Network Topology graph (SVG hub-and-spoke, zoom/pan, role-colored)

**Charts & commodities**
- Bitcoin Power Law Trend (log scale, percentile bands, 2042 projection)
- Price ticker strip: BTC + gold + corn + soybeans + wheat (cached 24h in CF KV)
- BTC Moving Averages (50/100/200-day)
- Corn-Bitcoin ratio (bushels per BTC, USDA monthly interpolated to daily)
- Corn Moving Averages

**Other**
- Coinbase Onramp via Cloudflare Worker session token (see `docs/COINBASE_INTEGRATION.md`)
- Mobile-responsive navigation (hamburger under 768px)
- Contacts: CRUD address book with tag editor, sync-from-peers
- Network payments (invoice-based), forced treasury routing for member payments

## Future Direction

Channel-level ROI scoring, peer profitability ranking, yield-driven capital reallocation, fully autonomous LSP behavior.
