# Coinbase Auto-Buy — Design Spec

**Date**: 2026-04-17 (original) · 2026-04-20 (Plan 2 amendments in §5, §6, §8)
**Status**: Plans 1/1-rev/1b shipped on `feature/coinbase-auto-buy` (PR #106). Plan 2 design amendments ready for implementation; Plan 2a backend + Plan 2b UI pending; Plan 2c (backtest) deferred.
**Author**: Design session between Ethan + Claude
**Scope**: v1 — 12-input Valuation DCA, Coinbase Advanced Trade v3, runs on both treasury and member nodes

---

## 1. Purpose

Add a **Valuation-Modulated Dollar Cost Averaging** feature that lets any node (treasury or member) automatically purchase Bitcoin from Coinbase on a recurring schedule, with the buy amount modulated by a composite market-valuation Z-score. Replaces the manual "Fund Node via Coinbase" click-through flow for operators who want hands-off capital inflow.

The feature exists as **two interacting systems**:

1. **Valuation Engine** — a read-only data pipeline that computes a daily composite Z-score of 11 weighted BTC valuation inputs and exposes it to all nodes.
2. **Auto-Buy Executor** — a per-node scheduler that consumes the Z-score, applies a zone multiplier to a base buy amount, executes the Coinbase buy, and (on a separate sweep cadence) withdraws accumulated BTC to the node's on-chain wallet.

Either system can run without the other. The engine is always on; the executor is user-toggleable.

---

## 2. Relationship to existing Coinbase integration

The existing **Coinbase Onramp** integration (v1.0+) is a one-shot, user-initiated, hosted-UX funding flow. Onramp uses:
- A Cloudflare Worker holding CDP credentials
- A server-minted session token
- `pay.coinbase.com` hosted browser UX (user clicks through)

**Auto-Buy is a separate integration** that reuses Onramp's trust-boundary pattern where possible but has a different auth model and a different API endpoint. The two features coexist — Onramp remains the "I need to fund my node right now" button; Auto-Buy is "run a standing DCA order."

| Aspect | Onramp (existing) | Auto-Buy (new) |
|--------|-------------------|----------------|
| Trigger | User click | Scheduled + valuation-weighted |
| Coinbase API | Onramp session (CDP JWT) | Advanced Trade v3 (ECDSA JWT) |
| Credentials held by | Worker (centralised, CDP key) | **Node** (per-user Coinbase Cloud key) |
| Destination address | Fresh per click | **Single stable whitelisted address** |
| UI entry point | `FundNodePanel.tsx` button | New `/auto-buy` page |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLOUDFLARE WORKER  (bitcorn-onramp.ethancail.workers.dev)           │
│                                                                      │
│  Cron trigger (daily 00:15 UTC):                                     │
│    fetch 12 inputs → Z-score each vs full history → weighted         │
│    composite → persist to PRICES_CACHE (KV)                          │
│                                                                      │
│  New endpoints:                                                      │
│    GET /valuation/current   → { z_score, zone, multiplier, updated } │
│    GET /valuation/history   → [{ date, z_score, zone }, ...]         │
│    GET /valuation/inputs    → { mvrv:{z,value,...}, puell:{...} ...} │
│                                                                      │
│  Existing endpoints unchanged (/prices, /prices/corn-history, POST /)│
│                                                                      │
│  New Secrets:                                                        │
│    GLASSNODE_API_KEY, CRYPTOQUANT_API_KEY, LOOKINTOBITCOIN_API_KEY   │
│    (PlanB and Mempool.space are free / no key)                       │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTPS, node polls hourly, cached locally
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  NODE  (app/api — port 3101)                                         │
│                                                                      │
│  src/autoBuy/valuationClient.ts     poll Worker, cache locally       │
│  src/autoBuy/valuationEngine.ts     emit recommendations → DB        │
│  src/autoBuy/scheduler.ts           tick every 15 min                │
│    - scheduled → buy_placed → buy_filled                             │
│    - weekly sweep job: past-hold rows → withdraw → confirmed         │
│  src/autoBuy/coinbaseClient.ts      Advanced Trade v3 JWT signing    │
│  src/autoBuy/credentials.ts         AES-256-GCM at rest              │
│  src/autoBuy/caps.ts                Enforce per-buy/7d/30d caps      │
│                                                                      │
│  Routes in src/index.ts:                                             │
│    /api/autobuy/*    (config, status, history, execute-now, etc.)    │
│    /api/valuation/*  (proxies Worker)                                │
│                                                                      │
│  Credential store:                                                   │
│    /data/secrets/master.key (existing machine secret, created at     │
│      first run) → HKDF-SHA256 → AES-256-GCM for Coinbase PEM at rest │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  NODE  (app/web — port 3200)                                         │
│                                                                      │
│  src/pages/AutoBuy.tsx             new page, 3 tabs                  │
│    Tab 1: Valuation Chart                                            │
│    Tab 2: DCA Strategy (multipliers, backtest, Coinbase integration) │
│    Tab 3: Model Inputs                                               │
│                                                                      │
│  MemberShell.tsx sidebar link between Refill and Payments            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. Valuation Engine (Cloudflare Worker)

### 4.1 Inputs (12 total, weights sum to 1.00)

| Category | Input | Weight | Source | Ingestion |
|----------|-------|--------|--------|-----------|
| On-chain | MVRV Z-Score | 0.18 | Glassnode | **Manual daily entry** |
| On-chain | Puell Multiple | 0.10 | Glassnode | **Manual daily entry** |
| On-chain | SOPR (30d MA) | 0.08 | Glassnode | **Manual daily entry** |
| On-chain | Reserve Risk | 0.07 | Glassnode | **Manual daily entry** |
| Market | Stock-to-Flow Deviation | 0.12 | PlanB API | Automatic (unauthenticated) |
| Market | 200-Week MA Heatmap | 0.10 | Coinbase price → local compute | Automatic (free) |
| Market | PI Cycle Top Indicator | 0.07 | Coinbase price → local compute | Automatic (free) |
| Market | NVT Signal | 0.08 | Glassnode | **Manual daily entry** |
| Mining | Hash Ribbons | 0.06 | Glassnode | **Manual daily entry** |
| Mining | Difficulty Ribbon | 0.05 | Glassnode | **Manual daily entry** |
| Mining | Miner Outflows | 0.04 | CryptoQuant | Automatic (free API tier) |
| Sentiment | Realized Cap HODL Waves | 0.06 | Glassnode | **Manual daily entry** |
| **Total** | | **1.01** | | 8 manual, 4 automatic |

The original boss-mockup weights total ~1.01 due to display rounding. Implementation renormalises to exactly 1.0 at load time so math is exact regardless of what weights the config table holds.

**Ingestion pivot (2026-04-17)**: to avoid Glassnode's $999/yr subscription cost, the 8 Glassnode metrics are entered manually once per day by the treasury operator via a new treasury-node UI. Values flow treasury → Worker via HMAC-signed POST. The remaining 4 metrics stay fully automatic: CryptoQuant Miner Outflows (free tier, ~10 req/min limit is sufficient for daily cron), PlanB Stock-to-Flow (unauthenticated community mirror), and the two LookIntoBitcoin metrics (200W MA + PI Cycle) which are computable locally from BTC daily price history — LookIntoBitcoin does not sell API access, so local computation was the only viable path. Spec §4.6 (below) details the manual-entry workflow.

### 4.2 Z-score math

For each input `i`:
```
z_i = (current_value_i − historical_mean_i) / historical_stdev_i
```
- `historical_mean_i`, `historical_stdev_i` computed over the full history of that input (2011 → today for most).
- Recomputed daily (incremental update is fine; rolling stats are O(1) per day).

Composite:
```
Z = Σ (w_i × z_i)   where Σ w_i = 1.0
```

Zone mapping (locked by boss's mockup):

| Zone | Z Range | Multiplier |
|------|---------|-----------|
| Extreme Buy | Z < −2 | 3.0× |
| Undervalued | −2 ≤ Z < −1 | 2.0× |
| Fair Value | −1 ≤ Z < 1 | 1.0× |
| Elevated | 1 ≤ Z < 1.5 | 0.5× |
| Overvalued | 1.5 ≤ Z < 2.5 | 0.25× |
| Extreme Sell | Z ≥ 2.5 | 0.0× (skip) |

Users can override these multipliers per-node (stored in `autobuy_config.zone_multipliers` JSON). Zone boundaries are **not** user-configurable in v1.

### 4.3 Historical backfill and look-ahead policy

On Worker first-deploy, a one-time backfill:
- Fetch full history per input from each upstream (Glassnode supports `since` query; CryptoQuant similar; Mempool.space has blocks API for derived inputs)
- Compute per-day Z-score for each input, then composite
- Persist to KV as one blob per series (12 input series + 1 composite series = 13 series total)
- KV keys: `valuation_history_v1` (composite), `valuation_input_<name>` per input
- Expected size: ~5,500 daily rows × 13 series ≈ 2 MB total; KV per-key limit is 25 MB — safe

Incremental daily job appends one row per series.

**Look-ahead policy (important for backtest honesty):** Z-scores on historical rows are computed using the **full-history mean and stdev** (i.e., the 2015-01-01 Z-score uses mean/stdev computed over 2011 → today). This introduces look-ahead bias when the same series is used as a backtest reference — the 2015 row "knows" the 2020 bull run. For v1 we accept this bias for simplicity and consistency between chart display and backtest. The `/api/autobuy/backtest` response includes a disclaimer field `look_ahead_bias: true` so the UI can surface a small footnote. A future v2 can add a second pre-computed series (`valuation_history_v1_rolling`) where each day's Z-score uses only data up to that day — more expensive to compute (O(n²) naive; O(n) with incremental moments) but bias-free.

### 4.4 Worker endpoints

```
GET /valuation/current
→ {
    z_score: -1.44,
    zone: "undervalued",
    multiplier: 2.0,
    updated_at: "2026-04-17T00:15:00Z",
    price_usd: 71434
  }

GET /valuation/history?since=2011-01-01&until=2026-04-17
→ {
    series: [
      { date: "2011-01-01", z_score: 1.23, zone: "elevated", price_usd: 0.30 },
      ...
    ]
  }

GET /valuation/inputs
→ {
    mvrv_z_score:  { value: 2.1, z: -1.8, weight: 0.18, updated_at: "..." },
    puell:         { value: 0.4, z: -1.2, weight: 0.10, updated_at: "..." },
    ...
  }
```

All three cached in KV with 24h TTL after the daily cron writes them. Fallback behaviour mirrors existing `/prices`: serve last successful blob under an `X-Price-Source: fallback` header if the cron failed.

### 4.5 Worker Secrets (revised after 2026-04-17 pivot)

Added via `wrangler secret put`:
- `CRYPTOQUANT_API_KEY` — free-tier key for the Miner Outflows adapter
- `VALUATION_SUBMIT_HMAC` — shared secret between treasury node and Worker for authenticating manual-input POST

Removed from original design (not needed after manual-input pivot):
- ~~`GLASSNODE_API_KEY`~~ — Glassnode subscription avoided; 8 metrics go through manual entry
- ~~`LOOKINTOBITCOIN_API_KEY`~~ — no public API exists; metrics computed locally from price

Existing secrets (`CDP_KEY_NAME`, `CDP_PRIVATE_KEY`, `USDA_NASS_KEY`, `GOLD_API_KEY`) remain unchanged.

### 4.6 Manual-input workflow (added 2026-04-17)

The 8 Glassnode metrics are entered by the treasury operator once per day. The flow:

```
Treasury operator (web UI, admin-only)
  → /valuation-input page on the treasury node
  → types 8 numeric values (reading from each metric's free public chart)
  → clicks "Save All"
  → POST /api/valuation/manual  (treasury API, JWT-authed)
    → persists to treasury SQLite (audit + "last entered" display)
    → HMAC-signs the payload
    → POST <worker>/valuation/manual  (Worker endpoint, HMAC-authed)
      → appends one {timestamp, value} row per metric to KV key valuation_manual_v1
  → next cron run (or immediate if operator triggers)
    → engine reads the 8 manual series from KV (via manualInput adapters)
    → combines with 4 automatic adapters
    → composite persists as usual
```

**KV shape** (`valuation_manual_v1`):

```json
{
  "mvrv":              [{ "timestamp": 1744934400, "value": 2.10 }, ...],
  "puell":             [...],
  "sopr":              [...],
  "reserve_risk":      [...],
  "nvt":               [...],
  "hash_ribbons":      [...],
  "difficulty_ribbon": [...],
  "hodl_waves":        [...]
}
```

Each daily submission appends one row per metric. History grows organically; Z-score fidelity improves as the series lengthens (day 1: stdev=0 → contribution=0; day 30: usable; day 200: equivalent to paid-API fidelity).

**HMAC signing** (request body canonicalisation):
- Canonical string: `<ISO timestamp>\n<SHA-256 of JSON body (hex)>`
- Signature: HMAC-SHA256 of canonical string with `VALUATION_SUBMIT_HMAC` key, hex-encoded
- Sent as `X-Valuation-Signature` header alongside `X-Valuation-Timestamp`
- Worker rejects if timestamp skew > 5 minutes (replay protection) or signature mismatch

**Worker endpoint**: `POST /valuation/manual`
- Body: `{ submitted_at: ISO, values: { mvrv, puell, sopr, reserve_risk, nvt, hash_ribbons, difficulty_ribbon, hodl_waves } }`
- Response: 204 on success; 401 on bad/missing signature; 400 on shape mismatch; 503 on KV failure
- Rate limit: 1 req/min per IP (replay already blocked by timestamp check; this is abuse prevention)

**Staleness handling**:
- Manual adapter's `fetchHistory()` returns the stored array verbatim
- Engine runs unchanged — it just sees 8 "adapters" whose data happens to come from KV instead of a live upstream
- If the treasury operator misses a day (no row appended for that date), the adapter's latest value is yesterday's. As staleness grows, the treasury alert fires but the engine still uses the stale value (same as any other adapter's cached reading). Past 48h stale, the engine drops the metric entirely (same `AUTOBUY_STALE_DATA_MAX_HOURS` logic from §5.3 applied to each per-metric series).

**Treasury-side components** (new in Plan 1b):
- Migration `028_valuation_manual_inputs.sql` — local cache of the latest submission (NOT the full history — that lives in Worker KV)
- API `POST /api/valuation/manual` — JWT-gated, treasury-role only; writes to SQLite + forwards to Worker with HMAC signature
- API `GET /api/valuation/manual/status` — returns per-metric last-entered timestamp + value, for the UI
- Alert generator — produces `VALUATION_MANUAL_STALE` when any metric is > 24h old; consumed by existing `treasury_alerts` system
- Web page `/valuation-input` (AppShell, admin-gated) — 8 numeric inputs + last-entered display per metric + external chart link per metric
- Dashboard banner when staleness alert active, linking to `/valuation-input`
- Sidebar link in AppShell

---

## 5. Auto-Buy Executor (Node)

**Amendment (2026-04-20)** — after Plans 1/1-rev/1b shipped, the following small adjustments were made to §5/§6/§8 during Plan 2 brainstorming; see the amended sections below for details:
- Migration number 028 → 034 (028–033 are now taken by unrelated migrations on main/develop).
- Role gating: both treasury AND member nodes can run Auto-Buy (originally member-only). Treasury Auto-Buy removed from the §8 non-goals list.
- Backtest endpoint + UI deferred from Plan 2 to Plan 2c.
- Plan 2 split into 2a (backend, curl-testable) + 2b (web UI consumption).

### 5.1 Database schema — migration `034_coinbase_autobuy.sql`

```sql
CREATE TABLE coinbase_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_name TEXT NOT NULL,
  encrypted_private_key BLOB NOT NULL,
  nonce BLOB NOT NULL,
  connected_at INTEGER NOT NULL,
  last_verified_at INTEGER
);

CREATE TABLE autobuy_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  base_unit_usd REAL NOT NULL DEFAULT 100,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  zone_multipliers TEXT NOT NULL,
  withdraw_address TEXT NOT NULL,
  withdraw_address_whitelisted_at INTEGER,
  sweep_day_of_week INTEGER NOT NULL DEFAULT 0,     -- 0 = Sunday
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  last_run_at INTEGER,
  next_run_at INTEGER
);

CREATE TABLE autobuy_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_for INTEGER NOT NULL,
  z_score REAL,
  zone TEXT,
  multiplier REAL,
  base_unit_usd REAL,
  intended_buy_usd REAL,
  status TEXT NOT NULL,
  coinbase_order_id TEXT,
  filled_btc REAL,
  filled_usd REAL,
  withdraw_txid TEXT,
  withdraw_sweep_id INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_autobuy_runs_status ON autobuy_runs(status);
CREATE INDEX idx_autobuy_runs_scheduled ON autobuy_runs(scheduled_for);

CREATE TABLE autobuy_sweeps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swept_at INTEGER NOT NULL,
  btc_amount REAL NOT NULL,
  withdraw_txid TEXT,
  status TEXT NOT NULL,              -- placed|broadcast|confirmed|failed
  error_code TEXT,
  error_message TEXT
);
```

**Seed row** on first run: insert `autobuy_config` row with sane defaults and generated `withdraw_address` via `createLndChainAddress()`.

### 5.2 State machine

```
scheduled
  │
  ├─▶ skipped_cap_hit            (hit AUTOBUY_MAX_* cap)
  ├─▶ skipped_zero_multiplier    (zone = extreme_sell)
  ├─▶ skipped_stale_data         (Z-score > 48h old)
  ├─▶ skipped_insufficient_usd   (Coinbase USD balance < intended_buy_usd)
  │
  └─▶ buy_placed ──▶ buy_filled
        │              │
        │              └─▶ awaiting_withdraw_hold (72h)
        │                    │
        │                    └─▶ sweep_assigned ──▶ withdraw_placed ──▶ withdraw_confirmed
        │                          │                  │
        │                          │                  └─▶ failed_withdraw
        │                          │
        │                          └─▶ (sweep deferred — total < min)
        │
        └─▶ failed_buy
```

**Row population strategy**: the `autobuy_runs` table persists exactly **one currently-due `scheduled` row at a time**. The mockup's "Upcoming & Recent Purchases" table shows 10+ future scheduled buys; those are **computed on-the-fly** by projecting `current_z_score × multiplier × base_unit` forward by `frequency` N times. They are not persisted until their scheduled time arrives (at which point the scheduler creates the row and transitions it in the same tick). This keeps the table compact and immune to stale projections when the user edits `base_unit` or `frequency` mid-stream.

**Cap accounting**: the 7d / 30d rolling caps sum `filled_usd` from rows in `buy_filled`, `awaiting_withdraw_hold`, `sweep_assigned`, `withdraw_placed`, `withdraw_confirmed`. Rows in `failed_buy`, `failed_withdraw`, or any `skipped_*` state do **not** count — failed spend didn't happen.

**Failure counter**: `consecutive_failures` increments on any `failed_buy`, `failed_withdraw`, or sweep-level failure (`autobuy_sweeps.status = failed`). `skipped_*` transitions do **not** increment it. Any successful `withdraw_confirmed` or `autobuy_sweeps.status = confirmed` resets it to 0.

Scheduler tick (every 15 min):
1. Create a `scheduled` row if none exists and `now() >= autobuy_config.next_run_at`. Run the row through cap/data/balance checks; transition to `buy_placed` or a `skipped_*` state. On transition (success or skip), compute and persist the **next** `next_run_at` based on `frequency` and the row's `scheduled_for`.
2. Enumerate `buy_placed` rows; poll Coinbase order; transition to `buy_filled` or `failed_buy`.
3. Enumerate `awaiting_withdraw_hold` rows where `filled_at + 72h <= now()`; transition to `sweep_assigned` and assign them to the current open sweep (create one in `autobuy_sweeps` if none exists).
4. **Sweep gate — runs at most once per UTC day**: the first tick on `sweep_day_of_week` where no sweep has `swept_at >= today_00:00Z` totals all `sweep_assigned` BTC, compares to minimum (0.0001 BTC). If ≥ min, issues withdraw and transitions rows to `withdraw_placed` + sweep to `placed`. If < min, the sweep is deferred (no state change; no row for today; retries next week).
5. Enumerate `withdraw_placed` rows; poll Coinbase transaction status; transition to `withdraw_confirmed` or `failed_withdraw`. When a sweep's last row reaches `withdraw_confirmed`, the sweep itself transitions to `confirmed`.

### 5.3 Safety caps (`src/autoBuy/caps.ts`)

Read from env + config; checked on step 1 of every tick:

| Env | Default | Behaviour on breach |
|-----|---------|---------------------|
| `AUTOBUY_ENABLED` | `false` | Engine refuses to schedule anything |
| `AUTOBUY_MAX_SINGLE_BUY_USD` | `1000` | Row → `skipped_cap_hit` |
| `AUTOBUY_MAX_7D_USD` | `2000` | Row → `skipped_cap_hit` (sum over last 7d `filled_usd`) |
| `AUTOBUY_MAX_30D_USD` | `5000` | Row → `skipped_cap_hit` |
| `AUTOBUY_BASE_UNIT_MAX_USD` | `500` | API rejects PATCH with `base_unit_exceeds_cap` |
| `AUTOBUY_STALE_DATA_MAX_HOURS` | `48` | Row → `skipped_stale_data` |
| `AUTOBUY_FAILURE_PAUSE_THRESHOLD` | `3` | Sets `paused_reason=consecutive_failures`, `enabled=0` |

A `skipped_*` status **does not** increment `consecutive_failures`. Only `failed_buy` / `failed_withdraw` do. Any successful `withdraw_confirmed` resets the counter to 0.

### 5.4 Credential storage (`src/autoBuy/credentials.ts`)

- Master key: `/data/secrets/master.key` — already generated at first run of the API container by existing secret-management code. If it doesn't exist on a fresh install the module creates it with 32 bytes of `crypto.randomBytes`.
- Per-secret key derivation: `HKDF-SHA256(masterKey, info="coinbase-autobuy", length=32)` — standard HKDF extract-then-expand.
- Encryption: AES-256-GCM with a fresh 12-byte nonce per write. Ciphertext + 16-byte auth tag stored in `encrypted_private_key`; nonce in `nonce`.
- Plaintext PEM is held in memory only during a Coinbase API call; never logged.
- On decrypt failure (auth tag mismatch), API returns `credentials_corrupted` — user must reconnect.

### 5.5 Coinbase Advanced Trade v3 client (`src/autoBuy/coinbaseClient.ts`)

Reuse the Worker's JWT signing logic (`jose` library, `importPKCS8`, `ES256` alg). The Worker file `cloudflare-worker/src/index.ts` already contains a battle-tested `sec1ToPkcs8Pem()` helper; port that into node code.

Per-request JWT claims (per Coinbase docs):
```
{
  sub: <key_name>,
  iss: "cdp",
  nbf: now,
  exp: now + 120,
  uri: `${method} api.coinbase.com${path}`
}
```

**Operations used**:
- `GET /api/v3/brokerage/accounts` — credential verification + USD/BTC balance check
- `POST /api/v3/brokerage/orders` with `market_market_ioc.quote_size` — place buy
- `GET /api/v3/brokerage/orders/historical/{order_id}` — poll fill
- `POST /v2/accounts/{btc_account_id}/transactions` with `type=send` — withdraw
- `GET /v2/accounts/{btc_account_id}/transactions/{tx_id}` — poll confirmation

### 5.6 Node-side API routes (`src/index.ts` additions)

Gated to any node with a known `node_role` (treasury or member — both allowed). Use `assertNonEmpty(node?.node_role)` rather than `assertMember()` / `assertTreasury()`.

```
GET    /api/autobuy/status
GET    /api/autobuy/history?limit=50&offset=0&status=...
POST   /api/autobuy/credentials          { json_blob? | key_name, private_key }
DELETE /api/autobuy/credentials
POST   /api/autobuy/credentials/verify
PATCH  /api/autobuy/config               { base_unit_usd?, frequency?, zone_multipliers?, sweep_day_of_week? }
POST   /api/autobuy/enable               → 400 if no credentials or address not whitelisted
POST   /api/autobuy/pause
POST   /api/autobuy/execute-now          → creates a one-off run outside cadence

GET    /api/valuation/current
GET    /api/valuation/history?since=&until=
GET    /api/valuation/inputs
```

The `GET /api/autobuy/backtest` endpoint originally listed here is **deferred to Plan 2c** along with its UI simulator card (see §6.2 amendment and §8).

`/api/valuation/*` endpoints are thin Worker proxies that cache for 60 min in node memory (matches existing `/api/commodity-prices` pattern).

---

## 6. UI (`app/web/src/pages/AutoBuy.tsx`)

New top-level `/auto-buy` page. Sidebar link added to **both** `MemberShell.tsx` (between Refill Channel and Payments) AND `AppShell.tsx` (after Swaps, before Valuation Inputs). Per the §5 amendment, Auto-Buy runs on both treasury and member nodes.

Page structure (matches boss's mockup):

### 6.1 Tab 1 — Valuation Chart

- Header row of 5 hero cards: Current Z-Score, Bitcoin Price (w/ ATH), Historical Percentile (% of readings above current Z), Peak Z-Score (w/ date), Current Multiplier
- Gauge + zone colour scale + distribution statistics block
- BTC log-price chart (2011–present) colored daily by zone (reuse recharts LineChart pattern from `MovingAveragesChart.tsx`)
- Z-score aggregate chart below (daily, 2011–present)

### 6.2 Tab 2 — DCA Strategy

- Summary banner: "At current Z-score, if base = $X the next buy is $Y"
- **Zone Buy Multipliers** card: editable inputs, saves to `zone_multipliers` JSON
- **Historical Backtest Simulator** card — **deferred to Plan 2c** (not in 2b's initial UI ship). When 2c lands, card appears here with start/end date + base + frequency + RUN button calling `/api/autobuy/backtest`.
- **Upcoming & Recent Purchases** table (status badges: NEXT, SCHEDULED, PLACED, FILLED, AWAITING-WITHDRAW, WITHDRAWN, SKIPPED, FAILED)
- **Coinbase Integration** card:
  - **Disconnected state**: textarea "Paste Coinbase Cloud Key JSON" + Save & Connect button (parses JSON, sends to `POST /api/autobuy/credentials`). Helper link "How to create a Coinbase Cloud Key →".
  - **Connected state (not yet whitelisted)**:
    - Masked key name + "Verify connection" button
    - **"Your dedicated deposit address"** panel: address + QR + "Copy" + "I've whitelisted this in Coinbase" confirm button
    - Link "How to whitelist an address in Coinbase →"
  - **Connected + whitelisted state**:
    - Verified connection status
    - Execute Now button
    - Disconnect button
- Pause/Resume master switch with status banner if auto-paused
- Banner row for stale-data, insufficient-USD, or credential-invalid warnings (reuse `treasury_alerts` styling)

### 6.3 Tab 3 — Model Inputs

- Read-only table of all 12 inputs: name, category, source, current value, current per-input Z, weight, last updated
- Description blurb explaining the composite model
- "Data Update Methodology" block (copy from mockup verbatim)

### 6.4 Routing

- Add `<Route path="auto-buy" element={<AutoBuy />} />` in `App.tsx` under **both** the AppShell (treasury) AND MemberShell routes blocks.
- Sidebar entry in **both** shells:
  ```tsx
  { to: "/auto-buy", label: "Auto-Buy", icon: "📈" }
  ```
  Treasury sidebar placement: after "Swaps", before "Valuation Inputs".
  Member sidebar placement: between "Refill Channel" and "Payments".

---

## 7. Error handling & edge cases

| Condition | Detection | Response |
|-----------|-----------|----------|
| Worker upstream fails | `/valuation/current` returns fallback or fails | Engine uses last cached Z-score until `updated_at > 48h old`; then refuses buys and UI shows banner |
| Coinbase 401/403 on any request | HTTP status from client | `enabled=0`, `paused_reason=credentials_invalid`, emit `AUTOBUY_CREDENTIALS_INVALID` treasury alert |
| Coinbase withdrawal blocked (non-whitelisted) | error code from withdraw call | `paused_reason=address_not_whitelisted`, UI surfaces remediation |
| Coinbase USD balance < intended buy | balance check on step 1 | Row `skipped_insufficient_usd`, emit `AUTOBUY_INSUFFICIENT_USD` warning alert (not pause) |
| Coinbase hold still active at sweep time | Per-row `filled_at + 72h` > now | Row stays in `awaiting_withdraw_hold`, sweep picks up next week |
| Sweep total < minimum withdrawal (0.0001 BTC) | Sum before issuing withdraw | Sweep deferred; no state change; tries again next sweep day |
| Consecutive fails ≥ 3 | Counter on each `failed_*` transition | `enabled=0`, `paused_reason=consecutive_failures`, emit `AUTOBUY_AUTOPAUSED` treasury alert |
| User disconnects credentials | `DELETE /api/autobuy/credentials` | Clear credentials row, set `enabled=0`, `paused_reason=no_credentials` |
| Fresh deposit address generation | First `/api/autobuy/status` call after migration | If `withdraw_address` empty, call `createLndChainAddress()`, persist, require whitelist confirm before enable |

---

## 8. Non-goals / out of scope for v1

- **Coinbase USD auto-replenishment** — users handle their own ACH/debit-card deposit setup inside Coinbase; we only warn on low balance.
- **Weight tuning UI** — Model Inputs tab is read-only in v1; weight edits come in v2.
- **Zone boundary editing** — zones are fixed at the boss-mockup values; only multipliers are user-configurable.
- **Non-Coinbase exchanges** — no Kraken / Strike / river integration in v1.
- **Multi-asset DCA** — BTC only; no stablecoin stacking or asset-rotation.
- **Scheduled withdrawals to multiple addresses** — single stable address only.
- **Backtest simulator (endpoint + UI)** — deferred to Plan 2c. Plan 2a/2b ship a working auto-buy without historical simulation; backtest is a nice-to-have that requires Worker's `/valuation/history` but doesn't affect real-money flow. Add after real buys are validated in production.

*Previously listed as out-of-scope but now IN scope after Plan 2 brainstorming (see §5 amendment):*
- ~~Treasury auto-buy~~ — auto-buy is capital inflow; existing treasury guardrails govern outflow, so no conflict. Treasury nodes can now run auto-buy alongside member nodes.

---

## 9. Deployment & rollout

### 9.1 Worker

1. Add `GLASSNODE_API_KEY`, `CRYPTOQUANT_API_KEY`, `LOOKINTOBITCOIN_API_KEY` via `wrangler secret put`.
2. Add cron trigger `0 15 0 * * *` (daily 00:15 UTC) in `wrangler.toml`.
3. Deploy backfill by running a one-off script that hits the Worker's `/internal/backfill` endpoint (admin-gated) until KV is populated.

### 9.2 Node

1. Add migration 028.
2. Deploy new `app/api` with `AUTOBUY_ENABLED=false` default so the feature is dormant until a user opts in.
3. Deploy new `app/web` with the `/auto-buy` page.
4. Bump `umbrel-app.yml` + `docker-compose.yml` image tags in lockstep (see CLAUDE.md release-cadence guidance).

### 9.3 User onboarding flow

1. User clicks "Auto-Buy" in sidebar.
2. Sees Valuation Chart (works immediately, no config required — just observability).
3. On DCA Strategy tab, sees Coinbase Integration card in disconnected state.
4. User creates a Coinbase Cloud Key (docs link), pastes JSON, clicks Save & Connect.
5. Node generates dedicated deposit address; user sees "Copy & whitelist in Coinbase."
6. User adds the address to their Coinbase allowlist (2FA confirms in Coinbase's own UI).
7. User clicks "I've whitelisted this" to confirm.
8. Enable button unlocks; user clicks Enable.
9. First scheduled buy runs at next cadence boundary; or user clicks Execute Now.

---

## 10. Environment variables — summary of additions

| Var | Default | Purpose |
|-----|---------|---------|
| `AUTOBUY_ENABLED` | `false` | Global kill switch |
| `AUTOBUY_MAX_SINGLE_BUY_USD` | `1000` | Per-buy cap |
| `AUTOBUY_MAX_7D_USD` | `2000` | 7-day rolling cap |
| `AUTOBUY_MAX_30D_USD` | `5000` | 30-day rolling cap |
| `AUTOBUY_BASE_UNIT_MAX_USD` | `500` | UI-configurable base unit ceiling |
| `AUTOBUY_STALE_DATA_MAX_HOURS` | `48` | Refuse buys on stale Z-score |
| `AUTOBUY_FAILURE_PAUSE_THRESHOLD` | `3` | Auto-pause after N consecutive failures |

All documented in `app/api/src/config/env.ts`.

---

## 11. Verification plan (manual — repo has no automated test suite)

Before merging to `main`:
- **Unit-level sanity**: hand-run `valuationEngine.ts` with a synthetic input set; verify zone boundaries and multiplier math against the spec table.
- **Credential roundtrip**: write-then-read a dummy PEM through `credentials.ts`; intentionally corrupt the ciphertext and confirm `credentials_corrupted` error.
- **Cap enforcement**: seed `autobuy_runs` with past `filled_usd` values summing to within $1 of each cap, trigger a tick, confirm `skipped_cap_hit`.
- **State machine happy path**: use Coinbase Advanced Trade API's sandbox (if available) or a small real-money `$1` buy with `AUTOBUY_MAX_SINGLE_BUY_USD=1` to walk a single row from `scheduled` → `withdraw_confirmed` and confirm each transition.
- **Sweep batching**: backdate two `buy_filled` rows past their 72h hold, trigger a tick on the sweep day, confirm both roll into one sweep and one on-chain withdrawal.
- **Whitelist enforcement**: intentionally skip the "I've whitelisted this" confirmation, confirm Enable is disabled.
- **UI visual QA**: load the three tabs with real Worker data; confirm charts render, backtest runs against `/api/autobuy/backtest`, connected/disconnected credential states render correctly.
- **Mobile viewport** (per existing UI patterns): tables/cards collapse cleanly below ~600px wide.

---

## 12. Open implementation questions (to resolve during plan-writing)

- Exact Glassnode / CryptoQuant endpoint schemas — need to draft per-input adapters during the plan phase.
- Whether to prebake a snapshot of the first backfill in a checked-in JSON (like `power-law-data.json`) as a seed, or require the Worker cron to populate from scratch on first deploy.
- Whether to offer a "test buy" ($1 buy to verify the full pipeline end-to-end) as a distinct feature vs. using Execute Now with a temporarily-lowered base.
- Treasury-alert wiring for the new `AUTOBUY_*` alert types — follow the existing `treasury_alerts` table patterns.

---

## 13. Reference

- Boss's mockup reference: https://claude.ai/public/artifacts/680ebf74-16f2-49fb-9fb5-51b20d08d9e7 (auth-required; local screenshots in session)
- Existing Onramp integration: `docs/COINBASE_INTEGRATION.md`, `app/api/src/api/coinbase-onramp.ts`, `cloudflare-worker/src/index.ts`
- Existing advisor→executor pattern (template for this design): `src/memberAdvisor/*`, `src/memberLiquidity/*`
- Prior session memory notes: `~/.claude/projects/.../memory/coinbase-auto-buy-architecture.md` (architectural skeleton — superseded where this spec disagrees; specifically, this spec places credentials on-device rather than in the Worker)
