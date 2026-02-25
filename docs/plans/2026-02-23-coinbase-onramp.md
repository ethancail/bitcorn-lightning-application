# Coinbase Onramp Integration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a URL-based Coinbase Onramp flow so node operators can fund their on-chain wallet directly from either dashboard by clicking a single button.

**Architecture:** A new `GET /api/coinbase/onramp-url` endpoint generates a fresh native-segwit on-chain address via LND (`createChainAddress`), logs the session to a new SQLite table, and returns a pre-built Coinbase Onramp URL. The frontend `FundNodePanel` component calls this endpoint and opens the URL in a new tab. No OAuth, no redirects, no webhooks — pure URL-based flow.

**Tech Stack:** Node.js HTTP server (`app/api/src/index.ts`), `ln-service` (`createChainAddress`), `better-sqlite3`, React 18 + TypeScript, existing `apiFetch` pattern and amber-on-black design system.

---

### Task 1: Add `createChainAddress` to LND wrapper

**Files:**
- Modify: `app/api/src/types/ln-service.d.ts` — add type declaration
- Modify: `app/api/src/lightning/lnd.ts` — import and export wrapper function

**Step 1: Add the type declaration**

In `app/api/src/types/ln-service.d.ts`, find the closing `}` of the module declaration (last line of the file). Add these lines directly before it:

```ts
  export function createChainAddress(options: {
    lnd: any;
    format: 'p2wpkh' | 'p2sh' | 'p2pkh';
    is_unused?: boolean;
  }): Promise<{ address: string }>;
```

**Step 2: Add the wrapper to lnd.ts**

In `app/api/src/lightning/lnd.ts`, update the import on line 3:

```ts
import {
  authenticatedLndGrpc,
  getWalletInfo,
  getIdentity,
  getPeers,
  getChannels,
  getInvoices,
  getForwards,
  getChainBalance,
  addPeer,
  openChannel,
  closeChannel,
  getPendingChannels,
  createInvoice,
  getRouteToDestination,
  payViaRoutes,
  createChainAddress,
} from "ln-service";
```

Then add this function at the end of the file (after `openTreasuryChannel`):

```ts
/**
 * Generates a fresh native-segwit (bech32) on-chain receiving address.
 * Each Coinbase Onramp session should use a new address.
 */
export async function createLndChainAddress(): Promise<{ address: string }> {
  const { lnd } = getLndClient();
  return createChainAddress({ lnd, format: "p2wpkh" });
}
```

**Step 3: Verify it compiles**

```bash
cd app/api && npm run build 2>&1 | tail -20
```

Expected: No TypeScript errors. If `createChainAddress` is flagged as unknown, double-check the type declaration was added inside the `declare module "ln-service"` block.

**Step 4: Commit**

```bash
git add app/api/src/types/ln-service.d.ts app/api/src/lightning/lnd.ts
git commit -m "feat(api): add createLndChainAddress wrapper for on-chain address generation"
```

---

### Task 2: Add `COINBASE_APP_ID` env var

**Files:**
- Modify: `app/api/src/config/env.ts`

**Step 1: Add the field**

In `app/api/src/config/env.ts`, add this entry at the end of the `ENV` object, directly before the closing `};`:

```ts
    // --- Coinbase Onramp ---
    // Required to build Onramp URLs. Get from Coinbase Developer Platform.
    // If unset, GET /api/coinbase/onramp-url returns 503.
    coinbaseAppId: process.env.COINBASE_APP_ID || "",
```

**Step 2: Commit**

```bash
git add app/api/src/config/env.ts
git commit -m "feat(api): add COINBASE_APP_ID env var"
```

---

### Task 3: Create migration 019

**Files:**
- Create: `app/api/src/db/migrations/019_coinbase_onramp_sessions.sql`

**Step 1: Create the file**

```sql
CREATE TABLE IF NOT EXISTS coinbase_onramp_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_pubkey TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Note: The migration runner in `app/api/src/db/migrate.ts` picks up all `.sql` files from the `dist/db/migrations/` directory in alphabetical order. Naming it `019_` ensures it runs after `018_add_loss_cap.sql`. Migrations are idempotent — `CREATE TABLE IF NOT EXISTS` is safe to re-run.

**Step 2: Commit**

```bash
git add app/api/src/db/migrations/019_coinbase_onramp_sessions.sql
git commit -m "feat(db): migration 019 — coinbase_onramp_sessions table"
```

---

### Task 4: Add `GET /api/coinbase/onramp-url` endpoint

**Files:**
- Modify: `app/api/src/index.ts`

**Step 1: Add import**

On line 47, find:

```ts
import { getLndChainBalance, getLndPeers, getLndChannels, openTreasuryChannel, closeTreasuryChannel, connectToPeer } from "./lightning/lnd";
```

Replace with:

```ts
import { getLndChainBalance, getLndPeers, getLndChannels, openTreasuryChannel, closeTreasuryChannel, connectToPeer, createLndChainAddress } from "./lightning/lnd";
```

**Step 2: Insert the handler**

After line 152 (the `return;` that closes the `/api/node/balances` block), insert this block:

```ts
  if (req.method === "GET" && req.url === "/api/coinbase/onramp-url") {
    try {
      if (!ENV.coinbaseAppId) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "coinbase_not_configured" }));
        return;
      }
      const { address } = await createLndChainAddress();
      const node = getNodeInfo();
      db.prepare(
        "INSERT INTO coinbase_onramp_sessions (node_pubkey, wallet_address, created_at) VALUES (?, ?, ?)"
      ).run(node?.pubkey ?? "", address, Date.now());
      const destinationWallets = JSON.stringify([
        { address, assets: ["BTC"], network: "bitcoin" },
      ]);
      const url =
        `https://pay.coinbase.com/buy/select-asset` +
        `?appId=${ENV.coinbaseAppId}` +
        `&destinationWallets=${encodeURIComponent(destinationWallets)}` +
        `&defaultAsset=BTC` +
        `&defaultNetwork=bitcoin` +
        `&fiatCurrency=USD`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url, wallet_address: address }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "failed_to_generate_onramp_url" }));
    }
    return;
  }
```

**Step 3: Verify it compiles**

```bash
cd app/api && npm run build 2>&1 | tail -20
```

Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add app/api/src/index.ts
git commit -m "feat(api): add GET /api/coinbase/onramp-url endpoint"
```

---

### Task 5: Add API client type and method

**Files:**
- Modify: `app/web/src/api/client.ts`

**Step 1: Add the type**

Find the `NodeBalances` type (around line 224). Add the new type directly after it:

```ts
export type OnrampUrlResponse = {
  url: string;
  wallet_address: string;
};
```

**Step 2: Add the method**

In the `api` object (around line 25–28), add `getCoinbaseOnrampUrl` after `getNodeBalances`:

```ts
  getCoinbaseOnrampUrl: () => apiFetch<OnrampUrlResponse>("/api/coinbase/onramp-url"),
```

So the top of the `api` object reads:

```ts
export const api = {
  getNode: () => apiFetch<NodeInfo>("/api/node"),
  getNodeBalances: () => apiFetch<NodeBalances>("/api/node/balances"),
  getCoinbaseOnrampUrl: () => apiFetch<OnrampUrlResponse>("/api/coinbase/onramp-url"),
  getMemberStats: ...
```

**Step 3: Commit**

```bash
git add app/web/src/api/client.ts
git commit -m "feat(web): add getCoinbaseOnrampUrl to API client"
```

---

### Task 6: Create `FundNodePanel` component

**Files:**
- Create: `app/web/src/components/FundNodePanel.tsx`

**Step 1: Create the file**

```tsx
import { useEffect, useState } from "react";
import { api, type NodeBalances } from "../api/client";

export default function FundNodePanel() {
  const [balances, setBalances] = useState<NodeBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getNodeBalances().then(setBalances).catch(() => {});
  }, []);

  async function handleFund() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await api.getCoinbaseOnrampUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setError(e.message ?? "Failed to get funding URL");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel fade-in" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">⚡</span>Fund Node
        </span>
      </div>
      <div
        className="panel-body"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}
      >
        <div>
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 4,
            }}
          >
            On-chain Balance
          </div>
          {balances === null ? (
            <div className="loading-shimmer" style={{ height: 24, width: 140 }} />
          ) : (
            <div style={{ fontFamily: "var(--mono)", fontSize: "1.125rem", color: "var(--text-1)" }}>
              {balances.onchain_sats.toLocaleString()}{" "}
              <span style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>sats</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <button className="btn btn-primary" onClick={handleFund} disabled={loading}>
            {loading ? "Opening…" : "Fund Node via Coinbase →"}
          </button>
          {error && (
            <span style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</span>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add app/web/src/components/FundNodePanel.tsx
git commit -m "feat(web): add FundNodePanel component"
```

---

### Task 7: Insert panel into both dashboards

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`
- Modify: `app/web/src/pages/Dashboard.tsx`

**Step 1: Update MemberDashboard.tsx**

Add the import at the top of the file, after the existing `NodeBalancePanel` import:

```ts
import FundNodePanel from "../components/FundNodePanel";
```

Then find `<NodeBalancePanel />` (line 281). Insert `<FundNodePanel />` immediately after it:

```tsx
      <NodeBalancePanel />
      <FundNodePanel />

      {/* Membership status */}
```

**Step 2: Update Dashboard.tsx**

Add the import at the top of the file, after the existing `NodeBalancePanel` import (line 13):

```ts
import FundNodePanel from "../components/FundNodePanel";
```

Then find `<NodeBalancePanel />` (line 692). Insert `<FundNodePanel />` immediately after it, before `<AlertsBar />`:

```tsx
      <NodeBalancePanel />
      <FundNodePanel />
      <AlertsBar />
```

**Step 3: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx app/web/src/pages/Dashboard.tsx
git commit -m "feat(web): add FundNodePanel to MemberDashboard and Treasury Dashboard"
```

---

### Task 8: Manual verification

**Setup: Add mock routes via Playwright (or test with real API)**

The Vite dev server runs on port 3200. The API runs on port 3101.

**Test case 1 — button opens Coinbase URL (Playwright mock):**

```js
await page.route('http://localhost:3101/api/node/balances', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ onchain_sats: 2_500_000, lightning_sats: 1_450_000, total_sats: 3_950_000 })
}));

await page.route('http://localhost:3101/api/coinbase/onramp-url', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    url: 'https://pay.coinbase.com/buy/select-asset?appId=test123&destinationWallets=%5B%7B%22address%22%3A%22bc1q...%22%2C%22assets%22%3A%5B%22BTC%22%5D%2C%22network%22%3A%22bitcoin%22%7D%5D&defaultAsset=BTC&defaultNetwork=bitcoin&fiatCurrency=USD',
    wallet_address: 'bc1qtest...'
  })
}));
```

Expected:
- FundNodePanel appears below NodeBalancePanel on both dashboards
- On-chain balance shows `2,500,000 sats`
- Clicking "Fund Node via Coinbase →" opens the Coinbase URL in a new tab (Playwright: intercept `window.open`)

**Test case 2 — 503 when not configured:**

```js
await page.route('http://localhost:3101/api/coinbase/onramp-url', route => route.fulfill({
  status: 503,
  contentType: 'application/json',
  body: JSON.stringify({ error: 'coinbase_not_configured' })
}));
```

Expected: Clicking button shows error text below the button: "coinbase_not_configured"

**Test case 3 — member dashboard:**

Same mocks, but with member role (`node_role: "member"`). FundNodePanel should appear on member dashboard as well.

**Test case 4 — real API with sandbox appId:**

Set `COINBASE_APP_ID=your_sandbox_app_id` in the API environment. Start the API. Call:

```bash
curl http://localhost:3101/api/coinbase/onramp-url
```

Expected: `{"url":"https://pay.coinbase.com/buy/select-asset?appId=...","wallet_address":"bc1q..."}`

Verify:
1. URL opens in browser and shows Coinbase Onramp with BTC pre-selected
2. SQLite row inserted: `SELECT * FROM coinbase_onramp_sessions;`
3. Each call generates a fresh `wallet_address`
