# Loop-Based Swap Subsystem Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace keysend-based treasury liquidity push with a Loop-based swap subsystem. Add member "Withdraw to Bitcoin Wallet" (Loop Out) and treasury Loop In/Out operations.

**Architecture:** New `src/swaps/` service layer wraps existing `loop.ts` gRPC client. Four new DB tables. Keysend execution path deprecated (code kept, active path redirected). Member-side advisor already recommends Loop actions — this adds the execution path.

## 1. Database Schema (migration 029)

### swap_requests
The intent record. One per member withdrawal or treasury swap initiation.

| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PK, UUID |
| created_at | INTEGER | NOT NULL, ms epoch |
| updated_at | INTEGER | NOT NULL, ms epoch |
| node_pubkey | TEXT | NOT NULL |
| role | TEXT | NOT NULL, CHECK(IN member,treasury) |
| swap_type | TEXT | NOT NULL, CHECK(IN loop_in,loop_out) |
| direction | TEXT | NOT NULL, CHECK(IN lightning_to_chain,chain_to_lightning) |
| status | TEXT | NOT NULL |
| amount_sat | INTEGER | NOT NULL |
| max_fee_sat | INTEGER | |
| quoted_fee_sat | INTEGER | |
| actual_fee_sat | INTEGER | |
| destination_address | TEXT | For Loop Out |
| channel_id | TEXT | For treasury channel-targeted swaps |
| quote_expires_at | INTEGER | ms epoch |
| failure_reason | TEXT | |
| notes | TEXT | |

Indexes: node_pubkey, status, created_at DESC.

### swap_executions
Provider-specific execution tracking. One per swap attempt.

| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PK, UUID |
| swap_request_id | TEXT | NOT NULL, FK → swap_requests |
| provider | TEXT | NOT NULL (loop) |
| provider_swap_id | TEXT | Loop swap hash/id |
| invoice | TEXT | |
| prepay_invoice | TEXT | |
| payment_hash | TEXT | |
| prepay_payment_hash | TEXT | |
| htlc_address | TEXT | |
| onchain_txid | TEXT | |
| sweep_txid | TEXT | |
| timeout_block_height | INTEGER | |
| status | TEXT | NOT NULL |
| raw_provider_status | TEXT | |
| started_at | INTEGER | NOT NULL |
| completed_at | INTEGER | |

Indexes: swap_request_id, provider_swap_id, status.

### swap_events
Immutable audit log. Every state transition, quote result, provider update.

| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PK, UUID |
| swap_request_id | TEXT | NOT NULL |
| swap_execution_id | TEXT | Nullable |
| event_type | TEXT | NOT NULL |
| event_json | TEXT | NOT NULL, JSON blob |
| created_at | INTEGER | NOT NULL |

Index: swap_request_id, created_at DESC.

### liquidity_actions
General liquidity action model replacing keysend-specific recommendations.

| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PK, UUID |
| created_at | INTEGER | NOT NULL |
| updated_at | INTEGER | NOT NULL |
| node_pubkey | TEXT | NOT NULL |
| channel_id | TEXT | |
| actor_role | TEXT | NOT NULL, CHECK(IN member,treasury) |
| action_type | TEXT | NOT NULL, CHECK(IN loop_in,loop_out,rebalance,open_channel,wait,manual_review) |
| reason_code | TEXT | NOT NULL |
| recommended_amount_sat | INTEGER | |
| priority | TEXT | NOT NULL, CHECK(IN low,medium,high,critical) |
| status | TEXT | NOT NULL, CHECK(IN recommended,approved,rejected,executing,completed,failed) |
| approved_by | TEXT | |
| linked_swap_request_id | TEXT | FK → swap_requests |
| expires_at | INTEGER | |

Indexes: node_pubkey, status, linked_swap_request_id.

## 2. App-Level Status Model

```
quote_created → awaiting_confirmation → initiated → executing → confirming → completed
                                          ↓            ↓           ↓
                                        failed       failed      failed
                                          ↓
                                       expired

blocked_policy (pre-initiation rejection)
```

### Loop provider → app status mapping

| Loop SwapState | App Status |
|----------------|------------|
| (quote returned) | quote_created |
| INITIATED | initiated |
| PREIMAGE_REVEALED | executing |
| HTLC_PUBLISHED | executing |
| INVOICE_SETTLED | confirming |
| SUCCESS | completed |
| FAILED | failed |

## 3. Service Layer (src/swaps/)

| File | Purpose |
|------|---------|
| swapService.ts | Orchestrator: createQuote, initiateSwap, getSwap, listSwaps, refreshSwapStatus |
| loopProvider.ts | Loop-specific: wraps loop.ts, normalizes statuses, captures raw payloads into events |
| swapPolicy.ts | Policy enforcement: member limits, treasury limits, fee caps, balance checks |
| swapPoller.ts | Background 15s poll: matches in-flight executions to Loop states, updates DB |
| swapRoutes.ts | Route handlers for member + admin swap endpoints |

loopProvider.ts wraps but does NOT replace loop.ts. Existing treasury auto-rebalance scheduler continues using loop.ts directly.

## 4. Loop In Implementation (new in loop.ts)

Add to existing `src/lightning/loop.ts`:

- `getLoopInTerms()` — calls `GetLoopInTerms` RPC → `{ min_swap_amount, max_swap_amount }`
- `getLoopInQuote(amountSats, confTarget?)` — calls `GetLoopInQuote` RPC → `{ swap_fee_sat, htlc_publish_fee_sat, cltv_delta, conf_target, total_cost_sats }`
- `executeLoopInSwap(params)` — calls `LoopIn` RPC with `{ amt, max_swap_fee, max_miner_fee, htlc_conf_target, label, initiator }`

Same gRPC client, TLS, macaroon, and deadline patterns as existing Loop Out methods.

## 4b. Member Loop Out Policy (Treasury-Path Constrained)

Member Loop Out is NOT validated against aggregate channel balance. It validates
the actual swap path: member → Treasury channel → Treasury node → approved external egress peer.

**Effective max formula:**
```
effective_max = min(
  config_max,                            // MEMBER_MAX_WITHDRAWAL_SAT (env)
  provider_terms_max,                    // Loop server max swap amount
  member_treasury_channel_runtime_max,   // member's Treasury channel local - routing buffer
  treasury_external_runtime_max          // approved egress peers' local - reserve buffer
)
```

**Member-side check:** Queries `lnd_channels WHERE peer_pubkey = TREASURY_PUBKEY AND active = 1`.
Uses the member's local balance on that specific channel minus `SWAP_MEMBER_ROUTING_BUFFER_SAT` (default 50k).

**Treasury egress check:** Queries `swap_egress_peers` (enabled peers), then checks
`lnd_channels WHERE peer_pubkey IN (egress_peers) AND active = 1`. Sums local balance
minus `SWAP_TREASURY_EGRESS_RESERVE_SAT` (default 100k).

**Approved egress peers** are stored in `swap_egress_peers` table (migration 031).
Seeded with ACINQ by default. Treasury operator manages this list.

The limiting factor is logged and surfaced in API error messages.

## 5. API Endpoints

### Member-facing (assertActiveMember)

| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/swaps/loop-out/quote | Get withdrawal quote |
| POST | /api/swaps/loop-out | Confirm and initiate withdrawal |
| GET | /api/swaps/:id | Get swap status (scoped to own pubkey) |
| GET | /api/swaps/history | List own swaps |

### Treasury-facing (assertTreasury)

| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/admin/swaps/loop-in/quote | Get Loop In quote |
| POST | /api/admin/swaps/loop-in | Initiate Loop In |
| POST | /api/admin/swaps/loop-out/quote | Get Loop Out quote |
| POST | /api/admin/swaps/loop-out | Initiate Loop Out |
| GET | /api/admin/swaps | List all swaps |
| GET | /api/admin/swaps/:id | Get any swap detail |

## 6. Policy Enforcement

### Member Loop Out
- Min: 250,000 sats (Loop minimum)
- Max: 2,000,000 sats (member cap, configurable)
- Fee cap: amount × LOOP_MAX_SWAP_FEE_PCT (default 0.5%)
- Balance: must have sufficient Lightning balance via getNodeBalances
- Daily limit: extend member_liquidity_advisor_config with max_daily_withdrawal_sat
- Destination address required, basic bech32/base58 format validation
- Loop availability check

### Treasury Loop Out
- Same fee enforcement as existing rebalance scheduler
- Daily loss cap: assertDailyLossCapNotExceeded()
- Reserve check via capital-guardrails.ts
- Channel must exist and be active (if channel_id specified)

### Treasury Loop In
- Same fee and reserve enforcement
- On-chain balance must cover HTLC publish fee
- Loop In terms validation (amount within min/max)

## 7. Keysend Deprecation

### What changes
- liquidityDetector.ts → writes to liquidity_actions instead of member_liquidity_recommendations
- liquidityRoutes.ts → approve handler creates liquidity_action + swap_request instead of calling executePush()
- liquidityExecutor.ts → add deprecation comment, no longer called from active path
- loopAvailability.ts → remove "Loop In stubbed" comment, wire to real getLoopInTerms()

### What stays
- keysendPush() in lnd.ts (general utility, may be used elsewhere)
- member_keysend_status table (diagnostics)
- Old member_liquidity_* tables (historical data, read-only)
- Member-side advisor + classifier (already recommends Loop actions)

## 8. Swap Poller

Runs on 15s interval (matching sync loop):
1. Query swap_executions with non-terminal status
2. Call listLoopSwaps() from loop.ts
3. Match by provider_swap_id
4. On state change: update execution status, update request status, record event
5. On SUCCESS: populate actual_fee_sat, onchain_txid, sweep_txid
6. On FAILED: populate failure_reason

Started in index.ts server.listen callback alongside other schedulers.

## 9. Frontend

### Member: "Withdraw to Bitcoin Wallet" (/withdraw)
- Amount input (min 250k, max 2M presets + custom)
- Bitcoin address input
- Optional max fee cap
- "Get Quote" → fee breakdown, expiration timer
- "Confirm Withdrawal" → initiates swap
- Status progression (15s polling): quote → initiated → executing → confirming → completed
- Recent withdrawal history table
- No raw Loop jargon — "Withdraw", "Bitcoin wallet", "fee", "processing"

### Treasury: "Swap Operations" (/swaps, treasury shell only)
- Loop Out tab (restore inbound capacity)
- Loop In tab (restore outbound capacity / add funds)
- Amount, channel selection, fee cap inputs
- Quote → confirm → status progression
- All swaps history table
- Liquidity actions table (replaces member liquidity recommendations view)

## 10. What Doesn't Change

- Deposit Bitcoin (separate flow, LND-native addresses)
- Existing treasury auto-rebalance scheduler (still uses loop.ts directly)
- Cluster rebalance engine (fee steering, circular rebalance, topology)
- Contacts, Charts, Payments, Channels pages
- NodeBalancePanel, FundNodePanel, BitcoinPriceGraph
- All existing migrations (new tables additive)
- Port assignments (3101, 3200, 3109)
- Docker configuration

## 11. Migration Notes

- Migration 029 is purely additive (CREATE TABLE + CREATE INDEX)
- Old member_liquidity_* tables remain — no DROP TABLE
- member_liquidity_advisor_config gets one new column: max_daily_withdrawal_sat (ALTER TABLE ADD COLUMN)
- No data migration needed — new tables start empty

## 12. Files Changed Summary

### New files
- `src/db/migrations/029_swap_subsystem.sql`
- `src/db/migrations/030_advisor_withdrawal_limit.sql`
- `src/swaps/swapService.ts`
- `src/swaps/loopProvider.ts`
- `src/swaps/swapPolicy.ts`
- `src/swaps/swapPoller.ts`
- `src/swaps/swapRoutes.ts`
- `app/web/src/pages/WithdrawBitcoin.tsx`
- `app/web/src/pages/SwapOperations.tsx`

### Modified files
- `src/lightning/loop.ts` — add Loop In methods (getLoopInTerms, getLoopInQuote, executeLoopInSwap)
- `src/memberLiquidity/liquidityDetector.ts` — write to liquidity_actions
- `src/memberLiquidity/liquidityRoutes.ts` — approve creates swap_request
- `src/memberLiquidity/liquidityExecutor.ts` — deprecation comment
- `src/memberAdvisor/loopAvailability.ts` — wire Loop In to real gRPC
- `src/index.ts` — add swap route handlers, start poller
- `src/config/env.ts` — add MEMBER_MAX_WITHDRAWAL_SAT, MEMBER_MIN_WITHDRAWAL_SAT
- `app/web/src/App.tsx` — add routes + nav for /withdraw and /swaps
- `app/web/src/api/client.ts` — add swap API methods + types
