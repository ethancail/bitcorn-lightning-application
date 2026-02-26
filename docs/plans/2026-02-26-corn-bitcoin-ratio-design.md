# Corn-Bitcoin Ratio Chart Design

## Overview
Add a Corn-Bitcoin ratio chart below the Moving Averages chart on the Charts page. Shows bushels of corn needed to buy 1 BTC over time. Formula: `BTC_price / corn_price_per_bushel`. Period selector: 1M, 1Y, 5Y, 10Y.

## Data Source
- Historical corn prices from USDA NASS via new Cloudflare Worker endpoint `GET /prices/corn-history`
- Monthly PRICE RECEIVED data from 2015 onward, cached 24h in KV
- BTC prices from existing `power-law-data.json` + live Coinbase spot
- Corn monthly prices interpolated to daily, ratio computed client-side

## Chart Specification
- **Single line**: Amber (#f59e0b), solid, 2px — bushels/BTC ratio
- **Y-axis**: Linear scale, formatted as bushels (e.g. "15.8k bu")
- **X-axis**: Date, boundary-aligned ticks
- **Tooltip**: Date, BTC price, corn price/bu, ratio in bushels

## Files
1. **Modify**: `cloudflare-worker/src/index.ts` — add `GET /prices/corn-history`
2. **New**: `app/web/src/components/CornBitcoinChart.tsx`
3. **Modify**: `app/web/src/pages/Charts.tsx` — add panel below MA chart
4. **Modify**: `app/web/src/api/client.ts` — add type + method
5. **Modify**: `app/api/src/index.ts` — add `/api/corn-history` proxy
