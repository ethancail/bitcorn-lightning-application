# Treasury Dashboard UX Redesign

**Goal:** Reorganize the treasury dashboard into an operator cockpit — alerts and KPIs first, detailed work surfaces in the middle, BTC price graph at the bottom.

**Approach:** Inline enrichment (Approach A) — all new components live in Dashboard.tsx, shared data hoisted to parent.

## New Panel Order

1. Page header
2. AlertsBar (full detail, 60s polling)
3. KPI Strip (6 cards: Net 24h, Fwd Fees 24h, Reb Costs 24h, Capital Deployed, At Risk, Pending Fee Changes)
4. Action Summary (counts only — critical/warning alerts, negative ROI, rotation candidates, fee updates)
5. Liquidity Posture (channel health distribution: outbound_starved / weak / healthy / inbound_heavy / critical)
6. NodeBalancePanel + FundNodePanel (secondary utility, grouped)
7. Dashboard grid (NetYield, PeerScores, ChannelROI span-2, Rotation, DynamicFees span-2)
8. BitcoinPriceGraph (bottom)

## Data Flow

Dashboard hoists 8 API calls via `Promise.allSettled` on mount:
- `getTreasuryMetrics` → KPI strip + NetYieldPanel
- `getAlerts` → AlertsBar + Action Summary (60s poll for alerts)
- `getChannelMetrics` → ChannelRoiTable + Action Summary (negative ROI count)
- `getRotationCandidates` → RotationPanel + KPI strip + Action Summary
- `getDynamicFeePreview` → DynamicFeesPanel + KPI strip + Action Summary
- `getLiquidityHealth` → LiquidityPosture
- `getFeePolicy` → DynamicFeesPanel
- `getContacts` → all panels with peer names

PeerScoresPanel keeps its own fetch (only consumer of that data).

## Derived KPIs

| KPI | Source |
|-----|--------|
| Net 24h | `metrics.last_24h.net_sats` |
| Fwd Fees 24h | `metrics.last_24h.forwarded_fees_sats` |
| Reb Costs 24h | `metrics.last_24h.rebalance_costs_sats` |
| Capital Deployed | `metrics.capital_efficiency.capital_deployed_sats` |
| At Risk | `rotationCandidates.length` |
| Pending Fee Changes | `feeAdjustments.filter(a => a.target_fee_rate_ppm !== a.base_fee_rate_ppm).length` |

## Key Changes

- **Rotation preview**: Structured summary (peer, capital released, capacity, ROI, reason, force close) with collapsible raw JSON fallback
- **Freshness hints**: Panel headers show `updatedAt` timestamp for operational panels
- **Error handling**: NodeBalancePanel shows error after 3 failed fetches instead of infinite shimmer; all treasury panels show inline error state
- **No new backend endpoints**: All data derived from existing API responses
- **No new ports or architectural changes**

## Files Changed

- `app/web/src/pages/Dashboard.tsx` — complete rewrite (layout + 5 new inline components + data hoisting)
- `app/web/src/styles.css` — ~160 lines for KPI strip, liquidity posture, action summary, freshness hints, rotation preview
- `app/web/src/components/NodeBalancePanel.tsx` — error state after 3 consecutive failures
