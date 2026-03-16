# Bitcorn Lightning — Member Swap Actions v1 Spec

## Overview

Two member-facing liquidity actions, automatically triggered by channel state detection:

- **Cash Out** — member's Lightning balance is high, they want to move sats on-chain → backed by Loop In
- **Top Up** — member's Lightning balance is low, they need more spending capacity → backed by Loop Out

Neither action is automatic. The pattern is: **detect → recommend → treasury confirms → execute → record.**

Member role (farmer/merchant behavior) is inferred from channel state, not stored as a classification. The same member can receive a Cash Out recommendation at one point in time and a Top Up recommendation at another.

---

## Detection Logic

### Cash Out trigger (member-local heavy)

Member is accumulating Lightning balance faster than they're spending. Channel looks like a farmer receiving payments.

All of the following must be true:
- `remote_balance_sat / capacity_sat >= cashout_trigger_pct` (default 60%)
- Cluster has been in this state for 2+ consecutive scheduler runs
- `remote_balance_sat >= min_swap_sats` (default 50,000 — Loop minimum)
- No pending swap for this cluster

Suggested amount: move enough to bring member-local back to 40% of capacity (mid-band for receiving members), capped at `max_swap_sats`.

### Top Up trigger (member-local depleted)

Member has spent down their Lightning balance and needs more capacity. Channel looks like a merchant running low.

All of the following must be true:
- `local_balance_sat / capacity_sat <= topup_trigger_pct` (default 30%)
  — note: `local_balance_sat` here is **member-local**, i.e. `capacity - treasury_local`
- Cluster has been in this state for 2+ consecutive scheduler runs
- Suggested top-up amount >= `min_swap_sats` (default 50,000)
- No pending swap for this cluster

Suggested amount: move enough to bring member-local back to 60% of capacity, capped at `max_swap_sats`.

### Why 2+ consecutive runs

Prevents recommendations from firing on transient spikes. A single large payment can temporarily move a channel out of normal range; two consecutive runs (30 minutes apart) confirms the state is real.

---

## Loop Direction Clarification

All Loop directions are from the **treasury node's perspective** (the node running loopd):

- **Loop Out** through a channel = treasury-local decreases, member-local increases
- **Loop In** through a channel = treasury-local increases, member-local decreases

Therefore:
- **Top Up** (member-local too low → increase it) = treasury-local must decrease = **Loop Out**, `outgoing_channel = member channel`
- **Cash Out** (member-local too high → reduce it) = treasury-local must increase = **Loop In**, `last_hop = member pubkey`

This is proven by the ACINQ swap: Loop Out decreased treasury-local on that channel. The same operation on a member channel increases the member's balance — which is Top Up, not Cash Out.

## Loop In Verification Gate

**Loop In support on loopd/LiT must be verified before the Cash Out action is built.**

Before implementing `POST /api/member-swaps/recommendations/:id/approve` for Cash Out swaps, run:

```bash
loop in --help
# or via loopd gRPC: check LoopInTerms endpoint
```

If Loop In is unavailable or returns errors, Cash Out should be stubbed in the UI as "Coming Soon" and its executor marked deferred. Do not build against an unverified loopd endpoint.

Top Up (Loop Out) proceeds regardless — Loop Out is already confirmed working.

---

## Module Layout

```
src/memberSwaps/
  swapDetector.ts       — runs after each rebalance scheduler tick, detects trigger conditions
  swapAdvisor.ts        — computes suggested amount, estimated fees, post-swap state
  swapExecutor.ts       — executes approved swap via loopd, records outcome
  swapRoutes.ts         — API endpoints
```

---

## Module Contracts

### `swapDetector.ts`

Runs at the end of each rebalance scheduler cycle, after inventory snapshot is written.

```typescript
type SwapType = 'cash_out' | 'top_up';

interface SwapRecommendation {
  recommendationId: string;
  clusterId: string;
  memberLabel: string;
  swapType: SwapType;
  triggerReason: string;         // e.g. "member-local 72% — above 60% threshold for 2 runs"
  suggestedAmountSats: number;
  estimatedFeeSats: number | null;  // null until advisor prices it
  postSwapLocalPct: number;         // projected treasury-local % after swap
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'complete' | 'failed';
  createdAt: number;
}

function detectSwapOpportunities(clusterStates: ClusterState[]): Promise<SwapRecommendation[]>
```

**Detection uses `lnd_channels` remote/local balances directly** — no new LND calls needed, cluster state is already read each scheduler run.

---

### `swapAdvisor.ts`

Prices a recommendation before it is shown to the treasury operator.

```typescript
interface SwapQuote {
  recommendationId: string;
  swapType: SwapType;
  amountSats: number;
  estimatedSwapFeeSats: number;    // from loopd LoopOutTerms / LoopInTerms
  estimatedMinerFeeSats: number;
  estimatedPrepayFeeSats: number;  // Loop Out only — flat ~30k sats
  totalEstimatedFeeSats: number;
  feeAsPct: number;                // totalEstimatedFeeSats / amountSats
  projectedLocalPct: number;       // treasury-local % after swap
  projectedRemotePct: number;
  withinFeeTolerancePct: boolean;  // true if feeAsPct <= max_fee_tolerance (default 2%)
  quotedAt: number;
  quoteTtlSeconds: number;         // default 30 — re-quote if stale
}

async function quoteSwap(rec: SwapRecommendation): Promise<SwapQuote>
```

---

### `swapExecutor.ts`

Executes one approved swap. Never auto-executes — only called after explicit treasury approval.

```typescript
async function executeSwap(
  rec: SwapRecommendation,
  quote: SwapQuote
): Promise<SwapOutcome>

interface SwapOutcome {
  outcomeId: string;
  recommendationId: string;
  swapType: SwapType;
  clusterId: string;
  status: 'success' | 'failure' | 'pending_onchain';
  actualAmountSats: number;
  actualFeeSats: number;
  loopSwapId: string;             // loopd swap ID for tracking
  onchainTxid: string | null;     // populated on success
  failureReason: string | null;
  executedAt: number;
  settledAt: number | null;       // populated when on-chain confirms
}
```

**On-chain settlement is async.** After execution, the swap enters `pending_onchain` status. A poller checks loopd swap status every 60 seconds and updates `settled_at` when confirmed.

---

## API Endpoints

All endpoints are treasury-only. Member-facing UI is a future decision.

### `GET /api/member-swaps/recommendations`

Returns all pending swap recommendations.

```typescript
// Response
{
  recommendations: SwapRecommendation[]
}
```

### `GET /api/member-swaps/recommendations/:id/quote`

Fetches a fresh quote for a recommendation. Re-quotes if existing quote is stale (> `quoteTtlSeconds`).

```typescript
// Response
{ quote: SwapQuote }
```

### `POST /api/member-swaps/recommendations/:id/approve`

Treasury operator approves a recommendation. Triggers execution immediately.

```typescript
// Request body
{
  quoteId: string    // must match a non-stale quote
}

// Response
{
  outcome: SwapOutcome
}
```

### `POST /api/member-swaps/recommendations/:id/reject`

Treasury operator rejects a recommendation. Marks it rejected and suppresses re-detection for `rejection_cooldown_sec` (default 86400 — 24 hours).

### `GET /api/member-swaps/outcomes`

Returns swap outcome history with optional filters.

```typescript
// Query params
?clusterId=string&swapType=cash_out|top_up&status=success|failure|pending_onchain&limit=50
```

### `GET /api/member-swaps/outcomes/:id`

Returns a single outcome including current loopd status for pending swaps.

---

## Database Schema

### Migration 026 — Member swap actions

**`member_swap_recommendations`**
```sql
recommendation_id       TEXT PRIMARY KEY,
cluster_id              TEXT NOT NULL REFERENCES rebalance_clusters(cluster_id),
swap_type               TEXT NOT NULL,          -- cash_out | top_up
trigger_reason          TEXT NOT NULL,
suggested_amount_sats   INTEGER NOT NULL,
estimated_fee_sats      INTEGER,
post_swap_local_pct     REAL,
status                  TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | executing | complete | failed
rejection_cooldown_sec  INTEGER NOT NULL DEFAULT 86400,
rejected_at             INTEGER,
created_at              INTEGER NOT NULL,
updated_at              INTEGER NOT NULL
```

**`member_swap_quotes`**
```sql
quote_id                TEXT PRIMARY KEY,
recommendation_id       TEXT NOT NULL REFERENCES member_swap_recommendations(recommendation_id),
amount_sats             INTEGER NOT NULL,
estimated_swap_fee_sats INTEGER NOT NULL,
estimated_miner_fee_sats INTEGER NOT NULL,
estimated_prepay_fee_sats INTEGER,             -- Loop Out only
total_estimated_fee_sats INTEGER NOT NULL,
fee_as_pct              REAL NOT NULL,
projected_local_pct     REAL NOT NULL,
projected_remote_pct    REAL NOT NULL,
within_fee_tolerance    INTEGER NOT NULL,       -- 0 | 1
quoted_at               INTEGER NOT NULL,
quote_ttl_seconds       INTEGER NOT NULL DEFAULT 30
```

**`member_swap_outcomes`**
```sql
outcome_id              TEXT PRIMARY KEY,
recommendation_id       TEXT NOT NULL REFERENCES member_swap_recommendations(recommendation_id),
quote_id                TEXT NOT NULL REFERENCES member_swap_quotes(quote_id),
cluster_id              TEXT NOT NULL,
swap_type               TEXT NOT NULL,
status                  TEXT NOT NULL,          -- success | failure | pending_onchain
actual_amount_sats      INTEGER,
actual_fee_sats         INTEGER,
loop_swap_id            TEXT,                  -- loopd swap ID
onchain_txid            TEXT,
failure_reason          TEXT,
executed_at             INTEGER NOT NULL,
settled_at              INTEGER
```

**`member_swap_config`**
```sql
cluster_id              TEXT PRIMARY KEY REFERENCES rebalance_clusters(cluster_id),
cashout_trigger_pct     REAL NOT NULL DEFAULT 0.60,   -- member-local % that triggers cash out
topup_trigger_pct       REAL NOT NULL DEFAULT 0.30,   -- member-local % that triggers top up
min_swap_sats           INTEGER NOT NULL DEFAULT 50000,
max_swap_sats           INTEGER NOT NULL DEFAULT 500000,
max_fee_tolerance_pct   REAL NOT NULL DEFAULT 0.02,   -- 2% max fee before warning
consecutive_runs_required INTEGER NOT NULL DEFAULT 2,
updated_at              INTEGER NOT NULL
```

---

## Scheduler Integration

`swapDetector.ts` is called at the end of each rebalance scheduler run, after the inventory snapshot:

```
Fee steering → pair selection → cycle enumeration → scoring → execute →
topology monitor → inventory snapshot → swap detection
```

Swap detection is the last step — it reads the freshly computed cluster states and writes recommendations to DB. It does not execute anything.

---

## UI Flow (Treasury Admin Panel)

Since the member UI location is not yet decided, v1 surfaces everything in the treasury admin panel. Member-facing UI is a future decision.

**Recommended panel: "Member Liquidity" tab**

```
┌─────────────────────────────────────────────────────┐
│ Member Liquidity                                    │
├──────────┬──────────┬────────────┬──────────────────┤
│ Member   │ Local %  │ Status     │ Action           │
├──────────┼──────────┼────────────┼──────────────────┤
│ Karan    │ 92% loc  │ ⚠ Above    │ [Cash Out →]     │
│ Cael     │ 63% loc  │ ✓ Healthy  │ —                │
└──────────┴──────────┴────────────┴──────────────────┤
```

Clicking **Cash Out →** opens a confirmation modal:

```
Cash Out — Karan
────────────────────────────────
Suggested amount:   180,000 sats
Estimated fees:      31,500 sats (1.75%)
Post-swap local:         ~55%
On-chain destination:  treasury wallet

Quote valid for: 28s  [Refresh Quote]

[Reject]                    [Approve & Execute]
```

Fee tolerance warning appears if `fee_as_pct > max_fee_tolerance_pct`:
> ⚠ Estimated fee (2.4%) exceeds your 2% tolerance. Proceed with caution.

---

## Detection Rules Summary

| Condition | Swap Type | Loop Operation | Direction |
|---|---|---|---|
| Member-local > 60% for 2+ runs | Cash Out | Loop In | `last_hop = member pubkey` — treasury-local increases, member-local decreases |
| Member-local < 30% for 2+ runs | Top Up | Loop Out | `outgoing_channel = member channel` — treasury-local decreases, member-local increases |
| Inside band | No action | — | — |

Note: "member-local" = `capacity - treasury_local_balance`. The treasury sees the remote side; the member sees the local side.

---

## Implementation Order

1. **Migration 026** — all four tables
2. **`swapDetector.ts`** — detection logic only, no execution
3. **Wire detector into rebalance scheduler** — runs last each tick
4. **`swapAdvisor.ts`** — quote fetching from loopd
5. **`swapExecutor.ts` — Top Up first** (Loop Out, already proven working)
6. **Verify Loop In support** — before proceeding to Cash Out execution
7. **`swapExecutor.ts` — Cash Out second** (Loop In, pending verification)
8. **`swapRoutes.ts`** — all five endpoints
9. **Treasury UI** — Member Liquidity tab with confirmation modal

---

## Testing Checklist

- [ ] Detection fires after 2 consecutive above-threshold runs, not 1
- [ ] Detection suppressed during rejection cooldown
- [ ] Detection suppressed when pending swap already exists for cluster
- [ ] Quote TTL enforced — stale quote rejected on approve
- [ ] Fee tolerance warning shown when fee exceeds threshold
- [ ] Approve endpoint rejects mismatched or stale quote ID
- [ ] Execution never fires without explicit approve call
- [ ] `pending_onchain` status polled every 60s until settled
- [ ] `settled_at` populated on confirmation
- [ ] Rejection sets cooldown correctly
- [ ] Loop In verified before Cash Out executor is built

---

## What v1 Deliberately Excludes

- Automatic swap execution without treasury approval
- Member-initiated swaps (member-facing UI deferred)
- Autoloop integration (Lightning Terminal's automated swap layer)
- Multi-hop Loop In routing configuration
- Swap size optimization beyond suggested amount formula
