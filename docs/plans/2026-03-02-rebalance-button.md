# Rebalance Button Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a one-click "Rebalance" button for critical channels on both the Channels page and the Dynamic Fees Panel.

**Architecture:** Wire existing `GET /api/treasury/liquidity-health` and `POST /api/treasury/rebalance/keysend` endpoints to the frontend. Treasury-only — the health endpoint returns 403 for members, so no rebalance UI appears. Auto-calculate push amount client-side (toward 50% ratio, bounded 10k–100k sats).

**Tech Stack:** React 18, TypeScript, existing API endpoints (no backend changes).

---

### Task 1: Add API Client Types and Methods

**Files:**
- Modify: `app/web/src/api/client.ts`

Add the `ChannelLiquidityHealth` type and two new API methods.

**Add type** after the `CommodityPrices` type (after line 319):

```typescript
export type ChannelLiquidityHealth = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sats: number;
  local_sats: number;
  remote_sats: number;
  imbalance_ratio: number;
  health_classification: string;
  velocity_24h_sats: number;
  recommended_action: string;
  is_active: boolean;
};

export type KeysendRebalanceResult = {
  ok: boolean;
  result: {
    channel_id: string;
    peer_pubkey: string;
    amount_sats: number;
    fee_paid_sats: number;
    payment_hash: string;
    status: string;
    warning?: string;
    error?: string;
  };
};
```

**Add methods** to the `api` object (after line 43, `getDynamicFeePreview`):

```typescript
  getLiquidityHealth: () => apiFetch<ChannelLiquidityHealth[]>("/api/treasury/liquidity-health"),
  keysendRebalance: (channel_id: string, amount_sats: number) =>
    apiFetch<KeysendRebalanceResult>("/api/treasury/rebalance/keysend", {
      method: "POST",
      body: JSON.stringify({ channel_id, amount_sats }),
    }),
```

**Verify:** `cd app/web && npm run build` — must succeed.

**Commit:** `feat: add liquidity health and keysend rebalance API client methods`

---

### Task 2: Add Rebalance Button to Channels Page

**Files:**
- Modify: `app/web/src/App.tsx` — `ChannelsPage` component (lines 262–366)

**What to change:**

1. **Import** `ChannelLiquidityHealth` and `KeysendRebalanceResult` from `client.ts` (add to existing import on line 5).

2. **Add state** for liquidity health and rebalance status:

```typescript
const [health, setHealth] = useState<ChannelLiquidityHealth[]>([]);
const [rebalancing, setRebalancing] = useState<string | null>(null); // channel_id being rebalanced
const [rebalanceResult, setRebalanceResult] = useState<Record<string, { ok: boolean; message: string }>>({});
```

3. **Fetch health** alongside channels and contacts in the existing `Promise.all` (line 277). Health fetch should catch 403 silently (member nodes):

```typescript
Promise.all([
  fetch(`${API_BASE}/api/channels`).then((r) => r.json()),
  api.getContacts().catch(() => [] as Contact[]),
  api.getLiquidityHealth().catch(() => [] as ChannelLiquidityHealth[]),
]).then(([ch, ct, lh]) => {
  setChannels(ch);
  setContacts(ct);
  setHealth(lh);
  setLoading(false);
}).catch(() => setLoading(false));
```

4. **Add rebalance handler** inside `ChannelsPage`:

```typescript
const handleRebalance = async (channelId: string, localSats: number, capacitySats: number) => {
  setRebalancing(channelId);
  setRebalanceResult((prev) => { const next = { ...prev }; delete next[channelId]; return next; });
  try {
    const excess = localSats - Math.floor(capacitySats * 0.5);
    const amount = Math.min(100_000, Math.max(10_000, excess));
    const res = await api.keysendRebalance(channelId, amount);
    setRebalanceResult((prev) => ({
      ...prev,
      [channelId]: { ok: true, message: `Pushed ${res.result.amount_sats.toLocaleString()} sats` },
    }));
    // Re-fetch to update balances
    Promise.all([
      fetch(`${API_BASE}/api/channels`).then((r) => r.json()),
      api.getLiquidityHealth().catch(() => [] as ChannelLiquidityHealth[]),
    ]).then(([ch, lh]) => { setChannels(ch); setHealth(lh); });
  } catch (e) {
    setRebalanceResult((prev) => ({
      ...prev,
      [channelId]: { ok: false, message: e instanceof Error ? e.message : "Failed" },
    }));
  } finally {
    setRebalancing(null);
  }
};
```

5. **Inside each channel card** (within the `.map` at line 322), look up health for the channel:

```typescript
const h = health.find((x) => x.channel_id === c.channel_id);
const isCritical = h?.health_classification === "critical";
```

6. **Add health badge** next to the active/inactive badge in `.channel-card-top` (line 327–336). Insert before the active badge:

```tsx
{h && (
  <span
    className="badge"
    style={{
      background: `${healthColor[h.health_classification] ?? "var(--text-3)"}22`,
      color: healthColor[h.health_classification] ?? "var(--text-3)",
    }}
  >
    {h.health_classification.replace(/_/g, " ")}
  </span>
)}
```

Where `healthColor` is defined as a const at the top of `ChannelsPage`:

```typescript
const healthColor: Record<string, string> = {
  outbound_starved: "var(--red)",
  weak: "var(--yellow)",
  healthy: "var(--green)",
  inbound_heavy: "var(--blue)",
  critical: "var(--text-3)",
};
```

7. **Add rebalance button and result** after `.channel-balance-labels` div (after line 356), inside the channel card:

```tsx
{isCritical && (
  <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
    <button
      className="btn btn-primary btn-sm"
      disabled={rebalancing === c.channel_id}
      onClick={() => handleRebalance(c.channel_id, c.local_balance_sat, c.capacity_sat)}
    >
      {rebalancing === c.channel_id ? "Rebalancing…" : "Rebalance"}
    </button>
    {rebalanceResult[c.channel_id] && (
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: "0.75rem",
          color: rebalanceResult[c.channel_id].ok ? "var(--green)" : "var(--red)",
        }}
      >
        {rebalanceResult[c.channel_id].message}
      </span>
    )}
  </div>
)}
```

**Verify:** `cd app/web && npm run build` — must succeed.

**Commit:** `feat: add rebalance button and health badge to channels page`

---

### Task 3: Add Rebalance Button to Dynamic Fees Panel

**Files:**
- Modify: `app/web/src/pages/Dashboard.tsx` — `DynamicFeesPanel` component (lines 534–682)

**What to change:**

1. **Import** `ChannelLiquidityHealth` and `KeysendRebalanceResult` from `client.ts` (add to existing import).

2. **Add state** for rebalancing in `DynamicFeesPanel`:

```typescript
const [rebalancing, setRebalancing] = useState<string | null>(null);
const [rebalanceResult, setRebalanceResult] = useState<Record<string, { ok: boolean; message: string }>>({});
```

3. **Add rebalance handler** inside `DynamicFeesPanel`:

```typescript
const handleRebalance = async (a: ChannelFeeAdjustment) => {
  setRebalancing(a.channel_id);
  setRebalanceResult((prev) => { const next = { ...prev }; delete next[a.channel_id]; return next; });
  try {
    // Dynamic fee preview has imbalance_ratio but not raw sats; estimate from adjustments
    // Use getLiquidityHealth for accurate sats — but since ChannelFeeAdjustment only has ratio,
    // fetch channel data for the specific channel
    const channels = await fetch(`${API_BASE}/api/channels`).then((r) => r.json()) as Array<{
      channel_id: string; local_balance_sat: number; capacity_sat: number;
    }>;
    const ch = channels.find((c) => c.channel_id === a.channel_id);
    if (!ch) throw new Error("Channel not found");
    const excess = ch.local_balance_sat - Math.floor(ch.capacity_sat * 0.5);
    const amount = Math.min(100_000, Math.max(10_000, excess));
    const res = await api.keysendRebalance(a.channel_id, amount);
    setRebalanceResult((prev) => ({
      ...prev,
      [a.channel_id]: { ok: true, message: `Pushed ${res.result.amount_sats.toLocaleString()}` },
    }));
    load(); // Re-fetch fee adjustments
  } catch (e) {
    setRebalanceResult((prev) => ({
      ...prev,
      [a.channel_id]: { ok: false, message: e instanceof Error ? e.message : "Failed" },
    }));
  } finally {
    setRebalancing(null);
  }
};
```

4. **Add "Action" column** to the table header (after the "Factor" `<th>` at line 644):

```tsx
<th style={{ textAlign: "center" }}>Action</th>
```

5. **Add action cell** to each table row (after the Factor `<td>` at line 671):

```tsx
<td style={{ textAlign: "center" }}>
  {a.health_classification === "critical" ? (
    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
      <button
        className="btn btn-primary btn-sm"
        disabled={rebalancing === a.channel_id}
        onClick={() => handleRebalance(a)}
        style={{ fontSize: "0.6875rem", padding: "2px 10px" }}
      >
        {rebalancing === a.channel_id ? "…" : "Rebalance"}
      </button>
      {rebalanceResult[a.channel_id] && (
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: "0.625rem",
            color: rebalanceResult[a.channel_id].ok ? "var(--green)" : "var(--red)",
          }}
        >
          {rebalanceResult[a.channel_id].message}
        </span>
      )}
    </div>
  ) : (
    <span style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>—</span>
  )}
</td>
```

6. **Add import** for `API_BASE` from `../config/api` at the top of Dashboard.tsx (if not already imported).

**Verify:** `cd app/web && npm run build` — must succeed.

**Commit:** `feat: add rebalance button to dynamic fees panel`

---

### Task 4: Version Bump + CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

**Changes:**

1. **CLAUDE.md** — In "Current Capabilities" paragraph, after "keysend enforcement (pre-flight check...)", append:
   ```
   , one-click rebalance button for critical channels (Channels page + Dynamic Fees Panel, treasury-only, auto-calculated keysend push)
   ```

2. **umbrel-app.yml** — bump version `"1.3.3"` → `"1.3.4"`, update `releaseNotes`:
   ```yaml
   releaseNotes: >
     One-click rebalance button for critical channels on Channels page and
     Dynamic Fees Panel. Health badges show channel liquidity status.
     Treasury-only — auto-calculated keysend push toward 50% balance.
   ```

3. **docker-compose.yml** — bump both image tags `1.3.3` → `1.3.4`.

**Verify:** `cd app/web && npm run build` — must succeed.

**Commit:** `chore: bump version to 1.3.4, update docs for rebalance button`
