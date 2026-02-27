# Keysend Push Rebalance Design

**Date:** 2026-02-27
**Branch:** `feature/keysend-rebalance` off `develop`
**Approach:** Standalone module (Approach A)

## Problem

The existing circular rebalance system cannot work in this deployment:
- `allow-circular-route=false` in LND config
- Pure hub-and-spoke topology — no external peers to route through

## Solution

Keysend push rebalancing: treasury pushes sats directly to a member node on the existing channel. No invoice, no routing through third parties.

## When Keysend Helps

- **Critical channels (>85% local on treasury side):** Treasury has too much local balance. Keysend pushes sats to the member, restoring treasury's receive capacity.

## When Keysend Does NOT Help

- **Outbound_starved channels (<15% local on treasury side):** Pushing more sats out worsens the problem. Correct fixes: member pays back through channel (natural flow), splice-in (future), or capital rotation (close/reopen).

## Architecture

### New Files
- `src/lightning/rebalance-keysend.ts` — execution logic + auto-select

### Modified Files
- `src/lightning/lnd.ts` — add `keysendPush()` wrapper around `payViaPaymentDetails`
- `src/types/ln-service.d.ts` — add `payViaPaymentDetails` type declaration
- `src/lightning/rebalance-scheduler.ts` — swap circular for keysend in scheduler loop
- `src/index.ts` — add two new treasury-only endpoints
- `src/api/treasury-alerts.ts` — add `KEYSEND_REBALANCE_AVAILABLE` alert
- `CLAUDE.md` — docs + version bump

### Reused Components (no changes)
- `getLiquidityHealth()` — channel health classification
- `assertDailyLossCapNotExceeded()` — fee cap enforcement
- `treasury_rebalance_executions` table — execution lifecycle tracking
- `treasury_rebalance_costs` table — cost recording
- Scheduler cooldown logic

## API Endpoints

### `POST /api/treasury/rebalance/keysend` (treasury-only)
Manual push to a specific channel.

Request: `{ channel_id: string, amount_sats: number, max_fee_sats?: number }`

Response: `KeysendRebalanceResult` with `warning` field if channel is not critical.

Safety: channel must be active, amount <= 50% local balance, daily loss cap checked.

### `POST /api/treasury/rebalance/keysend/auto` (treasury-only)
Auto-push to all critical channels.

Request: none

Response: `{ ok: boolean, results: KeysendRebalanceResult[] }`

Only targets channels with `health_classification === 'critical'`. Pushes enough to bring each back toward 50% local ratio, capped at 100k sats per channel, minimum 10k sats.

## Scheduler Integration

Replace circular rebalance call with keysend auto-rebalance. Keep all existing guards:
- Treasury-only check
- Cooldown enforcement
- Daily loss cap (checked once before any execution)
- Dry-run mode

## Alert

New alert type `KEYSEND_REBALANCE_AVAILABLE` (severity: info) when any active channel is classified as `critical`. Only critical — not outbound_starved.

## Execution & Cost Tracking

Reuses existing tables with `type = 'keysend'`:
- `treasury_rebalance_executions`: lifecycle `requested → submitted → succeeded/failed`
- `treasury_rebalance_costs`: fee record on success (only if fee > 0)

## Safety Bounds

- Never push more than 50% of channel's local balance
- Minimum meaningful push: 10,000 sats
- Maximum single push: 100,000 sats
- Daily loss cap respected
- Scheduler cooldown between runs
