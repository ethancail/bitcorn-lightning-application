# Merchant Channel Lifecycle Architecture

**Status:** CORRECTED SCOPE — channel lifecycle is the FALLBACK for exhausted/rotten merchant channels, not the primary refill path.

**Correction note (2026-04-13):** The original version of this doc argued that merchant-side liquidity should be managed exclusively via channel rotation/replacement, dismissing Loop In. That conclusion was based on two errors:

1. **Direction confusion in Section A below** — described "merchant sends → merchant local increases" which is the wrong way around. Merchant sends → merchant local decreases. This flipped the entire flow model.
2. **Conflation of Treasury Loop In with merchant-side Loop In** — v1.7.1 removed *Treasury* Loop In (treasury running Loop In for its own inbound capacity — correctly removed, since treasury uses Loop Out on external channels for that purpose). It did NOT remove merchant-side Loop In, which is an unrelated flow: the merchant's own loopd (shipped in every node since v1.8.4) converts the merchant's on-chain BTC into local Lightning balance on the merchant↔treasury channel.

**The corrected scope of this document:** channel lifecycle actions (rotate, close+replace, open parallel) are the **fallback** for channels that are:
- Structurally broken (ROI < threshold, never going to recover)
- Fully exhausted with no on-chain funds to Loop In
- Requiring capital reconfiguration (merchant's usage pattern has fundamentally changed)

**The normal merchant refill path is merchant-side Loop In**, which depends on:
- Treasury having inbound liquidity on its external channels (to receive the Loop server's invoice payment)
- Treasury having local balance on the merchant↔treasury channel (automatic after merchant has been spending)

**Supersedes:** Treasury-side Loop In as a *treasury* liquidity mechanism (removed in v1.7.1). Does NOT supersede merchant-side Loop In.

---

## A. Architecture (ORIGINAL — contains the direction confusion)

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

- **Treasury Loop In** — removed from active architecture. Treasury running Loop In for its own inbound doesn't make sense; treasury uses Loop Out on external channels for that.
- **Keysend push** — deprecated. One-way payments, not true rebalancing.

**NOTE (2026-04-13):** This section used to imply Loop In is not part of merchant liquidity at all. That's wrong. *Merchant-side* Loop In — the merchant running Loop In on their own local loopd — IS the primary refill path. See the correction note at the top of this doc. The items above remain true for *treasury-initiated* swap types only.

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

## D. Explicit Architecture Statements (CORRECTED 2026-04-13)

1. **Merchant-side Loop In is the primary refill path**, run by the merchant's own loopd (shipped in every node per v1.8.4). The payment path necessarily traverses treasury (leaf topology), so merchant Loop In success depends on treasury having inbound liquidity on its external channels.

2. **Treasury-initiated Loop In** (as distinct from merchant Loop In) is not part of the active architecture — treasury uses Loop Out on external channels to maintain its own inbound. The `/api/admin/swaps/loop-in` endpoints correctly return 410.

3. **Member Loop Out remains the farmer-lane cash-out path.** Farmers use "Withdraw to Bitcoin Wallet" to move accumulated Lightning balance to on-chain BTC, which also restores their receive capacity.

4. **Channel lifecycle actions are the FALLBACK** for structurally broken channels (low ROI, fully exhausted with no on-chain funds, capital reconfiguration), not the primary refill path.

5. **Treasury Loop Out remains active** for treasury-side liquidity management (restoring inbound capacity on external routing channels like ACINQ). This is a prerequisite for merchant Loop In to succeed.

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
