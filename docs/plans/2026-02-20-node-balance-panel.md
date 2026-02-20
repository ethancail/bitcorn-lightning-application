# Node Balance Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a three-card balance summary (Total Node Balance, Bitcoin Balance, Lightning Wallet) to the top of both the treasury and member dashboards, showing sats + BTC for each.

**Architecture:** New `GET /api/node/balances` endpoint fetches on-chain balance live from LND and sums active channel local balances from SQLite. A shared `<NodeBalancePanel />` React component consumes it and is inserted at the top of both dashboard pages.

**Tech Stack:** Node.js HTTP server (`app/api/src/index.ts`), `ln-service` (`getLndChainBalance`), SQLite (`db`), React 18 + TypeScript, existing `apiFetch` pattern and amber-on-black design system.

---

### Task 1: Add `GET /api/node/balances` endpoint

**Files:**
- Modify: `app/api/src/index.ts` — insert after line 131 (after the `/api/node` handler's closing `return;`)

**Step 1: Insert the handler**

Add the following block at line 133 (between the `/api/node` handler and the `/api/peers` handler):

```ts
if (req.method === "GET" && req.url === "/api/node/balances") {
  try {
    const { chain_balance } = await getLndChainBalance();
    const row = db
      .prepare("SELECT COALESCE(SUM(local_balance_sat), 0) as total FROM lnd_channels WHERE active = 1")
      .get() as { total: number };
    const lightning_sats = row.total;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      onchain_sats: chain_balance,
      lightning_sats,
      total_sats: chain_balance + lightning_sats,
    }));
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "failed_to_fetch_balances" }));
  }
  return;
}
```

Note: `getLndChainBalance` is already imported on line 47. `db` is already imported on line 3.

**Step 2: Verify manually**

Build and start the API, then:
```bash
curl http://localhost:3101/api/node/balances
```
Expected: `{"onchain_sats":N,"lightning_sats":N,"total_sats":N}`

If LND is unreachable, expect a 500 with `failed_to_fetch_balances`.

**Step 3: Commit**

```bash
git add app/api/src/index.ts
git commit -m "feat(api): add GET /api/node/balances endpoint"
```

---

### Task 2: Add `getNodeBalances` to the API client

**Files:**
- Modify: `app/web/src/api/client.ts`

**Step 1: Add the type**

Find the `MemberStats` type (around line 223). Add the new type directly above it:

```ts
export type NodeBalances = {
  onchain_sats: number;
  lightning_sats: number;
  total_sats: number;
};
```

**Step 2: Add the method**

In the `api` object (starting at line 25), add `getNodeBalances` after `getNode`:

```ts
getNodeBalances: () => apiFetch<NodeBalances>("/api/node/balances"),
```

So the top of the `api` object reads:

```ts
export const api = {
  getNode: () => apiFetch<NodeInfo>("/api/node"),
  getNodeBalances: () => apiFetch<NodeBalances>("/api/node/balances"),
  getMemberStats: ...
```

**Step 3: Commit**

```bash
git add app/web/src/api/client.ts
git commit -m "feat(web): add getNodeBalances to API client"
```

---

### Task 3: Create `<NodeBalancePanel />` component

**Files:**
- Create: `app/web/src/components/NodeBalancePanel.tsx`

**Step 1: Create the file**

```tsx
import { useEffect, useState } from "react";
import { api, type NodeBalances } from "../api/client";

function toBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

export default function NodeBalancePanel() {
  const [balances, setBalances] = useState<NodeBalances | null>(null);

  useEffect(() => {
    api.getNodeBalances().then(setBalances).catch(() => {});
    const id = setInterval(() => {
      api.getNodeBalances().then(setBalances).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const cards = [
    { label: "Total Node Balance", sats: balances?.total_sats ?? null },
    { label: "Bitcoin Balance",    sats: balances?.onchain_sats ?? null },
    { label: "Lightning Wallet",   sats: balances?.lightning_sats ?? null },
  ];

  return (
    <div
      className="panel fade-in"
      style={{ marginBottom: 16 }}
    >
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">₿</span>Node Balances
        </span>
      </div>
      <div className="panel-body">
        <div className="dashboard-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          {cards.map(({ label, sats }) => (
            <div key={label} className="stat-card">
              <div className="stat-label">{label}</div>
              {sats === null ? (
                <div className="loading-shimmer" style={{ height: 28, width: "70%", marginBottom: 6 }} />
              ) : (
                <>
                  <div className="stat-value">{sats.toLocaleString()}</div>
                  <div className="stat-sub">{toBtc(sats)} BTC</div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add app/web/src/components/NodeBalancePanel.tsx
git commit -m "feat(web): add NodeBalancePanel component"
```

---

### Task 4: Insert panel into MemberDashboard

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`

**Step 1: Add import**

At the top of the file, after the existing import:

```ts
import { api, type MemberStats } from "../api/client";
```

Add:

```ts
import NodeBalancePanel from "../components/NodeBalancePanel";
```

**Step 2: Insert the component**

In `MemberDashboard`'s return, find the page header `<div style={{ marginBottom: 24 }}>`. Insert `<NodeBalancePanel />` immediately after the closing `</div>` of that header block and before the membership status panel:

```tsx
return (
  <div>
    <div style={{ marginBottom: 24 }}>
      <h1 style={{ marginBottom: 4 }}>My Dashboard</h1>
      <p className="text-dim" style={{ fontSize: "0.875rem" }}>
        Your connection to the Bitcorn Lightning hub
      </p>
    </div>

    <NodeBalancePanel />   {/* ← insert here */}

    {/* Membership status */}
    <div className="panel fade-in" style={{ marginBottom: 16 }}>
```

**Step 3: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx
git commit -m "feat(web): add NodeBalancePanel to MemberDashboard"
```

---

### Task 5: Insert panel into Treasury Dashboard

**Files:**
- Modify: `app/web/src/pages/Dashboard.tsx`

**Step 1: Add import**

At the top of the file, after the existing imports:

```ts
import NodeBalancePanel from "../components/NodeBalancePanel";
```

**Step 2: Insert the component**

In `Dashboard`'s return (around line 682), find the page header `<div style={{ marginBottom: 24 }}>`. Insert `<NodeBalancePanel />` immediately after it, before `<AlertsBar />`:

```tsx
export default function Dashboard() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Treasury Dashboard</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Capital allocation engine · live view
        </p>
      </div>

      <NodeBalancePanel />   {/* ← insert here */}

      <AlertsBar />
```

**Step 3: Commit**

```bash
git add app/web/src/pages/Dashboard.tsx
git commit -m "feat(web): add NodeBalancePanel to Treasury Dashboard"
```

---

### Task 6: Manual verification

**Member dashboard (Playwright mock):**

Update the mock to include `/api/node/balances`:

```js
await page.route('http://localhost:3101/api/node/balances', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    onchain_sats: 2_500_000,
    lightning_sats: 1_450_000,
    total_sats: 3_950_000,
  })
}));
```

Expected: Three stat cards appear above membership status. Values show:
- Total Node Balance: `3,950,000` / `0.03950000 BTC`
- Bitcoin Balance: `2,500,000` / `0.02500000 BTC`
- Lightning Wallet: `1,450,000` / `0.01450000 BTC`

**Treasury dashboard:** Same mock, same panel appears above alerts bar.

**Error state:** Remove the route mock and reload — shimmer placeholders should persist indefinitely (no crash, no empty panel).
