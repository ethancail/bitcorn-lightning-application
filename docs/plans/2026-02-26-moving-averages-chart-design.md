# Moving Averages Chart Design

## Overview
Add a Bitcoin Moving Averages chart below the commodity price ticker strip on the Charts page. Shows daily BTC price with 50-day, 100-day, and 200-day moving average overlays. Period selector: 1M, 1Y, 5Y, 10Y.

## Data Source
Reuses existing `power-law-data.json` (~10,000 daily BTC prices from 2015-01-01). Gap days through today filled with live Coinbase spot price (same pattern as PowerLawChart). MAs computed client-side — no new API calls.

## Chart Specification
- **BTC Price**: Amber (#f59e0b), solid, 2px
- **50-day MA**: Cyan (#06b6d4), solid, 1.5px
- **100-day MA**: Purple (#a78bfa), solid, 1.5px
- **200-day MA**: Green (#22c55e), solid, 1.5px
- **Y-axis**: Linear scale, USD formatted
- **X-axis**: Date, boundary-aligned ticks (monthly for 1M, yearly for others)
- **Tooltip**: Date + BTC price + all three MA values

## Files
1. **New**: `app/web/src/components/MovingAveragesChart.tsx`
2. **Modify**: `app/web/src/pages/Charts.tsx` — add panel below PriceTickerStrip
3. **Modify**: `app/web/src/styles.css` — minor additions if needed
