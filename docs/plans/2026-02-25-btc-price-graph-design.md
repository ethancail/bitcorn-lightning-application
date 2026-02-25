# Bitcoin Price Graph — Design

**Date:** 2026-02-25
**Feature:** Real-time BTC/USD price graph on both dashboards

## Summary

Add a `BitcoinPriceGraph` component that displays BTC/USD spot price and historic price chart using the Coinbase public API. Appears on both treasury and member dashboards, above all other panels (below FundNodePanel).

## Data Source

Coinbase public price API (no auth required):

- **Spot:** `GET https://api.coinbase.com/v2/prices/BTC-USD/spot`
  → `{ data: { amount: "67332.665", base: "BTC", currency: "USD" } }`

- **Historic:** `GET https://api.coinbase.com/v2/prices/BTC-USD/historic?period={day|week|month|year}`
  → `{ data: { prices: [{ price: "67596.265", time: "1772034300" }] } }`

Period mapping: 24h → day, 7d → week, 30d → month, 1y → year.

## Component

**File:** `app/web/src/components/BitcoinPriceGraph.tsx`

### Layout (top to bottom inside `.panel`)

1. **Panel header:** "Bitcoin Price" title + time range selector (24h / 7d / 30d / 1y buttons)
2. **Spot price:** Large `$XX,XXX.XX` + change amount and percentage (green positive, red negative)
3. **Recharts AreaChart:** Amber line + amber gradient fill, monospace axis labels, custom tooltip

### Styling

- Graph line: `var(--amber)` (#f59e0b)
- Fill gradient: `rgba(245,158,11,0.15)` → transparent
- Positive change: `var(--green)`, negative: `var(--red)`
- Axes/grid: `var(--border)` / `var(--text-3)`, monospace font
- Time range buttons: `btn-outline` / `btn-primary` toggle

### States

- **Loading:** Shimmer placeholder
- **Error:** "Price data unavailable" — never breaks parent dashboard
- **Auto-refresh:** Every 60 seconds

### Price Change Calculation

`changeAmount = spotPrice - oldestHistoricPrice`
`changePercent = (changeAmount / oldestHistoricPrice) * 100`

## Dependencies

- Add `recharts` to `app/web/package.json`

## Placement

- `Dashboard.tsx`: below `FundNodePanel`, above `AlertsBar`
- `MemberDashboard.tsx`: below `FundNodePanel`, above membership status panel

## Version

Bump `umbrel-app.yml` from 1.0.6 → 1.1.0 (new user-facing feature).

## Branch

All work on `feature/btc-price-graph`, branched from `develop`.
