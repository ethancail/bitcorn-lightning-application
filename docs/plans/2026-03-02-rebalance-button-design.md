# Rebalance Button Design

## Goal

Add a one-click "Rebalance" button for critical channels on both the Channels page and the Dynamic Fees Panel on the treasury dashboard. Treasury-only — members never see it.

## Architecture

No new API endpoints or database changes. Uses existing:
- `GET /api/treasury/liquidity-health` — provides `health_classification` and `imbalance_ratio` per channel
- `POST /api/treasury/rebalance/keysend` — executes keysend push with `{ channel_id, amount_sats }`

## Data Flow

### Channels Page
1. Fetch `/api/treasury/liquidity-health` alongside `/api/channels`
2. If health endpoint returns 403 (member node), skip — no rebalance UI appears
3. For treasury: merge health data into channel rows by `channel_id`
4. Show health badge per channel (green/yellow/red/blue/gray)
5. For `critical` channels: show "Rebalance" button

### Dashboard (Dynamic Fees Panel)
1. Panel already has `health_classification` and `imbalance_ratio` per channel
2. Add narrow "Action" column to the table
3. For `critical` rows: show small "Rebalance" button

## Amount Calculation (Client-Side)

Auto-calculated, no user input:
```
excess = local_sats - Math.floor(capacity_sats * 0.5)
amount = Math.min(100_000, Math.max(10_000, excess))
```
Bounded 10k–100k sats per the existing keysend safety bounds.

## Button UX

1. **Idle**: "Rebalance" button (`.btn btn-primary`, small size)
2. **Loading**: spinner replaces button text during API call
3. **Success**: brief inline result — "Pushed X sats" (green text, fades after 3s)
4. **Error**: inline error — e.g. "Failed: peer rejected" (red text)
5. **After success**: re-fetch channels + health to update display

## Health Badge Colors

Same scheme as Dynamic Fees Panel:
- `healthy` → green
- `weak` → yellow
- `outbound_starved` → red
- `inbound_heavy` → blue
- `critical` → muted/gray

## Scope

### Building
- Health badge + rebalance button on ChannelsPage (treasury-only via 403 gate)
- Rebalance button in Dynamic Fees Panel action column
- `getLiquidityHealth()` and `keysendRebalance()` methods in `client.ts`
- `ChannelLiquidityHealth` type in `client.ts`

### Not Building
- No amount input (auto-calculate only)
- No member-side rebalance UI
- No new API endpoints
- No new database changes
