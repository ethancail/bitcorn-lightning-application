# Bitcorn Lightning Application - Complete Codebase Summary

## Project Overview

**Bitcorn Lightning** is a **Lightning Treasury Capital Allocation Engine** - a hub-and-spoke Lightning Service Provider (LSP) application designed for the Umbrel Community Store. It is NOT a wallet, UI product, or generic routing node.

### Core Mission
Maximize risk-adjusted net sats by deploying capital into channels, rebalancing intelligently, enforcing strict capital guardrails, and tracking true profitability:

```
Net Sats = inbound + forwarding fees − outbound fees − rebalance costs
```

**Philosophy:** Economic truth > vanity metrics. Do not optimize for channel count, node size, or gossip presence.

### Architectural Roles

- **Treasury Node (Hub):** Capital allocator, expansion authority, rebalance scheduler, profitability engine, guardrail enforcer. All intelligence lives here.
- **Member Nodes (Spokes):** Liquidity consumers only. Not capital allocators. Not strategy engines.

### Technology Stack

- **Backend:** Node.js + TypeScript
- **Database:** SQLite (better-sqlite3)
- **Lightning:** LND via `ln-service` (gRPC)
- **Frontend:** React + Vite
- **Deployment:** Docker Compose
- **Platform:** Umbrel Community Store app

---

## Architecture

### Hub-and-Spoke Model

The system uses a hub-and-spoke architecture where:
- **Treasury Node:** Identified by `TREASURY_PUBKEY` environment variable. Has access to all treasury endpoints.
- **Member Nodes:** Have an active channel to the treasury. Can use the pay endpoint.
- **External Nodes:** No treasury channel. Limited read-only access.

Node role is computed on each sync cycle and stored in SQLite (`lnd_node_info.node_role`):
- `treasury`: pubkey matches `TREASURY_PUBKEY`
- `member`: has active treasury channel
- `external`: no treasury channel

### Sync-Driven State Architecture

**Key Design Principle:** Database is the source of truth. LND is only called for critical operations.

A sync loop runs every 15 seconds (`src/lightning/sync.ts`) that:
1. Fetches LND wallet info, peers, and channels
2. Persists peers and channels to `lnd_peers` and `lnd_channels`
3. Determines treasury channel presence and computes `membership_status` and `node_role`
4. Writes node info to `lnd_node_info` / `lnd_node_info_history`
5. Syncs confirmed inbound invoices to `payments_inbound`
6. Paginates LND forwarding history into `payments_forwarded`

Live LND calls are ONLY used for:
- Payments (pay endpoint)
- Channel opens (expansion execution)
- Applying fee policy
- Rebalancing operations

### Three-Layer Pattern

1. **`src/lightning/`** - LND gRPC integration via `ln-service`
   - `lnd.ts`: Client initialization, TLS + macaroon setup
   - `sync.ts`: Main sync orchestrator
   - `pay.ts`: Payment execution
   - `fees.ts`: Fee policy application
   - `rebalance-circular.ts`: Circular rebalance execution
   - `rebalance-auto.ts`: Auto channel selection for rebalance
   - `rebalance-scheduler.ts`: Automated rebalance scheduler
   - `persist*.ts`: Various persistence modules

2. **`src/api/`** - Business logic layer
   - `treasury.ts`: Aggregate treasury metrics
   - `treasury-liquidity-health.ts`: Per-channel liquidity assessment
   - `treasury-expansion.ts`: Channel expansion recommendations & execution
   - `treasury-channel-metrics.ts`: Per-channel profitability metrics
   - `treasury-peer-scoring.ts`: Peer ROI scoring
   - `treasury-fee-policy.ts`: Fee policy management
   - `treasury-capital-policy.ts`: Capital guardrail policy
   - `treasury-rebalance-costs.ts`: Rebalance cost ledger
   - `treasury-rebalance-executions.ts`: Rebalance audit log
   - `treasury-dynamic-fees.ts`: Dynamic fee adjustments
   - `treasury-rotation.ts`: Channel rotation logic
   - `treasury-alerts.ts`: Alert system
   - `read.ts`: Read-only API helpers
   - `node-api.ts`: Node info API
   - `user-api.ts`: User management API

3. **`src/utils/`** - Guard/validation layer
   - `capital-guardrails.ts`: Pre-expansion policy enforcement
   - `membership.ts`: Membership validation
   - `rate-limit.ts`: Payment rate limiting
   - `role.ts`: Role-based access control
   - `rebalance-liquidity.ts`: Rebalance validation
   - `loss-cap.ts`: Daily loss cap enforcement

### Port Assignments

| Port | Purpose |
|------|---------|
| 3101 | User/Admin API (JWT, Umbrel-aware) |
| 3109 | Node-to-Node API (HMAC only, never proxied) - NOT CURRENTLY EXPOSED |
| 3200 | Web UI |

---

## Codebase Structure

```
bitcorn-lightning-application/
├── app/
│   ├── api/                          # Backend API server
│   │   ├── src/
│   │   │   ├── index.ts              # Main HTTP server, all routes (600+ lines)
│   │   │   ├── config/
│   │   │   │   ├── env.ts            # Environment variable configuration
│   │   │   │   ├── ports.ts          # Port configuration
│   │   │   │   └── secrets.ts        # Secret management
│   │   │   ├── db/
│   │   │   │   ├── index.ts          # Database initialization
│   │   │   │   ├── migrate.ts        # Migration runner
│   │   │   │   └── migrations/       # 18 SQL migration files (001-018)
│   │   │   ├── lightning/            # LND integration layer
│   │   │   │   ├── lnd.ts            # LND client setup (TLS + macaroon)
│   │   │   │   ├── sync.ts           # Main sync orchestrator
│   │   │   │   ├── pay.ts            # Payment execution
│   │   │   │   ├── fees.ts           # Fee policy application
│   │   │   │   ├── rebalance-circular.ts    # Circular rebalance execution
│   │   │   │   ├── rebalance-auto.ts        # Auto channel selection
│   │   │   │   ├── rebalance-scheduler.ts   # Automated scheduler
│   │   │   │   ├── routing.ts               # Routing helpers
│   │   │   │   ├── payments.ts               # Payment helpers
│   │   │   │   ├── persist.ts                # Node info persistence
│   │   │   │   ├── persist-channels.ts       # Channel persistence
│   │   │   │   ├── persist-inbound.ts        # Inbound payment sync
│   │   │   │   ├── persist-forwarded.ts     # Forwarding history sync
│   │   │   │   └── persist-payments.ts       # Outbound payment persistence
│   │   │   ├── api/                  # Business logic layer
│   │   │   │   ├── treasury.ts               # Aggregate metrics
│   │   │   │   ├── treasury-liquidity-health.ts  # Per-channel health
│   │   │   │   ├── treasury-expansion.ts         # Expansion engine
│   │   │   │   ├── treasury-channel-metrics.ts   # Channel profitability
│   │   │   │   ├── treasury-peer-scoring.ts      # Peer ROI scoring
│   │   │   │   ├── treasury-fee-policy.ts        # Fee policy management
│   │   │   │   ├── treasury-capital-policy.ts    # Capital policy CRUD
│   │   │   │   ├── treasury-rebalance-costs.ts   # Cost ledger
│   │   │   │   ├── treasury-rebalance-executions.ts  # Execution audit
│   │   │   │   ├── treasury-dynamic-fees.ts       # Dynamic fee adjustments
│   │   │   │   ├── treasury-rotation.ts           # Channel rotation
│   │   │   │   ├── treasury-alerts.ts             # Alert system
│   │   │   │   ├── read.ts                        # Read helpers
│   │   │   │   ├── node-api.ts                    # Node API
│   │   │   │   └── user-api.ts                    # User API
│   │   │   ├── utils/               # Guard/validation layer
│   │   │   │   ├── capital-guardrails.ts    # Expansion guardrails
│   │   │   │   ├── membership.ts            # Membership checks
│   │   │   │   ├── rate-limit.ts            # Rate limiting
│   │   │   │   ├── role.ts                  # Role checks
│   │   │   │   ├── rebalance-liquidity.ts   # Rebalance validation
│   │   │   │   └── loss-cap.ts              # Loss cap enforcement
│   │   │   ├── auth/
│   │   │   │   ├── jwt.ts                   # JWT authentication
│   │   │   │   └── hmac.ts                  # HMAC authentication
│   │   │   ├── liquidity/
│   │   │   │   ├── seeding.ts               # Liquidity seeding
│   │   │   │   └── bos.ts                    # Balance of Satoshis integration
│   │   │   ├── types/
│   │   │   │   ├── node.ts                   # Node type definitions
│   │   │   │   └── ln-service.d.ts           # ln-service type declarations
│   │   │   ├── dist/                         # Compiled JavaScript output
│   │   │   └── package.json
│   │   └── Dockerfile
│   └── web/                          # Frontend React app
│       ├── src/
│       │   ├── App.tsx               # Main app component
│       │   ├── pages/
│       │   │   ├── InstallWizard.tsx
│       │   │   └── Dashboard.tsx
│       │   ├── config/
│       │   │   └── api.ts            # API base URL config
│       │   └── api/
│       │       └── client.ts        # API client helpers
│       ├── dist/                     # Built static files
│       └── package.json
├── docs/
│   ├── ARCHITECTURE.md               # Architecture overview
│   ├── IMPLEMENTATION.md             # Implementation details
│   ├── API.md                        # API reference
│   ├── DATABASE.md                   # Database schema
│   └── COINBASE_INTEGRATION.md       # Future Coinbase OAuth2 (not implemented)
├── data/                             # Runtime data (mounted volume)
│   ├── db/
│   │   └── bitcorn.sqlite           # SQLite database
│   └── secrets/                      # Generated secrets
├── docker-compose.yml                # Docker Compose configuration
├── CLAUDE.md                         # AI assistant guidance
├── README.md                         # Project README
└── CODEBASE_SUMMARY.md               # This file
```

---

## Database Schema

SQLite database at `/data/db/bitcorn.sqlite`. Migrations run automatically on API startup.

### Key Tables

#### Node & Channel State
- **`lnd_node_info`**: Single-row table with current node state
  - `public_key`, `alias`, `block_height`, `synced_to_chain`
  - `has_treasury_channel`, `membership_status`, `node_role`
  - `updated_at`
- **`lnd_node_info_history`**: Historical snapshots of node info
- **`lnd_peers`**: Snapshot of LND peers (synced periodically)
- **`lnd_channels`**: Snapshot of channels
  - `channel_id`, `peer_pubkey`, `capacity_sat`
  - `local_balance_sat`, `remote_balance_sat`, `is_active`
  - `updated_at`

#### Payment History
- **`payments_inbound`**: Confirmed inbound invoices (revenue)
  - `payment_hash`, `tokens`, `settled_at`
- **`payments_outbound`**: Outbound payment attempts
  - `payment_hash`, `tokens`, `fee`, `status` (succeeded/failed)
  - `created_at` (for rate limiting)
- **`payments_forwarded`**: Forwarding history (routing revenue)
  - `incoming_channel`, `outgoing_channel`, `tokens`, `fee`
  - `created_at`

#### Treasury Configuration
- **`treasury_fee_policy`**: Single-row routing fee policy
  - `fee_rate_ppm`, `base_fee_sats`, `last_applied_at`
- **`treasury_capital_policy`**: Single-row capital guardrail policy
  - `min_onchain_reserve_sats`, `max_deploy_ratio_ppm`
  - `max_pending_opens`, `max_sats_per_peer`
  - `peer_cooldown_minutes`, `max_expansions_per_day`
  - `max_daily_deploy_sats`

#### Expansion Engine
- **`treasury_expansion_recommendations`**: Generated recommendations
  - `peer_pubkey`, `channel_id`, `classification`
  - `suggested_capacity_sats`, `priority_score`, `peer_score`
  - `created_at`
- **`treasury_expansion_executions`**: Audit log of expansion attempts
  - `peer_pubkey`, `requested_capacity_sats`
  - `status` (requested/submitted/failed/succeeded)
  - `funding_txid`, `error`, `created_at`

#### Rebalancing
- **`treasury_rebalance_costs`**: Cost ledger for true net accounting
  - `type` (circular/loop_out/loop_in/manual)
  - `tokens`, `fee_paid_sats`, `related_channel`
  - `created_at`
- **`treasury_rebalance_executions`**: Per-run audit log
  - `type`, `tokens`, `outgoing_channel`, `incoming_channel`
  - `max_fee_sats`, `status` (requested/submitted/succeeded/failed)
  - `payment_hash`, `fee_paid_sats`, `error`, `created_at`

#### Additional Features
- **`treasury_channel_fee_log`**: Channel fee adjustment history
- **`treasury_rotation_executions`**: Channel rotation audit log
- **`treasury_loss_cap`**: Daily loss cap configuration

### Migration Files (18 total)
1. `001_lnd_node_info.sql` - Node identity and sync state
2. `002_channels.sql` - Channel list
3. `003_peers.sql` - Peer list
4. `004_add_block_drift.sql` - Block drift tracking
5. `005_add_treasury_flag.sql` - Treasury channel flag
6. `006_add_membership_status.sql` - Membership status
7. `007_payments_outbound.sql` - Outbound payments
8. `008_payments_inbound.sql` - Inbound invoices
9. `009_payments_forwarded.sql` - Forwarding history
10. `010_add_node_role.sql` - Node role (treasury/member/external)
11. `011_treasury_fee_policy.sql` - Fee policy
12. `012_treasury_expansions.sql` - Expansion recommendations & executions
13. `013_treasury_capital_policy.sql` - Capital guardrails
14. `014_rebalance_costs.sql` - Rebalance cost ledger
15. `015_treasury_rebalance_executions.sql` - Rebalance executions
16. `016_channel_fee_log.sql` - Fee adjustment log
17. `017_rotation_executions.sql` - Channel rotation
18. `018_add_loss_cap.sql` - Daily loss cap

---

## API Endpoints

All endpoints return JSON. Base URL is the API container.

### Access Rules
- **Public:** No role check (health, node read)
- **Member:** Requires `membership_status === "active_member"` (pay endpoint)
- **Treasury:** Requires `node_role === "treasury"` (all `/api/treasury/*`)

### Endpoint List

| Method | Path | Access | Purpose |
|--------|------|--------|---------|
| GET | `/health` | Public | Liveness and DB check |
| POST | `/lnd/sync` | Public | Trigger full LND sync |
| GET | `/api/node` | Public | Current node info (role, membership) |
| GET | `/api/peers` | Public | Persisted peers list |
| GET | `/api/channels` | Public | Persisted channels list |
| POST | `/api/pay` | Member | Pay a BOLT11 invoice |
| GET | `/api/treasury/metrics` | Treasury | Aggregate treasury metrics |
| GET | `/api/treasury/channel-metrics` | Treasury | Per-channel profitability |
| GET | `/api/treasury/fee-policy` | Treasury | Current routing fee policy |
| POST | `/api/treasury/fee-policy` | Treasury | Set fee policy and apply to LND |
| GET | `/api/treasury/liquidity-health` | Treasury | Per-channel liquidity health |
| GET | `/api/treasury/capital-policy` | Treasury | Current capital guardrail policy |
| POST | `/api/treasury/capital-policy` | Treasury | Update capital policy |
| GET | `/api/treasury/expansion/recommendations` | Treasury | Expansion recommendations |
| POST | `/api/treasury/expansion/execute` | Treasury | Open channel to peer |
| POST | `/api/treasury/rebalance/circular` | Treasury | Run circular rebalance |
| GET | `/api/treasury/rebalance/executions` | Treasury | Rebalance execution history |
| GET | `/api/treasury/peer-scores` | Treasury | Peer ROI scores |
| POST | `/api/treasury/dynamic-fees` | Treasury | Apply dynamic fee adjustments |
| GET | `/api/treasury/rotation/candidates` | Treasury | Channel rotation candidates |
| POST | `/api/treasury/rotation/execute` | Treasury | Execute channel rotation |
| GET | `/api/treasury/alerts` | Treasury | System alerts |

### Error Responses
- **400:** Bad request (invalid body/parameters)
- **403:** Forbidden (not treasury or not active member)
- **429:** Rate limit or capital policy limit exceeded
- **500:** Server or LND error

Error body: `{ "error": "message" }`

---

## Key Implementation Details

### 1. Payment Flow (`POST /api/pay`)

**Location:** `src/index.ts` (POST `/api/pay`), `src/lightning/pay.ts`

**Flow:**
1. Decode BOLT11 invoice using `ln-service`
2. Enforce active membership (`assertActiveMember()`)
3. Enforce rate limits (`assertRateLimit()`)
   - Checks `payments_outbound` for:
     - Max transactions per minute
     - Max sats per minute
     - Max sats per hour
     - Max single payment amount
4. Call LND `payViaPaymentRequest()`
5. Record result in `payments_outbound` table
   - Status: `succeeded` or `failed`
   - Tokens, fee, payment_hash

**Rate Limiting:** Configurable via env vars:
- `RATE_LIMIT_TX_PER_MINUTE` (default: 5)
- `RATE_LIMIT_SATS_PER_MINUTE` (default: 100,000)
- `RATE_LIMIT_SATS_PER_HOUR` (default: 1,000,000)
- `RATE_LIMIT_MAX_SINGLE_PAYMENT` (default: 250,000)

### 2. Sync Loop (`src/lightning/sync.ts`)

**Runs:** Every 15 seconds (configurable)

**Process:**
1. Check LND availability
2. Fetch wallet info (`getWalletInfo()`)
3. Persist peers (`persistPeers()`)
4. Persist channels (`persistChannels()`)
5. Determine treasury channel presence
6. Compute membership status:
   - `unsynced`: Not synced to chain
   - `no_treasury_channel`: No treasury channel
   - `treasury_channel_inactive`: Channel exists but inactive
   - `active_member`: Active treasury channel
7. Derive node role (`treasury`/`member`/`external`)
8. Persist node info (`persistNodeInfo()`)
9. Sync inbound payments (`syncInboundPayments()`)
   - Fetches confirmed invoices from LND
   - Inserts new ones into `payments_inbound`
10. Sync forwarding history (`syncForwardingHistory()`)
    - Paginates LND forwarding history
    - Inserts into `payments_forwarded`

### 3. Treasury Metrics (`GET /api/treasury/metrics`)

**Location:** `src/api/treasury.ts`

**Calculates:**

**All-Time Metrics:**
- `inbound_sats`: Sum of `payments_inbound.tokens`
- `outbound_sats`: Sum of succeeded `payments_outbound.tokens`
- `outbound_fees_sats`: Sum of succeeded `payments_outbound.fee`
- `forwarded_fees_sats`: Sum of `payments_forwarded.fee`
- `rebalance_costs_sats`: Sum of `treasury_rebalance_costs.fee_paid_sats`
- `net_sats`: `inbound + forwarded_fees - outbound - outbound_fees - rebalance_costs`

**Last 24h Metrics:** Same calculations filtered by `created_at >= now - 24h`

**Liquidity:**
- `channels_total`: Aggregated from `lnd_channels`
  - `local_sats`, `remote_sats`, `capacity_sats`
  - `active_count`, `total_count`
- `treasury_channel`: Specific treasury channel details

**Capital Efficiency:**
- `capital_deployed_sats`: Sum of `local_balance_sat` from channels
- `revenue_yield`: `forwarded_fees / capital_deployed`
- `revenue_per_1m_sats_deployed`: Normalized LSP comparison metric
- `runway_days`: Days until liquidity exhaustion (if net outbound)

### 4. Liquidity Health (`GET /api/treasury/liquidity-health`)

**Location:** `src/api/treasury-liquidity-health.ts`

**Per-Channel Assessment:**

**Imbalance Ratio:** `local / (local + remote)`
- Range: 0.0 (fully remote) to 1.0 (fully local)

**Classification:**
- `healthy`: Ratio between 0.2 and 0.8
- `outbound_starved`: Ratio < 0.2 (can't send)
- `critical`: Ratio < 0.1 (severe outbound starvation)
- `weak`: Ratio < 0.3 but not critical
- `inbound_starved`: Ratio > 0.8 (can't receive)

**24h Velocity:** Net flow over last 24h
- Positive = inbound flow (good)
- Negative = outbound flow (draining)

**Recommended Action:**
- `none`: Healthy channel
- `monitor`: Weak but not urgent
- `expand`: Outbound starved, needs liquidity
- `rebalance`: Can be rebalanced

### 5. Expansion Engine (`GET /api/treasury/expansion/recommendations`)

**Location:** `src/api/treasury-expansion.ts`

**Process:**
1. Get liquidity health for all channels
2. Filter channels that need expansion:
   - Classification: `outbound_starved` or `critical`
   - Negative 24h velocity (draining)
3. Compute suggested capacity:
   - Target local ratio: 0.45 (45%)
   - `suggested = (target_local - current_local) * 2`
   - Clamped to 100k - 2M sats
4. Get peer scores (`treasury-peer-scoring.ts`)
   - Weighted ROI × uptime ratio
5. Compute priority score:
   - Classification weight (critical=100, outbound_starved=80)
   - Velocity weight (negative velocity adds points)
   - Imbalance weight (lower ratio = more urgent)
   - Peer ROI bonus (up to 50 points)
6. Sort by priority score (descending)
7. Optionally persist to `treasury_expansion_recommendations`

**Execution (`POST /api/treasury/expansion/execute`):**
1. Validate treasury role + synced status
2. Run capital guardrails (`assertCanExpand()`)
3. Check chain balance
4. Verify peer is connected
5. Create execution record (`status: "requested"`)
6. Call LND `openChannel()`
7. Update execution record:
   - `status: "submitted"` (funding tx created)
   - `funding_txid` (when confirmed)
   - `status: "succeeded"` or `"failed"` + `error`

### 6. Capital Guardrails (`src/utils/capital-guardrails.ts`)

**Enforced Before Every Channel Open:**

**Policy Checks (from `treasury_capital_policy`):**
1. **Minimum On-Chain Reserve**
   - `chain_balance >= min_onchain_reserve_sats`
   - Prevents over-deployment

2. **Maximum Deploy Ratio**
   - `(deployed + pending) / (chain_balance + deployed) <= max_deploy_ratio_ppm / 1e6`
   - Limits capital deployment percentage

3. **Maximum Pending Opens**
   - `pending_opens_count < max_pending_opens`
   - Prevents too many concurrent opens

4. **Per-Peer Capacity Cap**
   - `peer_deployed + requested < max_sats_per_peer`
   - Limits exposure to single peer

5. **Peer Cooldown Period**
   - Last expansion to this peer must be > `peer_cooldown_minutes` ago
   - Prevents rapid re-expansion

6. **Daily Expansion Limit**
   - Expansions today < `max_expansions_per_day`
   - Rate limits expansion velocity

7. **Daily Deploy Limit**
   - Sats deployed today < `max_daily_deploy_sats`
   - Hard cap on daily capital deployment

**Implementation:**
- `assertCanExpand(peerPubkey, capacitySats)` throws `CapitalGuardrailError` on violation
- Returns 429 HTTP status with clear error message
- Cannot be bypassed by automation

### 7. Circular Rebalance (`POST /api/treasury/rebalance/circular`)

**Location:** `src/lightning/rebalance-circular.ts`

**Purpose:** Shift liquidity from one channel to another by paying self via forced path.

**Flow:**
1. **Channel Selection:**
   - If `outgoing_channel`/`incoming_channel` omitted, auto-selects via `rebalance-auto.ts`:
     - Best donor: Highest local ratio (most local liquidity)
     - Best receiver: Highest remote ratio (most remote liquidity)
     - Must be different peers
   - Validates channels exist and are active

2. **Liquidity Validation:**
   - Checks outgoing channel has sufficient local balance
   - Checks incoming channel has sufficient remote balance
   - Validates minimum ratios:
     - `remote_ratio >= REBALANCE_MIN_INCOMING_REMOTE_RATIO_PPM / 1e6` (default: 0.2)
     - `local_ratio >= REBALANCE_MIN_OUTGOING_LOCAL_RATIO_PPM / 1e6` (default: 0.2)

3. **Size Calculation:**
   - `tokens = min(requested_tokens, available_local - safety_buffer, available_remote - safety_buffer)`
   - Safety buffer: `REBALANCE_SAFETY_BUFFER_SATS` (default: 1000)

4. **Execution:**
   - Create execution record (`status: "requested"`)
   - Create self-invoice via `createInvoice()`
   - Get route to self via `getRouteToDestination()` (forced path)
   - Pay via route using `payViaRoutes()`
   - Update execution:
     - `status: "succeeded"` or `"failed"`
     - `payment_hash`, `fee_paid_sats`, `error`
   - Insert rebalance cost into `treasury_rebalance_costs`

**Auto-Selection Algorithm (`rebalance-auto.ts`):**
- Scores all channels:
  - Outgoing score: `local_ratio * 1e6` (ppm)
  - Incoming score: `remote_ratio * 1e6` (ppm)
- Picks highest scoring pair with different peers
- Returns selection metadata in response

### 8. Rebalance Scheduler (`src/lightning/rebalance-scheduler.ts`)

**Enabled:** `REBALANCE_SCHEDULER_ENABLED=true`

**Runs:** Every `REBALANCE_SCHEDULER_INTERVAL_MS` (default: 60s)

**Process:**
1. Only runs on treasury node
2. Checks cooldown: Last successful rebalance must be > `REBALANCE_COOLDOWN_MINUTES` ago
3. Gets liquidity health
4. Finds receivers:
   - Classification: `outbound_starved` or `critical`
   - Remote ratio >= minimum threshold
5. Finds donors:
   - Different peer from receiver
   - Local ratio >= minimum threshold
   - Best local ratio wins
6. If pair found:
   - Bounds tokens: `min(default_tokens, max_tokens, available)`
   - Executes circular rebalance with `max_fee_sats` limit
   - One rebalance per tick (no overlap)
7. Dry-run mode: Logs decisions without executing

**Configuration:**
- `REBALANCE_SCHEDULER_ENABLED`: Enable/disable
- `REBALANCE_SCHEDULER_DRY_RUN`: Log only, no execution
- `REBALANCE_SCHEDULER_INTERVAL_MS`: Tick interval
- `REBALANCE_DEFAULT_TOKENS`: Default amount per run
- `REBALANCE_MAX_TOKENS`: Hard ceiling
- `REBALANCE_DEFAULT_MAX_FEE_SATS`: Max fee per run
- `REBALANCE_COOLDOWN_MINUTES`: Cooldown between runs

### 9. Channel Metrics (`GET /api/treasury/channel-metrics`)

**Location:** `src/api/treasury-channel-metrics.ts`

**Per-Channel Calculations:**

**Volume Metrics:**
- `volume_24h_sats`: Sum of forwarded tokens (last 24h)
- `fees_24h_sats`: Sum of forwarding fees (last 24h)
- `fee_per_1k`: `(fees_24h / volume_24h) * 1000` (if volume > 0)

**ROI:**
- `roi_ppm`: `(fees_24h / local_balance) * 1e6` (if local_balance > 0)
- Annualized ROI projection

**Liquidity Efficiency:**
- `liquidity_efficiency`: `volume_24h / local_balance` (turnover ratio)

**Payback Days:**
- `payback_days`: `local_balance / (fees_24h / 24)` (days to recover capital at current rate)
- Null if no fees or negative

### 10. Peer Scoring (`GET /api/treasury/peer-scores`)

**Location:** `src/api/treasury-peer-scoring.ts`

**Calculates:**

**Per-Peer Metrics:**
- Aggregates all channels to same peer
- Sums volume, fees, local balance across channels

**ROI Calculation:**
- `weighted_roi_ppm`: `(total_fees / total_local_balance) * 1e6`
- Accounts for multiple channels to same peer

**Uptime Ratio:**
- `uptime_ratio`: `active_channels / total_channels`
- Measures reliability

**Composite Score:**
- `peer_score = weighted_roi_ppm × uptime_ratio`
- Used in expansion recommendations

### 11. Dynamic Fees (`POST /api/treasury/dynamic-fees`)

**Location:** `src/api/treasury-dynamic-fees.ts`, `src/lightning/fees.ts`

**Purpose:** Adjust channel fees based on imbalance to incentivize rebalancing.

**Process:**
1. Computes fee adjustments for all channels:
   - Imbalance ratio: `local / (local + remote)`
   - If ratio < 0.2 (outbound starved): Increase fee (discourage outbound)
   - If ratio > 0.8 (inbound starved): Decrease fee (encourage inbound)
   - Adjustment magnitude based on severity
2. Logs adjustments to `treasury_channel_fee_log`
3. Applies to LND via `updateChannelPolicy()`

### 12. Channel Rotation (`GET /api/treasury/rotation/candidates`)

**Location:** `src/api/treasury-rotation.ts`

**Purpose:** Identify channels that should be closed and reopened to optimize capital allocation.

**Candidates:**
- Low-performing channels (negative ROI, low volume)
- Channels to underperforming peers
- Channels that could be better allocated

**Execution:** Closes old channel, opens new channel to better peer.

---

## Security & Authentication

### Secrets Management
- Secrets generated on first run
- Stored under `/data/secrets`
- Never hardcoded or committed

### API Authentication

**User/Admin API (Port 3101):**
- JWT authentication (via `auth/jwt.ts`)
- Umbrel-aware (can integrate with Umbrel auth)

**Node-to-Node API (Port 3109):**
- HMAC authentication (via `auth/hmac.ts`)
- Timestamp + nonce to prevent replay attacks
- Never proxied through Umbrel app-proxy

### Role-Based Access Control
- Role derived from identity + treasury channel state
- NOT from bearer tokens
- Enforced in route handlers via `assertTreasury()`, `assertActiveMember()`

---

## Configuration

### Environment Variables (`src/config/env.ts`)

**Required:**
- `TREASURY_PUBKEY`: Compressed public key (33-byte hex, 66 chars)

**Network:**
- `BITCOIN_NETWORK`: `mainnet` | `testnet` | `regtest` (default: `mainnet`)
- `LND_GRPC_HOST`: LND gRPC address (default: `lightning_lnd_1:10009`)

**Rate Limits:**
- `RATE_LIMIT_TX_PER_MINUTE`: Default 5
- `RATE_LIMIT_SATS_PER_MINUTE`: Default 100,000
- `RATE_LIMIT_SATS_PER_HOUR`: Default 1,000,000
- `RATE_LIMIT_MAX_SINGLE_PAYMENT`: Default 250,000

**Rebalance:**
- `REBALANCE_MIN_INCOMING_REMOTE_RATIO_PPM`: Default 200,000 (0.2)
- `REBALANCE_MIN_OUTGOING_LOCAL_RATIO_PPM`: Default 200,000 (0.2)
- `REBALANCE_SAFETY_BUFFER_SATS`: Default 1,000
- `REBALANCE_SCHEDULER_ENABLED`: Default `false`
- `REBALANCE_SCHEDULER_DRY_RUN`: Default `false`
- `REBALANCE_SCHEDULER_INTERVAL_MS`: Default 60,000 (60s)
- `REBALANCE_DEFAULT_TOKENS`: Default 5,000
- `REBALANCE_MAX_TOKENS`: Default 25,000
- `REBALANCE_DEFAULT_MAX_FEE_SATS`: Default 10
- `REBALANCE_COOLDOWN_MINUTES`: Default 30

**Debug:**
- `DEBUG`: `1` or `true` to enable verbose logging
- `NODE_ENV`: `production` or development

### Docker Configuration

**Volumes:**
- `${APP_DATA_DIR:-./data}:/data`: Database and secrets
- `${APP_LIGHTNING_NODE_DATA_DIR:-/home/umbrel/umbrel/app-data/lightning/data/lnd}:/lnd:ro`: LND data (read-only)

**Networks:**
- `umbrel_main_network`: Umbrel network integration

---

## Frontend (Web UI)

**Location:** `app/web/`

**Stack:** React + Vite + TypeScript

**Components:**
- `App.tsx`: Main app with view routing
- `InstallWizard.tsx`: First-run setup wizard
- `Dashboard.tsx`: Main dashboard view

**Features:**
- Node status display
- Channel list
- Treasury metrics (treasury node only)
- Setup wizard for first-run configuration

**API Integration:**
- Fetches from API base URL (`/api/*`)
- Auto-detects setup state (checks treasury metrics endpoint)
- Shows wizard if `TREASURY_PUBKEY` not set or fee policy not configured

---

## Build & Deployment

### Build Commands

**API:**
```bash
cd app/api
npm install
npm run build  # TypeScript → dist/
npm start      # node dist/index.js
```

**Web:**
```bash
cd app/web
npm install
npm run build  # Vite → dist/
npm start      # serve -s dist -l 3200
```

**Full Stack (Docker):**
```bash
docker compose up -d --build
```

### Migration System
- Migrations run automatically on API startup
- Located in `src/db/migrations/`
- Must be idempotent (safe to run multiple times)
- Applied migrations recorded in `migrations` table

---

## Key Design Principles

### Non-Negotiables
1. **Guardrails cannot be bypassed** by automation
2. **Capital reserve floors** must always be respected
3. **Deploy ratio limits** must always be enforced
4. **Rebalance costs** must always be accounted for
5. **Automation must be auditable** and deterministic
6. **Safety > growth**

### Database as Source of Truth
- All metrics computed from database
- LND only called for critical operations
- Sync loop keeps database fresh
- Enables offline analysis and auditing

### Economic Truth Focus
- Net sats = revenue - costs (including rebalance costs)
- Tracks true profitability, not vanity metrics
- ROI calculations account for all costs
- Capital efficiency metrics normalized for comparison

---

## Current Capabilities

✅ **Implemented:**
- Channel expansion engine
- Capital guardrails (reserve, deploy ratio, per-peer caps, cooldowns, daily limits)
- Circular rebalance engine
- Auto channel selection for rebalance
- Rebalance scheduler (automated)
- Rebalance cost ledger
- Treasury metrics API
- Per-channel liquidity health
- Per-channel profitability metrics
- Peer ROI scoring
- Dynamic fee adjustments
- Channel rotation candidates
- Daily loss cap enforcement
- Alert system

🚧 **Future Direction:**
- Channel-level ROI scoring (enhanced)
- Peer profitability ranking (enhanced)
- Dynamic fee adjustment based on imbalance (enhanced)
- Yield-driven capital reallocation
- Fully autonomous LSP behavior
- Coinbase OAuth2 integration (planned)

---

## Testing & Quality

**Current State:**
- No automated test suite exists yet
- Manual testing via API endpoints
- Migrations are idempotent (safe to re-run)

**Recommended Testing:**
- Unit tests for guardrails
- Integration tests for sync loop
- E2E tests for payment flow
- Load tests for rate limiting

---

## File Size & Complexity

- **Main routes file (`index.ts`):** 600+ lines
- **Total TypeScript files:** 47 in `app/api/src`
- **Database migrations:** 18 SQL files
- **API endpoints:** 20+ endpoints
- **Three-layer architecture:** Lightning → API → Utils

---

## Summary

Bitcorn Lightning is a sophisticated Lightning Treasury Capital Allocation Engine that:

1. **Syncs LND state** to SQLite every 15 seconds
2. **Tracks all payments** (inbound, outbound, forwarded) for true net calculation
3. **Enforces capital guardrails** before every channel open
4. **Recommends channel expansions** based on liquidity health and peer ROI
5. **Rebalances liquidity** via circular payments (manual or automated)
6. **Tracks rebalance costs** for accurate profitability
7. **Computes comprehensive metrics** (net sats, ROI, capital efficiency)
8. **Provides treasury-only APIs** for capital management
9. **Enforces rate limits** on member payments
10. **Maintains audit trails** for all operations

The codebase follows a clean three-layer architecture with clear separation of concerns, comprehensive error handling, and a focus on economic truth over vanity metrics.
