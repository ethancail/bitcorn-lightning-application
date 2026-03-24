# Merchant Channel Lifecycle Architecture

**Status:** Active design — defines how merchant-side liquidity is managed in Bitcorn Lightning.

**Supersedes:** Treasury Loop In as a merchant-side liquidity mechanism (removed in v1.7.1).

---

## A. Architecture

### Roles

| Role | Direction | Behavior |
|------|-----------|----------|
| **Grain merchants** | Mostly senders | Pay farmers through Treasury |
| **Farmers** | Mostly receivers | Receive payments, optionally withdraw via Loop Out |
| **Treasury** | Routing hop | Routes payments merchant → farmer, earns forwarding fees |

### Payment flow

```
Merchant → [merchant channel] → Treasury → [farmer channel] → Farmer
```

Treasury is strictly a **Lightning routing hop** during payment execution. It does not hold member sats custodially. Sats flow through Treasury channels as part of normal Lightning routing.

### Channel types

**Merchant channels = Treasury-funded spend-down lanes**
- Treasury opens/funds these channels with initial local balance on the Treasury side
- This Treasury-local balance becomes the merchant's **inbound capacity** (ability to receive)
- When the merchant sends payments, their local balance increases and Treasury's decreases
- The merchant's send capacity gradually depletes as Treasury-side balance is consumed by forwarded payments
- When the channel is exhausted (Treasury has little local balance left to forward), the channel needs lifecycle action

**Farmer channels = receive lanes**
- Farmers receive payments, accumulating local balance
- Farmers can use **member Loop Out** ("Withdraw to Bitcoin Wallet") to:
  - Move accumulated Lightning sats to on-chain BTC they control
  - Shift balance back toward Treasury on the farmer↔Treasury channel
  - Restore their ability to receive more payments
- This keeps farmers self-custodial and the channel reusable

### What is NOT used for merchant-side liquidity

- **Treasury Loop In** — removed from active architecture. Loop In converts on-chain BTC to inbound capacity, but merchant channels don't need the Treasury to Loop In; they need fresh Treasury-funded channels.
- **Keysend push** — deprecated. One-way payments, not true rebalancing.

---

## B. Merchant Channel Lifecycle

### States

| State | Condition | Description |
|-------|-----------|-------------|
| `healthy` | Treasury local ≥ 40% of capacity | Channel has ample forwarding capacity |
| `warning` | Treasury local 20–40% | Capacity trending low, monitor closely |
| `exhausted_soon` | Treasury local 10–20% | Will exhaust within current velocity; plan action |
| `exhausted` | Treasury local < 10% | Cannot reliably forward merchant payments |
| `rotation_recommended` | Exhausted + ROI < threshold | Close and replace with fresh channel |
| `close_replace_recommended` | Exhausted + structural issue | Channel has operational problems beyond balance |

### Actions

| Action | When | Description |
|--------|------|-------------|
| `wait` | healthy / warning | No action needed, continue monitoring |
| `open_parallel_channel` | exhausted_soon, merchant still active | Open an additional channel to the merchant to extend capacity |
| `rotate_channel` | rotation_recommended | Close depleted channel, open fresh one with full Treasury funding |
| `close_and_replace_channel` | close_replace_recommended | Force close if needed, replace with new channel |
| `manual_review` | edge cases | Operator reviews unusual situation |

### Lifecycle flow

```
Treasury opens channel (fully funded on Treasury side)
  → merchant sends payments over time
    → Treasury local balance decreases
      → healthy → warning → exhausted_soon → exhausted
        → open_parallel_channel (extend capacity)
        OR → rotate_channel (close + reopen with fresh funding)
        OR → close_and_replace_channel (structural issues)
```

---

## C. Policy Signals for Merchant Lanes

### Primary metrics

| Signal | Source | Description |
|--------|--------|-------------|
| Treasury local balance | `lnd_channels.local_balance_sat` | How much forwarding capacity remains |
| Treasury local % | `local_balance_sat / capacity_sat` | Utilization ratio |
| Merchant remote balance | `lnd_channels.remote_balance_sat` | How much the merchant has accumulated |
| Send velocity | `payments_forwarded` (24h/7d) | How fast the merchant is spending |
| Projected exhaustion | `local_balance / daily_outflow` | Estimated days until channel is depleted |
| Channel age | `lnd_channel_history.opened_at` | How long the channel has been open |
| ROI | `treasury_channel_metrics.roi_ppm` | Whether the channel is earning its keep |

### Policy thresholds (suggested defaults)

```
healthy_threshold_pct = 0.40      -- Treasury local >= 40%
warning_threshold_pct = 0.20      -- Treasury local 20-40%
exhausted_soon_pct = 0.10         -- Treasury local 10-20%
exhausted_pct = 0.05              -- Treasury local < 5% (practically unusable)
min_channel_age_for_rotation = 7d -- Don't rotate brand-new channels
rotation_cooldown = 24h           -- Minimum time between rotation actions per peer
```

### On-chain fee sensitivity

Before opening new channels or rotating:
- Check current on-chain fee environment
- Prefer action during low-fee windows
- If fees are elevated, prefer `wait` unless channel is fully exhausted

---

## D. Explicit Architecture Statements

1. **Merchant-side liquidity management is NOT modeled as Treasury Loop In.** Treasury Loop In converts on-chain sats to inbound capacity, which doesn't solve merchant channel exhaustion. The correct approach is channel lifecycle management: open fresh channels with Treasury funding.

2. **Treasury Loop In is not part of the active merchant-lane strategy.** The Loop In gRPC functions are retained as inactive low-level support but are not exposed via API routes, UI, or policy recommendations.

3. **Member Loop Out remains part of the farmer-lane strategy.** Farmers use "Withdraw to Bitcoin Wallet" to move accumulated Lightning balance to on-chain BTC, which also restores their receive capacity on the farmer↔Treasury channel.

4. **Treasury Loop Out remains active** for treasury-side liquidity management (restoring inbound capacity on external routing channels like ACINQ).

---

## E. Future Implementation Hooks

These are natural insertion points for the merchant channel lifecycle system. Do not overbuild now — document for later implementation.

### Merchant channel lifecycle advisor
- **Where:** New `src/merchantAdvisor/` directory (parallel to `src/memberAdvisor/`)
- **What:** Scheduled job (15-min interval, treasury-only) that classifies each merchant channel by state, generates recommended actions
- **Data:** Reads from `lnd_channels`, `payments_forwarded`, `rebalance_clusters`, `lnd_channel_history`
- **Output:** Writes to a new `merchant_channel_classifications` table

### Admin recommendations panel
- **Where:** Treasury dashboard or dedicated "Merchant Channels" page
- **What:** Shows merchant channels sorted by urgency, with recommended actions
- **Pattern:** Similar to existing `MemberLiquidity.tsx` approve/reject flow

### Scheduled exhaustion warnings
- **Where:** `treasury-alerts.ts` — add new alert types
- **Types:** `MERCHANT_CHANNEL_WARNING`, `MERCHANT_CHANNEL_EXHAUSTED`, `MERCHANT_ROTATION_RECOMMENDED`
- **Trigger:** Merchant channel lifecycle advisor detects non-healthy state

### Open-parallel-vs-replace decision logic
- **Where:** Inside the lifecycle advisor
- **Inputs:** Channel age, ROI, on-chain fee environment, merchant activity level
- **Logic:**
  - If channel is young + low ROI + exhausted → close_and_replace (bad channel, don't pour more capital)
  - If channel is mature + good ROI + exhausted → open_parallel (proven peer, extend capacity)
  - If channel is mature + negative ROI + exhausted → rotation (sunset the relationship)

### Migration for merchant classifications
- **Where:** New migration (~032)
- **Table:** `merchant_channel_classifications` (similar structure to `member_channel_classifications`)
- **Columns:** channel_id, peer_pubkey, state, urgency, treasury_local_pct, projected_exhaustion_days, recommended_action, classified_at
