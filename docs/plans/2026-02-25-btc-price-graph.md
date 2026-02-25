# Bitcoin Price Graph — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a real-time BTC/USD price graph to both treasury and member dashboards using the Coinbase public price API and recharts.

**Architecture:** Single React component (`BitcoinPriceGraph.tsx`) fetches Coinbase spot + historic prices directly from the browser (public API, no auth). Uses recharts `AreaChart` with amber-on-black terminal styling. Auto-refreshes every 60s. Each dashboard renders the component independently.

**Tech Stack:** React 18, TypeScript, recharts, Coinbase public price API

**Note:** This project has no automated test suite. Manual testing checklist is provided at the end.

---

### Task 1: Branch Setup

**Step 1: Create and push the develop branch from main**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git checkout main
git pull origin main
git checkout -b develop
git push origin develop
```

**Step 2: Create and push the feature branch from develop**

```bash
git checkout -b feature/btc-price-graph
git push origin feature/btc-price-graph
```

Expected: You are now on `feature/btc-price-graph`, branched from `develop`.

---

### Task 2: Install recharts

**Files:**
- Modify: `app/web/package.json`

**Step 1: Install recharts**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web
npm install recharts
```

Expected: `recharts` appears in `dependencies` in `app/web/package.json`. The `package-lock.json` is updated.

**Step 2: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/package.json app/web/package-lock.json
git commit -m "feat(web): add recharts dependency for price graph"
```

---

### Task 3: Create BitcoinPriceGraph component

**Files:**
- Create: `app/web/src/components/BitcoinPriceGraph.tsx`

This is the core of the feature. The component:
1. Fetches spot price and historic prices from Coinbase public API
2. Renders a large spot price, change amount/percentage, and an AreaChart
3. Has a 4-button time range selector (24h / 7d / 30d / 1y)
4. Auto-refreshes every 60 seconds
5. Shows loading shimmer and error state gracefully

**Step 1: Create the component file**

Create `app/web/src/components/BitcoinPriceGraph.tsx` with this content:

```tsx
import { useState, useEffect, useCallback } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ─── Types ───────────────────────────────────────────────────────────────

type Period = "24h" | "7d" | "30d" | "1y";

type PricePoint = {
  time: number;     // Unix seconds
  price: number;    // USD
  label: string;    // Formatted time label for X axis
};

type CoinbaseHistoricResponse = {
  data: {
    prices: Array<{ price: string; time: string }>;
  };
};

type CoinbaseSpotResponse = {
  data: { amount: string; base: string; currency: string };
};

// ─── Constants ───────────────────────────────────────────────────────────

const COINBASE_BASE = "https://api.coinbase.com/v2/prices/BTC-USD";

const PERIOD_MAP: Record<Period, string> = {
  "24h": "day",
  "7d": "week",
  "30d": "month",
  "1y": "year",
};

const PERIODS: Period[] = ["24h", "7d", "30d", "1y"];

const REFRESH_MS = 60_000;

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatAxisPrice(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function formatTimeLabel(unixSeconds: number, period: Period): string {
  const d = new Date(unixSeconds * 1000);
  switch (period) {
    case "24h":
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    case "7d":
      return d.toLocaleDateString("en-US", { weekday: "short" });
    case "30d":
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "1y":
      return d.toLocaleDateString("en-US", { month: "short" });
  }
}

function formatTooltipTime(unixSeconds: number, period: Period): string {
  const d = new Date(unixSeconds * 1000);
  if (period === "24h") {
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: period === "1y" ? "numeric" : undefined,
  });
}

// ─── Data Fetching ───────────────────────────────────────────────────────

async function fetchSpotPrice(): Promise<number> {
  const res = await fetch(`${COINBASE_BASE}/spot`);
  if (!res.ok) throw new Error("Spot price fetch failed");
  const json: CoinbaseSpotResponse = await res.json();
  return parseFloat(json.data.amount);
}

async function fetchHistoricPrices(period: Period): Promise<PricePoint[]> {
  const res = await fetch(`${COINBASE_BASE}/historic?period=${PERIOD_MAP[period]}`);
  if (!res.ok) throw new Error("Historic prices fetch failed");
  const json: CoinbaseHistoricResponse = await res.json();
  return json.data.prices
    .map((p) => ({
      time: parseInt(p.time, 10),
      price: parseFloat(p.price),
      label: formatTimeLabel(parseInt(p.time, 10), period),
    }))
    .sort((a, b) => a.time - b.time);
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────

function PriceTooltip({
  active,
  payload,
  period,
}: {
  active?: boolean;
  payload?: Array<{ payload: PricePoint }>;
  period: Period;
}) {
  if (!active || !payload?.length) return null;
  const pt = payload[0].payload;
  return (
    <div
      style={{
        background: "#17171e",
        border: "1px solid #2a2a38",
        borderRadius: 6,
        padding: "8px 12px",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: "0.75rem",
      }}
    >
      <div style={{ color: "#e8e8f0", fontWeight: 600 }}>{formatUsd(pt.price)}</div>
      <div style={{ color: "#5a5a70", marginTop: 2 }}>{formatTooltipTime(pt.time, period)}</div>
    </div>
  );
}

// ─── Tick Sampling ───────────────────────────────────────────────────────

function sampleTicks(data: PricePoint[], maxTicks: number): number[] {
  if (data.length <= maxTicks) return data.map((d) => d.time);
  const step = Math.ceil(data.length / maxTicks);
  const ticks: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    ticks.push(data[i].time);
  }
  return ticks;
}

// ─── Component ───────────────────────────────────────────────────────────

export default function BitcoinPriceGraph() {
  const [period, setPeriod] = useState<Period>("24h");
  const [spot, setSpot] = useState<number | null>(null);
  const [data, setData] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [spotPrice, historic] = await Promise.all([
        fetchSpotPrice(),
        fetchHistoricPrices(period),
      ]);
      setSpot(spotPrice);
      setData(historic);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [period]);

  // Fetch on mount, on period change, and auto-refresh every 60s
  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  // ── Price change calculation ──
  const oldest = data.length > 0 ? data[0].price : null;
  const changeAmt = spot != null && oldest != null ? spot - oldest : null;
  const changePct = changeAmt != null && oldest != null && oldest !== 0
    ? (changeAmt / oldest) * 100
    : null;
  const isPositive = changeAmt != null && changeAmt >= 0;

  // ── Y axis domain with 2% padding ──
  const prices = data.map((d) => d.price);
  const yMin = prices.length ? Math.min(...prices) : 0;
  const yMax = prices.length ? Math.max(...prices) : 0;
  const yPad = (yMax - yMin) * 0.02 || 100;

  const xTicks = sampleTicks(data, 6);

  return (
    <div className="panel fade-in" style={{ marginBottom: 16 }}>
      {/* Header */}
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">₿</span>Bitcoin Price
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {PERIODS.map((p) => (
            <button
              key={p}
              className={`btn btn-sm ${p === period ? "btn-primary" : "btn-outline"}`}
              onClick={() => setPeriod(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="panel-body">
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="loading-shimmer" style={{ height: 40, width: "50%" }} />
            <div className="loading-shimmer" style={{ height: 20, width: "30%" }} />
            <div className="loading-shimmer" style={{ height: 200 }} />
          </div>
        ) : error ? (
          <div className="error-state">Price data unavailable</div>
        ) : (
          <>
            {/* Spot price + change */}
            <div style={{ marginBottom: 20 }}>
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: "2rem",
                  fontWeight: 600,
                  color: "#e8e8f0",
                  lineHeight: 1.2,
                }}
              >
                {spot != null ? formatUsd(spot) : "—"}
              </div>
              {changeAmt != null && changePct != null && (
                <div
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: "0.875rem",
                    fontWeight: 500,
                    color: isPositive ? "#22c55e" : "#ef4444",
                    marginTop: 4,
                  }}
                >
                  {isPositive ? "+" : ""}
                  {formatUsd(changeAmt)}{" "}
                  ({isPositive ? "+" : ""}
                  {changePct.toFixed(2)}%)
                  <span style={{ color: "#5a5a70", fontWeight: 400, marginLeft: 8 }}>
                    {period}
                  </span>
                </div>
              )}
            </div>

            {/* Chart */}
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="amberFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="time"
                  ticks={xTicks}
                  tickFormatter={(t: number) => formatTimeLabel(t, period)}
                  axisLine={{ stroke: "#2a2a38" }}
                  tickLine={false}
                  tick={{
                    fill: "#5a5a70",
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: 11,
                  }}
                />
                <YAxis
                  domain={[yMin - yPad, yMax + yPad]}
                  tickFormatter={formatAxisPrice}
                  axisLine={false}
                  tickLine={false}
                  tick={{
                    fill: "#5a5a70",
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: 11,
                  }}
                  width={54}
                />
                <Tooltip
                  content={<PriceTooltip period={period} />}
                  cursor={{ stroke: "#3a3a50", strokeDasharray: "4 4" }}
                />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  fill="url(#amberFill)"
                  dot={false}
                  activeDot={{
                    r: 4,
                    fill: "#f59e0b",
                    stroke: "#0a0a0c",
                    strokeWidth: 2,
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </div>
  );
}
```

**Key design decisions in this code:**

- **Direct Coinbase fetch from browser** — no backend proxy needed, Coinbase API is public and has CORS headers
- **Hardcoded color values** match `styles.css` CSS variables exactly (can't use `var()` in SVG attributes rendered by recharts)
- **`sampleTicks`** — prevents X axis overcrowding by picking ~6 evenly spaced labels
- **Y axis padding** — 2% above/below the price range so the line doesn't touch edges
- **Tooltip** — custom styled to match the terminal aesthetic
- **Period change** — triggers loading state and fresh fetch; interval resets

**Step 2: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/components/BitcoinPriceGraph.tsx
git commit -m "feat(web): add BitcoinPriceGraph component with recharts"
```

---

### Task 4: Add to Treasury Dashboard

**Files:**
- Modify: `app/web/src/pages/Dashboard.tsx`

**Step 1: Add import at top of file (after existing imports, around line 14)**

Add this line after the `FundNodePanel` import:

```tsx
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
```

**Step 2: Add component in the render (line ~694)**

In the `Dashboard` component's return, insert `<BitcoinPriceGraph />` after `<FundNodePanel />` and before `<AlertsBar />`:

```tsx
<NodeBalancePanel />
<FundNodePanel />
<BitcoinPriceGraph />
<AlertsBar />
```

**Step 3: Commit**

```bash
git add app/web/src/pages/Dashboard.tsx
git commit -m "feat(web): add Bitcoin price graph to treasury dashboard"
```

---

### Task 5: Add to Member Dashboard

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`

**Step 1: Add import (after existing imports, around line 4)**

Add after the `FundNodePanel` import:

```tsx
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
```

**Step 2: Add component in the render (line ~283)**

In `MemberDashboard`'s return, insert `<BitcoinPriceGraph />` after `<FundNodePanel />` and before the membership status panel:

```tsx
<NodeBalancePanel />
<FundNodePanel />
<BitcoinPriceGraph />

{/* Membership status */}
```

**Step 3: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx
git commit -m "feat(web): add Bitcoin price graph to member dashboard"
```

---

### Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add to the Key Frontend Files table**

In the "Key frontend files" table (around line 183 area), add a row after the `FundNodePanel` entry:

```
| `app/web/src/components/BitcoinPriceGraph.tsx` | BTC/USD price graph — recharts AreaChart, Coinbase public API, 60s auto-refresh |
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add BitcoinPriceGraph to CLAUDE.md frontend files table"
```

---

### Task 7: Version Bump

**Files:**
- Modify: `bitcorn-lightning-node/umbrel-app.yml`

**Step 1: Update version from 1.0.6 to 1.1.0 (line 8)**

Change:
```yaml
version: "1.0.6"
```
To:
```yaml
version: "1.1.0"
```

**Step 2: Update releaseNotes (line 29)**

Replace the existing `releaseNotes` with:

```yaml
releaseNotes: >
  Bitcoin price graph with 24h/7d/30d/1y views and auto-refresh, displayed
  on both treasury and member dashboards. Powered by Coinbase public API.
```

**Step 3: Commit**

```bash
git add bitcorn-lightning-node/umbrel-app.yml
git commit -m "chore: bump version to 1.1.0 for BTC price graph feature"
```

---

### Task 8: Manual Testing Checklist

Before merging `feature/btc-price-graph` into `develop`, verify all of the following:

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web
npm run dev
```

Open browser to the dev server URL. Check:

1. **Treasury dashboard** — graph renders below FundNodePanel, above AlertsBar
2. **Member dashboard** — graph renders below FundNodePanel, above membership status
3. **Spot price** — shows current BTC price in large text
4. **Time range selector** — clicking 24h / 7d / 30d / 1y switches the chart data and shows loading shimmer during fetch
5. **Price change** — shows green with `+` when positive, red when negative; percentage and dollar amount shown
6. **Auto-refresh** — wait 60s, confirm chart updates (check network tab for new Coinbase requests)
7. **No console errors** — open DevTools console, confirm no errors
8. **Error state** — temporarily change `COINBASE_BASE` to a bad URL, confirm "Price data unavailable" shows without breaking other panels
9. **Other panels** — NodeBalancePanel, FundNodePanel, and all other dashboard panels still work normally

Take screenshots of both dashboards and report back before merging.

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Branch setup | — |
| 2 | Install recharts | `app/web/package.json` |
| 3 | Create BitcoinPriceGraph component | `app/web/src/components/BitcoinPriceGraph.tsx` |
| 4 | Add to treasury dashboard | `app/web/src/pages/Dashboard.tsx` |
| 5 | Add to member dashboard | `app/web/src/pages/MemberDashboard.tsx` |
| 6 | Update CLAUDE.md | `CLAUDE.md` |
| 7 | Version bump to 1.1.0 | `bitcorn-lightning-node/umbrel-app.yml` |
| 8 | Manual testing | — |
