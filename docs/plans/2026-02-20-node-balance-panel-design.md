# Node Balance Panel — Design

**Date:** 2026-02-20
**Scope:** Treasury dashboard + Member dashboard

---

## What We're Building

A three-card balance summary panel displayed at the very top of both dashboards (above all existing content), showing the node's current financial position at a glance.

| Card | Label | Value |
|---|---|---|
| 1 | Total Node Balance | on-chain sats + Lightning local sats |
| 2 | Bitcoin Balance | confirmed on-chain sats only |
| 3 | Lightning Wallet | sum of local sats across all channels |

Each card shows: primary value in sats, secondary line in BTC (8 decimal places).

---

## Data Source

**New endpoint: `GET /api/node/balances`**

- Public (no role gate — both treasury and member nodes call it)
- Backend fetches confirmed on-chain balance live from LND via `getLndChainBalance()`
- Backend reads total Lightning local balance from SQLite: `SELECT SUM(local_balance_sat) FROM lnd_channels WHERE active = 1`
- Returns:

```json
{
  "onchain_sats": 2500000,
  "lightning_sats": 1450000,
  "total_sats": 3950000
}
```

- Polled every 15s (matches existing polling cadence in both dashboards)

---

## Frontend

**New component: `<NodeBalancePanel />`** in `app/web/src/components/NodeBalancePanel.tsx`

- Calls `api.getNodeBalances()` on mount, polls every 15s
- Shows loading shimmer while fetching
- Three `stat-card` elements inside a `dashboard-grid` with `gridTemplateColumns: "1fr 1fr 1fr"`
- BTC conversion: `(sats / 100_000_000).toFixed(8)`
- Inserted as the first element in both `MemberDashboard` and `Dashboard` (treasury) page render

**API client addition** in `app/web/src/api/client.ts`:

```ts
getNodeBalances: () => apiFetch<NodeBalances>("/api/node/balances"),

export type NodeBalances = {
  onchain_sats: number;
  lightning_sats: number;
  total_sats: number;
};
```

---

## What Is Not Changing

- No existing endpoint response shapes are modified
- No existing components are restructured
- No role gating — both member and treasury see the same data from the same endpoint
- Stablecoins (USDT/USDC) explicitly excluded from this scope

---

## Files Touched

| File | Change |
|---|---|
| `app/api/src/index.ts` | Add `GET /api/node/balances` handler |
| `app/web/src/api/client.ts` | Add `getNodeBalances` method + `NodeBalances` type |
| `app/web/src/components/NodeBalancePanel.tsx` | New component |
| `app/web/src/pages/MemberDashboard.tsx` | Insert `<NodeBalancePanel />` at top |
| `app/web/src/pages/Dashboard.tsx` | Insert `<NodeBalancePanel />` at top |
