# Coinbase Auto-Buy — Plan 2b: Frontend UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `/auto-buy` page with 3 tabs (Valuation / DCA Strategy / Model Inputs) plus the Coinbase credential-onboarding flow, purchase history, and master enable/pause/execute-now controls. Wire sidebar links into both treasury and member shells.

**Architecture:** Single page `app/web/src/pages/AutoBuy.tsx` owns tab state and two polled reads (`/api/autobuy/status` + `/api/valuation/current`). Tab content is delegated to four sibling components in `app/web/src/components/autoBuy/` so each file stays under ~300 lines. All mutating routes (enable/pause/execute-now/config/credentials) fire from the page via `client.ts` wrappers and re-poll status on success.

**Tech Stack:** React 18 + TypeScript, react-router-dom for routing, recharts for the BTC log-price + Z-score history charts (already a dependency), qrcode for the deposit-address QR (already a dependency). No new npm packages.

---

## Context for the engineer

- Plan 2a (backend) is shipped on branch `feature/coinbase-autobuy-executor` (12 routes live). This plan branches off 2a HEAD.
- Spec reference: `docs/superpowers/specs/2026-04-17-coinbase-auto-buy-design.md` §6 (UI Design) + §9.3 (user onboarding flow) + §7 (edge cases / UI states).
- Repo convention (CLAUDE.md): no automated test suite for `app/web`. Verification per task is `npm run build` (Vite/tsc) + visually loading the page at http://localhost:3200 under `npm run dev`.
- Routing lives in `app/web/src/App.tsx`. Both `AppShell` (treasury) and `MemberShell` (member) have independent `<Routes>` blocks and independent sidebars. Per spec §5.6, Auto-Buy runs on both — so sidebar + route must land in BOTH shells.
- API client: `app/web/src/api/client.ts` — all types live in this file (no separate `types.ts`). The `api` const object starts at line 25 with wrappers like `getNode: () => apiFetch<NodeInfo>("/api/node")`. Types are declared at the bottom of the file (starting ~line 216).
- Existing precedent for a page with tabs, polling, and editable form: `app/web/src/pages/ValuationInput.tsx` (227 lines, Plan 1b). Bigger reference for a multi-section page with inline modals: `app/web/src/pages/MemberLiquidity.tsx` (754 lines) and `app/web/src/pages/RefillChannel.tsx` (791 lines).
- Inline toast pattern: see ValuationInput.tsx:47 — local state `const [toast, setToast] = useState<{kind, message} | null>(null)`, rendered via a single `<div className="alert ...">` block at the top of the page.
- CSS tokens used throughout: `var(--text)`, `var(--text-dim)`, `var(--bg)`, `var(--panel)`, `var(--border)`, `var(--green)`, `var(--red)`, `var(--amber)`, `var(--blue)`. Classes: `panel`, `panel-header`, `panel-body`, `badge`, `badge-green|red|amber|blue|muted`, `alert`, `alert-icon`, `alert-body`, `loading-shimmer`, `tag-pill`, `text-dim`.
- Branch for this plan: `feature/coinbase-autobuy-ui`, forked from `feature/coinbase-autobuy-executor` HEAD.

## File structure after this plan

```
app/web/
├── src/
│   ├── App.tsx                                       (modified: sidebar + route in both shells)
│   ├── api/
│   │   └── client.ts                                 (modified: 12 new wrappers + 8 new types)
│   ├── pages/
│   │   └── AutoBuy.tsx                               (new: page shell, tab nav, polling)
│   └── components/
│       └── autoBuy/
│           ├── ValuationTab.tsx                      (new: hero cards + gauge + charts)
│           ├── StrategyTab.tsx                       (new: banner + multipliers + history + Coinbase card host)
│           ├── CoinbaseCard.tsx                      (new: 3-state credential onboarding)
│           ├── HistoryTable.tsx                      (new: purchase history with pagination)
│           └── InputsTab.tsx                         (new: read-only model inputs)
```

No changes to other pages, the Worker, or the API backend. Alerts/banners are local to the page (we're not adding new `treasury_alerts` types — the spec §7 alerts were all added in Plan 2a backend already).

---

## Task 1: Client types + 12 API wrappers

**Files:**
- Modify: `app/web/src/api/client.ts`

- [ ] **Step 1: Add the 8 types at the bottom of the types section**

Find the existing types block (starts at `export type NodeInfo = {` near line 216). Append these types at the end of the types block (search for the last `export type ` in the file and add after it):

```typescript
// ─── Coinbase Auto-Buy ─────────────────────────────────────────────────

export type AutoBuyZoneMultipliers = {
  extreme_buy: number;
  undervalued: number;
  fair_value: number;
  elevated: number;
  overvalued: number;
  extreme_sell: number;
};

export type AutoBuyConfig = {
  enabled: boolean;
  base_unit_usd: number;
  frequency: "daily" | "weekly" | "biweekly" | "monthly";
  zone_multipliers: AutoBuyZoneMultipliers;
  withdraw_address: string;
  withdraw_address_whitelisted_at: number | null;
  sweep_day_of_week: number;
  consecutive_failures: number;
  paused_reason: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
};

export type AutoBuyCredentialsInfo = {
  key_name: string;
  connected_at: number;
  last_verified_at: number | null;
};

export type AutoBuyRun = {
  id: number;
  scheduled_for: number;
  z_score: number | null;
  zone: string | null;
  multiplier: number | null;
  base_unit_usd: number | null;
  intended_buy_usd: number | null;
  status: string;
  coinbase_order_id?: string | null;
  filled_btc?: number | null;
  filled_usd?: number | null;
  filled_at?: number | null;
  withdraw_txid?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at?: number;
  updated_at?: number;
};

export type AutoBuyStatus = {
  config: AutoBuyConfig | null;
  credentials: AutoBuyCredentialsInfo | null;
  in_flight: AutoBuyRun[];
  recent: AutoBuyRun[];
};

export type ValuationZone = "extreme_buy" | "undervalued" | "fair_value" | "elevated" | "overvalued" | "extreme_sell";

export type ValuationCurrent = {
  z_score: number;
  zone: ValuationZone;
  updated_at: string; // ISO-8601
  price_usd?: number;
};

export type ValuationInput = {
  value: number | null;
  z: number | null;
  weight: number;
  updated_at: string | null;
  category?: string;
  source?: string;
};

export type ValuationInputsResponse = Record<string, ValuationInput>;
```

- [ ] **Step 2: Add the 12 API wrappers to the `api` const object**

Find the `export const api = {` block (starts line 25). Find a sensible insertion point — the end of the object, just before the final `};`. Append the following 12 wrappers (comma after the previous last entry, comma after all but the last new entry):

```typescript
  // ─── Coinbase Auto-Buy ───────────────────────────────────────────────
  getAutoBuyStatus: () =>
    apiFetch<AutoBuyStatus>("/api/autobuy/status"),

  getAutoBuyHistory: (opts?: { limit?: number; offset?: number; status?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    if (opts?.status) qs.set("status", opts.status);
    const q = qs.toString();
    return apiFetch<{ rows: AutoBuyRun[]; total: number; limit: number; offset: number }>(
      `/api/autobuy/history${q ? `?${q}` : ""}`,
    );
  },

  patchAutoBuyConfig: (body: {
    base_unit_usd?: number;
    frequency?: AutoBuyConfig["frequency"];
    zone_multipliers?: AutoBuyZoneMultipliers;
    sweep_day_of_week?: number;
    whitelist_confirmed?: boolean;
  }) =>
    apiFetch<{ ok: true; config: unknown }>("/api/autobuy/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  enableAutoBuy: () =>
    apiFetch<{ ok: true; enabled: true }>("/api/autobuy/enable", { method: "POST" }),

  pauseAutoBuy: () =>
    apiFetch<{ ok: true; enabled: false }>("/api/autobuy/pause", { method: "POST" }),

  executeAutoBuyNow: () =>
    apiFetch<{ ok: true }>("/api/autobuy/execute-now", { method: "POST" }),

  postAutoBuyCredentials: (body: { json_blob: string } | { key_name: string; private_key: string }) =>
    apiFetch<{ ok: true; key_name: string; connected_at: number }>("/api/autobuy/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  deleteAutoBuyCredentials: () =>
    apiFetch<{ ok: true }>("/api/autobuy/credentials", { method: "DELETE" }),

  verifyAutoBuyCredentials: () =>
    apiFetch<{ ok: true; last_verified_at: number; accounts: Array<{ currency: string; available: number }> }>(
      "/api/autobuy/credentials/verify",
      { method: "POST" },
    ),

  getValuationCurrent: () =>
    apiFetch<ValuationCurrent>("/api/valuation/current"),

  getValuationHistory: (opts?: { since?: string; until?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.since) qs.set("since", opts.since);
    if (opts?.until) qs.set("until", opts.until);
    const q = qs.toString();
    return apiFetch<{ series: Array<{ date: string; z_score: number; zone: string; price_usd?: number }> }>(
      `/api/valuation/history${q ? `?${q}` : ""}`,
    );
  },

  getValuationInputs: () =>
    apiFetch<ValuationInputsResponse>("/api/valuation/inputs"),
```

- [ ] **Step 3: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run build
```

Expected: clean. If TypeScript complains about unused types, the Task 2 stub page will consume `AutoBuyStatus` and `ValuationCurrent`; the rest will be consumed by Tasks 3–9 before the end of this plan.

If an unused-type error fires before Task 2 ships, append a single `void` statement at the top of `client.ts` (below the `apiFetch` helper):

```typescript
// Task 1: hold types for consumers wired up in Tasks 2–9
void ({} as AutoBuyZoneMultipliers);
void ({} as AutoBuyConfig);
void ({} as AutoBuyCredentialsInfo);
void ({} as AutoBuyRun);
void ({} as AutoBuyStatus);
void ({} as ValuationZone);
void ({} as ValuationCurrent);
void ({} as ValuationInput);
void ({} as ValuationInputsResponse);
```

Remove this block before committing Task 9 (by which point all types are consumed). But first try without it — Vite's TypeScript config typically does not error on unused exported types.

- [ ] **Step 4: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/api/client.ts
git commit -m "feat(web/api): add autobuy + valuation client wrappers and types"
```

---

## Task 2: Route registration + sidebar links + stub page

Wire the `/auto-buy` route into BOTH shells with a placeholder page. This lets Task 3+ iterate without touching App.tsx again.

**Files:**
- Create: `app/web/src/pages/AutoBuy.tsx`
- Modify: `app/web/src/App.tsx`

- [ ] **Step 1: Create the stub page**

```typescript
// app/web/src/pages/AutoBuy.tsx
import { useEffect, useState } from "react";
import { api, type AutoBuyStatus, type ValuationCurrent } from "../api/client";

export default function AutoBuy() {
  const [status, setStatus] = useState<AutoBuyStatus | null>(null);
  const [valuation, setValuation] = useState<ValuationCurrent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([api.getAutoBuyStatus(), api.getValuationCurrent()])
      .then(([sR, vR]) => {
        if (sR.status === "fulfilled") setStatus(sR.value);
        if (vR.status === "fulfilled") setValuation(vR.value);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Auto-Buy Strategy</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Valuation-modulated dollar-cost averaging on Coinbase
        </p>
      </div>
      <div className="panel">
        <div className="panel-body">
          {loading ? <em className="text-dim">Loading…</em> : (
            <pre style={{ fontSize: "0.75rem", overflow: "auto" }}>
              {JSON.stringify({ status, valuation }, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire treasury shell**

In `app/web/src/App.tsx`:

**Import** — add near the other page imports (near line 19, alongside `import ValuationInput from "./pages/ValuationInput";`):

```typescript
import AutoBuy from "./pages/AutoBuy";
```

**Treasury sidebar** — in `TreasurySidebar`'s `navItems` array (lines 201–211), add a new entry after the `"/swaps"` entry and before `"/valuation-input"`:

```typescript
    { to: "/auto-buy", icon: "📈", label: "Auto-Buy" },
```

So the array becomes:

```typescript
  const navItems = [
    { to: "/dashboard", icon: "▤", label: "Dashboard" },
    { to: "/charts", icon: "⟠", label: "Charts" },
    { to: "/contacts", icon: "☰", label: "Contacts" },
    { to: "/peers", icon: "⟐", label: "Peers" },
    { to: "/channels", icon: "◈", label: "Channels" },
    { to: "/payments", icon: "↗", label: "Payments" },
    { to: "/liquidity", icon: "≋", label: "Liquidity" },
    { to: "/swaps", icon: "⟲", label: "Swaps" },
    { to: "/auto-buy", icon: "📈", label: "Auto-Buy" },
    { to: "/valuation-input", icon: "◐", label: "Valuation Inputs" },
  ];
```

**Treasury route** — inside `AppShell`'s `<Routes>` block (lines 285–298), add a new `<Route>` after `"/swaps"` and before `"/valuation-input"`:

```tsx
          <Route path="/auto-buy" element={<AutoBuy />} />
```

- [ ] **Step 3: Wire member shell**

**Member sidebar** — in `MemberSidebar`'s `navItems` array (lines 312–318), add the auto-buy entry between `"/channels"` and `"/payments"`:

```typescript
  const navItems = [
    { to: "/dashboard", icon: "▤", label: "My Dashboard" },
    { to: "/charts", icon: "⟠", label: "Charts" },
    { to: "/contacts", icon: "☰", label: "Contacts" },
    { to: "/channels", icon: "◈", label: "My Channels" },
    { to: "/auto-buy", icon: "📈", label: "Auto-Buy" },
    { to: "/payments", icon: "↗", label: "My Payments" },
  ];
```

**Member route** — inside `MemberShell`'s `<Routes>` block (lines 409–421), add a new `<Route>` after `"/payments"` and before `"/deposit"`:

```tsx
          <Route path="/auto-buy" element={<AutoBuy />} />
```

- [ ] **Step 4: Build + visual check**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run build
```

Expected: clean.

Manual check (optional but recommended):
```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run dev
```
Visit `http://localhost:3200/auto-buy` — should render the stub page with a JSON dump of current status + valuation, or `Loading…` then `null` fields if the backend isn't fully provisioned (e.g., valuation Worker key missing). Kill the dev server (Ctrl+C) before committing.

- [ ] **Step 5: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/pages/AutoBuy.tsx app/web/src/App.tsx
git commit -m "feat(web): wire /auto-buy route + sidebar links in both shells"
```

---

## Task 3: Page shell with tabs + shared state + polling

Replace the stub with the real page: three tabs, header banner, shared `status` / `valuation` state, polling at 30s, child components stubbed for Tasks 4-9.

**Files:**
- Create: `app/web/src/components/autoBuy/ValuationTab.tsx` (stub)
- Create: `app/web/src/components/autoBuy/StrategyTab.tsx` (stub)
- Create: `app/web/src/components/autoBuy/InputsTab.tsx` (stub)
- Modify: `app/web/src/pages/AutoBuy.tsx` (replace stub)

- [ ] **Step 1: Create the tab stubs**

```typescript
// app/web/src/components/autoBuy/ValuationTab.tsx
import type { ValuationCurrent } from "../../api/client";

interface Props {
  valuation: ValuationCurrent | null;
}

export default function ValuationTab({ valuation }: Props) {
  if (!valuation) {
    return <div className="panel"><div className="panel-body"><em className="text-dim">Valuation data unavailable.</em></div></div>;
  }
  return <div className="panel"><div className="panel-body"><em className="text-dim">Tab 1 — coming in Task 4</em></div></div>;
}
```

```typescript
// app/web/src/components/autoBuy/StrategyTab.tsx
import type { AutoBuyStatus, ValuationCurrent } from "../../api/client";

interface Props {
  status: AutoBuyStatus | null;
  valuation: ValuationCurrent | null;
  onRefresh: () => void;
}

export default function StrategyTab({ status, valuation, onRefresh }: Props) {
  void onRefresh; void status; void valuation;
  return <div className="panel"><div className="panel-body"><em className="text-dim">Tab 2 — coming in Tasks 5-8</em></div></div>;
}
```

```typescript
// app/web/src/components/autoBuy/InputsTab.tsx
export default function InputsTab() {
  return <div className="panel"><div className="panel-body"><em className="text-dim">Tab 3 — coming in Task 9</em></div></div>;
}
```

- [ ] **Step 2: Rewrite `pages/AutoBuy.tsx`**

```typescript
// app/web/src/pages/AutoBuy.tsx
import { useCallback, useEffect, useState } from "react";
import { api, type AutoBuyStatus, type ValuationCurrent } from "../api/client";
import ValuationTab from "../components/autoBuy/ValuationTab";
import StrategyTab from "../components/autoBuy/StrategyTab";
import InputsTab from "../components/autoBuy/InputsTab";

type TabId = "valuation" | "strategy" | "inputs";

export default function AutoBuy() {
  const [tab, setTab] = useState<TabId>("valuation");
  const [status, setStatus] = useState<AutoBuyStatus | null>(null);
  const [valuation, setValuation] = useState<ValuationCurrent | null>(null);
  const [loading, setLoading] = useState(true);
  const [valuationError, setValuationError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return Promise.allSettled([api.getAutoBuyStatus(), api.getValuationCurrent()]).then(
      ([sR, vR]) => {
        if (sR.status === "fulfilled") setStatus(sR.value);
        if (vR.status === "fulfilled") {
          setValuation(vR.value);
          setValuationError(null);
        } else {
          setValuationError(vR.reason?.message || "valuation_unavailable");
        }
      },
    );
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Auto-Buy Strategy</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Valuation-modulated dollar-cost averaging on Coinbase. Reads the composite Z-score, sizes each buy
          by zone multiplier, parks BTC on Coinbase for the 72h withdraw hold, sweeps weekly to your node's on-chain wallet.
        </p>
      </div>

      {valuationError && tab === "valuation" && (
        <div className="alert warning" style={{ marginBottom: 16 }}>
          <span className="alert-icon">⚠</span>
          <div className="alert-body">
            <div className="alert-type">Valuation unavailable</div>
            <div className="alert-msg">
              Worker returned no data. {valuationError}. The scheduler will refuse to buy if no fresh valuation is available.
            </div>
          </div>
        </div>
      )}

      <div className="tab-bar" style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid var(--border)" }}>
        {(["valuation", "strategy", "inputs"] as TabId[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "10px 16px",
              background: "none",
              border: "none",
              borderBottom: tab === t ? "2px solid var(--text)" : "2px solid transparent",
              color: tab === t ? "var(--text)" : "var(--text-dim)",
              fontWeight: tab === t ? 600 : 400,
              cursor: "pointer",
              fontSize: "0.9375rem",
              marginBottom: -1,
            }}
          >
            {t === "valuation" ? "Valuation Chart" : t === "strategy" ? "DCA Strategy" : "Model Inputs"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-shimmer" style={{ height: 320, borderRadius: 6 }} />
      ) : (
        <>
          {tab === "valuation" && <ValuationTab valuation={valuation} />}
          {tab === "strategy" && <StrategyTab status={status} valuation={valuation} onRefresh={refresh} />}
          {tab === "inputs" && <InputsTab />}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/pages/AutoBuy.tsx app/web/src/components/autoBuy/
git commit -m "feat(web/autoBuy): tabbed page shell with shared status + valuation polling"
```

---

## Task 4: Valuation Tab — hero cards + zone gauge + Z-score zone mapping

Per spec §6.1. Hero cards: Z-score / BTC price / Historical percentile / Peak Z-score / Current multiplier. Zone gauge showing the 6 zones with the needle at the current Z. BTC log-price chart with daily-zone coloring is deferred to a follow-up (requires `/api/valuation/history` + fetching BTC prices) — for v1 ship hero cards + gauge so the tab is useful.

**Files:**
- Modify: `app/web/src/components/autoBuy/ValuationTab.tsx` (replace stub)

- [ ] **Step 1: Zone constants + helpers**

Replace the stub with:

```typescript
// app/web/src/components/autoBuy/ValuationTab.tsx
import { useEffect, useState } from "react";
import { api, type ValuationCurrent, type ValuationZone } from "../../api/client";

interface Props {
  valuation: ValuationCurrent | null;
}

// Zone thresholds — mirror of `cloudflare-worker/src/valuation/zones.ts` on the frontend.
// Kept in sync manually; change both if thresholds ever move.
const ZONE_BANDS: Array<{ zone: ValuationZone; label: string; minZ: number; maxZ: number; color: string }> = [
  { zone: "extreme_buy",  label: "Extreme Buy",  minZ: -Infinity, maxZ: -2, color: "#10b981" },  // deep green
  { zone: "undervalued",  label: "Undervalued",  minZ: -2,        maxZ: -1, color: "#34d399" },  // green
  { zone: "fair_value",   label: "Fair Value",   minZ: -1,        maxZ:  1, color: "#94a3b8" },  // slate
  { zone: "elevated",     label: "Elevated",     minZ:  1,        maxZ:  2, color: "#fbbf24" },  // amber
  { zone: "overvalued",   label: "Overvalued",   minZ:  2,        maxZ:  3, color: "#f97316" },  // orange
  { zone: "extreme_sell", label: "Extreme Sell", minZ:  3,        maxZ:  Infinity, color: "#ef4444" }, // red
];

function zoneColor(zone: ValuationZone): string {
  return ZONE_BANDS.find((b) => b.zone === zone)?.color ?? "#94a3b8";
}

function zoneLabel(zone: ValuationZone): string {
  return ZONE_BANDS.find((b) => b.zone === zone)?.label ?? zone;
}

function formatUsd(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${n.toFixed(2)}`;
}
```

- [ ] **Step 2: Component body — hero cards**

Append below the helpers:

```typescript
export default function ValuationTab({ valuation }: Props) {
  const [history, setHistory] = useState<Array<{ date: string; z_score: number; zone: string; price_usd?: number }> | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getValuationHistory()
      .then((r) => { if (!cancelled) setHistory(r.series); })
      .catch((err) => { if (!cancelled) setHistoryError(err?.message ?? "history_unavailable"); });
    return () => { cancelled = true; };
  }, []);

  if (!valuation) {
    return (
      <div className="panel">
        <div className="panel-body">
          <em className="text-dim">Valuation data unavailable. Check that the Worker is deployed and reachable.</em>
        </div>
      </div>
    );
  }

  // Historical percentile: what fraction of past Z-scores were AT OR ABOVE today's Z?
  // Higher percentile = today is rarer-on-the-high-side.
  const percentile = history && history.length > 0
    ? (history.filter((p) => p.z_score >= valuation.z_score).length / history.length) * 100
    : null;

  const peak = history && history.length > 0
    ? history.reduce((max, p) => (p.z_score > max.z_score ? p : max), history[0])
    : null;

  const currentMultiplier = (() => {
    // Derive from spec default multipliers if caller didn't wire it separately —
    // the status route has authoritative multipliers, but here we show the zone-based hint.
    const defaults: Record<ValuationZone, number> = {
      extreme_buy: 3,
      undervalued: 2,
      fair_value: 1,
      elevated: 0.5,
      overvalued: 0.25,
      extreme_sell: 0,
    };
    return defaults[valuation.zone] ?? 0;
  })();

  return (
    <div>
      {/* Hero cards row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        <HeroCard label="Z-Score" value={valuation.z_score.toFixed(2)} sub={zoneLabel(valuation.zone)} color={zoneColor(valuation.zone)} />
        <HeroCard label="Bitcoin Price" value={formatUsd(valuation.price_usd)} sub={history && history.length > 0 ? `ATH ${formatUsd(Math.max(...history.map((p) => p.price_usd ?? 0)))}` : ""} />
        <HeroCard label="Historical Percentile" value={percentile != null ? `${percentile.toFixed(1)}%` : "—"} sub={percentile != null ? "of days at/above current Z" : "loading…"} />
        <HeroCard label="Peak Z-Score" value={peak ? peak.z_score.toFixed(2) : "—"} sub={peak ? peak.date : ""} />
        <HeroCard label="Current Multiplier" value={`${currentMultiplier}x`} sub="vs. base unit" color={zoneColor(valuation.zone)} />
      </div>

      {/* Zone gauge */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-header">Valuation Zone</div>
        <div className="panel-body">
          <ZoneGauge z={valuation.z_score} />
        </div>
      </div>

      {/* Placeholder for the log-price chart (deferred) */}
      <div className="panel">
        <div className="panel-header">BTC Log Price (deferred)</div>
        <div className="panel-body">
          <em className="text-dim">
            Zone-colored log-price chart to be added in a follow-up plan. Historical valuation series is loaded
            ({history?.length ?? 0} datapoints{historyError ? `, error: ${historyError}` : ""}).
          </em>
        </div>
      </div>
    </div>
  );
}

function HeroCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="panel" style={{ padding: 16 }}>
      <div className="text-dim" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: "1.75rem", fontWeight: 600, color: color ?? "var(--text)", lineHeight: 1.1 }}>{value}</div>
      {sub && <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function ZoneGauge({ z }: { z: number }) {
  // Map z from [-3, +3] onto [0, 100] for the needle.
  const clamped = Math.max(-3, Math.min(3, z));
  const pct = ((clamped + 3) / 6) * 100;

  return (
    <div>
      <div style={{ position: "relative", height: 32, borderRadius: 4, overflow: "hidden", display: "flex" }}>
        {ZONE_BANDS.map((b) => {
          const minPct = b.minZ === -Infinity ? 0 : ((b.minZ + 3) / 6) * 100;
          const maxPct = b.maxZ === Infinity ? 100 : ((b.maxZ + 3) / 6) * 100;
          const width = Math.max(0, maxPct - minPct);
          return <div key={b.zone} style={{ background: b.color, width: `${width}%`, height: "100%" }} title={`${b.label} (Z ${b.minZ} → ${b.maxZ})`} />;
        })}
        {/* Needle */}
        <div style={{
          position: "absolute",
          left: `${pct}%`,
          top: 0,
          bottom: 0,
          width: 2,
          background: "var(--text)",
          transform: "translateX(-1px)",
          boxShadow: "0 0 4px rgba(0,0,0,0.4)",
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: "0.75rem", color: "var(--text-dim)" }}>
        <span>Z = −3</span>
        <span>Z = 0</span>
        <span>Z = +3</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/components/autoBuy/ValuationTab.tsx
git commit -m "feat(web/autoBuy): Valuation tab — hero cards + zone gauge"
```

---

## Task 5: Strategy Tab — summary banner + zone multipliers editor

Per spec §6.2 rows 1 and 2. Banner computes "if base=$X the next buy is $Y". Multipliers editor is 6 number inputs + Save button → `PATCH /api/autobuy/config`.

**Files:**
- Modify: `app/web/src/components/autoBuy/StrategyTab.tsx` (partial — just the first two sections, rest in Tasks 6-8)

- [ ] **Step 1: Replace the stub**

```typescript
// app/web/src/components/autoBuy/StrategyTab.tsx
import { useEffect, useState } from "react";
import { api, type AutoBuyStatus, type AutoBuyZoneMultipliers, type ValuationCurrent, type ValuationZone } from "../../api/client";

interface Props {
  status: AutoBuyStatus | null;
  valuation: ValuationCurrent | null;
  onRefresh: () => Promise<unknown>;
}

const ZONE_ORDER: Array<{ key: keyof AutoBuyZoneMultipliers; label: string }> = [
  { key: "extreme_buy",  label: "Extreme Buy"  },
  { key: "undervalued",  label: "Undervalued"  },
  { key: "fair_value",   label: "Fair Value"   },
  { key: "elevated",     label: "Elevated"     },
  { key: "overvalued",   label: "Overvalued"   },
  { key: "extreme_sell", label: "Extreme Sell" },
];

export default function StrategyTab({ status, valuation, onRefresh }: Props) {
  if (!status?.config) {
    return (
      <div className="panel"><div className="panel-body">
        <em className="text-dim">Config unavailable. Backend may not be initialized.</em>
      </div></div>
    );
  }
  const cfg = status.config;

  // Next-buy banner
  const currentMultiplier = valuation ? cfg.zone_multipliers[valuation.zone as ValuationZone] ?? 0 : 0;
  const nextBuyUsd = Math.round(cfg.base_unit_usd * currentMultiplier * 100) / 100;

  return (
    <div>
      {/* Summary banner */}
      <div className="panel" style={{ marginBottom: 16, background: "var(--panel)", borderLeft: `4px solid ${nextBuyUsd > 0 ? "var(--green)" : "var(--text-dim)"}` }}>
        <div className="panel-body">
          <div style={{ fontSize: "0.875rem", color: "var(--text-dim)", marginBottom: 4 }}>At current Z-score</div>
          <div style={{ fontSize: "1.25rem" }}>
            {valuation ? (
              <>If base = <strong>${cfg.base_unit_usd.toFixed(2)}</strong> the next buy is <strong>${nextBuyUsd.toFixed(2)}</strong> (zone: {valuation.zone}, {currentMultiplier}×)</>
            ) : (
              <em className="text-dim">Valuation not loaded — next-buy calculation unavailable.</em>
            )}
          </div>
        </div>
      </div>

      {/* Multipliers editor */}
      <MultipliersEditor config={cfg} onSaved={onRefresh} />

      {/* TODO task 6: HistoryTable */}
      {/* TODO task 7: CoinbaseCard */}
      {/* TODO task 8: Pause/Resume controls */}
    </div>
  );
}

function MultipliersEditor({ config, onSaved }: { config: AutoBuyStatus["config"] & {}; onSaved: () => Promise<unknown> }) {
  const [baseUnit, setBaseUnit] = useState(String(config.base_unit_usd));
  const [frequency, setFrequency] = useState(config.frequency);
  const [mult, setMult] = useState<AutoBuyZoneMultipliers>(config.zone_multipliers);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  // Sync when parent config changes (e.g., after a save refreshes).
  useEffect(() => {
    setBaseUnit(String(config.base_unit_usd));
    setFrequency(config.frequency);
    setMult(config.zone_multipliers);
  }, [config]);

  const handleSave = async () => {
    setSaving(true); setToast(null);
    try {
      const base = Number(baseUnit);
      if (!Number.isFinite(base) || base <= 0) { setToast({ kind: "error", message: "Base unit must be a positive number." }); setSaving(false); return; }
      for (const { key, label } of ZONE_ORDER) {
        const v = mult[key];
        if (!Number.isFinite(v) || v < 0) { setToast({ kind: "error", message: `${label} multiplier must be ≥ 0.` }); setSaving(false); return; }
      }
      await api.patchAutoBuyConfig({
        base_unit_usd: base,
        frequency,
        zone_multipliers: mult,
      });
      setToast({ kind: "success", message: "Saved." });
      await onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error.";
      setToast({ kind: "error", message: msg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Strategy</div>
      <div className="panel-body">
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 16 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="text-dim" style={{ fontSize: "0.75rem" }}>Base unit (USD)</span>
            <input type="number" step="1" min="1" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="text-dim" style={{ fontSize: "0.75rem" }}>Frequency</span>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
        </div>

        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Zone Buy Multipliers</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
          {ZONE_ORDER.map(({ key, label }) => (
            <label key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="text-dim" style={{ fontSize: "0.75rem" }}>{label}</span>
              <input
                type="number"
                step="0.25"
                min="0"
                value={mult[key]}
                onChange={(e) => setMult({ ...mult, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>

        <button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save Strategy"}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run build
```

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/components/autoBuy/StrategyTab.tsx
git commit -m "feat(web/autoBuy): Strategy tab — next-buy banner + multipliers editor"
```

---

## Task 6: Purchase History table

Per spec §6.2 row 3. Paginated table of recent runs. Calls `GET /api/autobuy/history`.

**Files:**
- Create: `app/web/src/components/autoBuy/HistoryTable.tsx`
- Modify: `app/web/src/components/autoBuy/StrategyTab.tsx` (import + render)

- [ ] **Step 1: Create the component**

```typescript
// app/web/src/components/autoBuy/HistoryTable.tsx
import { useCallback, useEffect, useState } from "react";
import { api, type AutoBuyRun } from "../../api/client";

const PAGE_SIZE = 25;

export default function HistoryTable() {
  const [rows, setRows] = useState<AutoBuyRun[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");

  const load = useCallback(() => {
    setLoading(true);
    api.getAutoBuyHistory({ limit: PAGE_SIZE, offset, status: statusFilter || undefined })
      .then((r) => { setRows(r.rows); setTotal(r.total); })
      .catch(() => { setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [offset, statusFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Upcoming & Recent Purchases</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={statusFilter}
            onChange={(e) => { setOffset(0); setStatusFilter(e.target.value); }}
            style={{ fontSize: "0.75rem" }}
          >
            <option value="">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="buy_placed">Buy placed</option>
            <option value="buy_filled">Filled</option>
            <option value="awaiting_withdraw_hold">Awaiting hold</option>
            <option value="sweep_assigned">Sweep assigned</option>
            <option value="withdraw_placed">Withdraw placed</option>
            <option value="withdraw_confirmed">Withdrawn</option>
            <option value="skipped_stale_data">Skipped (stale)</option>
            <option value="skipped_zero_multiplier">Skipped (zero)</option>
            <option value="skipped_cap_hit">Skipped (cap)</option>
            <option value="skipped_insufficient_usd">Skipped (no USD)</option>
            <option value="failed_buy">Failed (buy)</option>
            <option value="failed_withdraw">Failed (withdraw)</option>
          </select>
          <button onClick={load} disabled={loading} style={{ fontSize: "0.75rem" }}>
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: "0.8125rem", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "8px 12px" }}>When</th>
                <th style={{ padding: "8px 12px" }}>Status</th>
                <th style={{ padding: "8px 12px" }}>Zone</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Z-Score</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>×</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Intended USD</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Filled BTC</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Filled USD</th>
                <th style={{ padding: "8px 12px" }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: 16 }}><em className="text-dim">Loading…</em></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: 16 }}><em className="text-dim">No runs yet.</em></td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{formatTs(r.scheduled_for)}</td>
                  <td style={{ padding: "8px 12px" }}><StatusBadge status={r.status} /></td>
                  <td style={{ padding: "8px 12px" }}>{r.zone ?? "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{r.z_score != null ? r.z_score.toFixed(2) : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{r.multiplier != null ? `${r.multiplier}×` : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{r.intended_buy_usd != null ? `$${r.intended_buy_usd.toFixed(2)}` : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{r.filled_btc != null ? r.filled_btc.toFixed(8) : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{r.filled_usd != null ? `$${r.filled_usd.toFixed(2)}` : "—"}</td>
                  <td style={{ padding: "8px 12px", fontSize: "0.75rem", color: "var(--text-dim)" }}>
                    {r.error_code ?? r.error_message ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ padding: "8px 12px", fontSize: "0.75rem", color: "var(--text-dim)", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border)" }}>
        <span>
          {total > 0 ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}` : "—"}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} style={{ fontSize: "0.75rem" }}>‹ Prev</button>
          <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total} style={{ fontSize: "0.75rem" }}>Next ›</button>
        </div>
      </div>
    </div>
  );
}

function formatTs(sec: number | null | undefined): string {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string }) {
  const STYLES: Record<string, { label: string; cls: string }> = {
    scheduled:               { label: "NEXT",              cls: "badge-blue" },
    buy_placed:              { label: "PLACED",            cls: "badge-blue" },
    buy_filled:              { label: "FILLED",            cls: "badge-green" },
    awaiting_withdraw_hold:  { label: "AWAITING-WITHDRAW", cls: "badge-amber" },
    sweep_assigned:          { label: "SWEEP",             cls: "badge-amber" },
    withdraw_placed:         { label: "WITHDRAWING",       cls: "badge-amber" },
    withdraw_confirmed:      { label: "WITHDRAWN",         cls: "badge-green" },
    skipped_stale_data:      { label: "SKIPPED",           cls: "badge-muted" },
    skipped_zero_multiplier: { label: "SKIPPED",           cls: "badge-muted" },
    skipped_cap_hit:         { label: "CAP HIT",           cls: "badge-muted" },
    skipped_insufficient_usd:{ label: "LOW USD",           cls: "badge-muted" },
    failed_buy:              { label: "FAILED",            cls: "badge-red" },
    failed_withdraw:         { label: "FAILED",            cls: "badge-red" },
  };
  const s = STYLES[status] ?? { label: status, cls: "badge-muted" };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}
```

- [ ] **Step 2: Wire it into `StrategyTab.tsx`**

Add the import at the top of `StrategyTab.tsx`:

```typescript
import HistoryTable from "./HistoryTable";
```

Replace the `{/* TODO task 6: HistoryTable */}` comment with:

```tsx
      <HistoryTable />
```

- [ ] **Step 3: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/components/autoBuy/HistoryTable.tsx app/web/src/components/autoBuy/StrategyTab.tsx
git commit -m "feat(web/autoBuy): purchase history table with filter + pagination"
```

---

## Task 7: Coinbase Integration card — 3-state credential onboarding

Per spec §6.2 "Coinbase Integration" subsection and §9.3 onboarding flow. Three states:
1. **Disconnected** — textarea for Coinbase Cloud Key JSON, Save & Connect button
2. **Connected (not whitelisted)** — verify button + dedicated deposit address panel + QR + "I've whitelisted" confirm
3. **Connected + whitelisted** — verified status, Execute Now button, Disconnect button

**Files:**
- Create: `app/web/src/components/autoBuy/CoinbaseCard.tsx`
- Modify: `app/web/src/components/autoBuy/StrategyTab.tsx` (import + render)

- [ ] **Step 1: Create the component**

```typescript
// app/web/src/components/autoBuy/CoinbaseCard.tsx
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, type AutoBuyStatus } from "../../api/client";

interface Props {
  status: AutoBuyStatus;
  onRefresh: () => Promise<unknown>;
}

type Toast = { kind: "success" | "error"; message: string } | null;

export default function CoinbaseCard({ status, onRefresh }: Props) {
  const connected = !!status.credentials;
  const whitelisted = !!status.config?.withdraw_address_whitelisted_at;

  if (!connected) return <DisconnectedState onRefresh={onRefresh} />;
  if (!whitelisted) return <ConnectedNotWhitelistedState status={status} onRefresh={onRefresh} />;
  return <ConnectedReadyState status={status} onRefresh={onRefresh} />;
}

// ───────────────────────────────────────────────────────────────────────
// Disconnected
// ───────────────────────────────────────────────────────────────────────

function DisconnectedState({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const [blob, setBlob] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const connect = async () => {
    setBusy(true); setToast(null);
    try {
      await api.postAutoBuyCredentials({ json_blob: blob });
      setToast({ kind: "success", message: "Connected. Verifying…" });
      await onRefresh();
      setBlob("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error.";
      setToast({ kind: "error", message: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Coinbase Integration</div>
      <div className="panel-body">
        <p style={{ marginTop: 0, marginBottom: 12 }}>
          Paste your Coinbase Cloud Key JSON file below. We'll verify the key with Coinbase, then encrypt it at rest.
        </p>
        <textarea
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          placeholder={`{\n  "name": "organizations/.../apiKeys/...",\n  "privateKey": "-----BEGIN EC PRIVATE KEY-----\\n..."\n}`}
          rows={8}
          style={{ width: "100%", fontFamily: "var(--mono)", fontSize: "0.75rem", marginBottom: 12, resize: "vertical" }}
        />
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 12 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button onClick={connect} disabled={busy || !blob.trim()}>{busy ? "Connecting…" : "Save & Connect"}</button>
          <a
            href="https://docs.cloud.coinbase.com/advanced-trade-api/docs/rest-api-auth"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "0.8125rem" }}
          >
            How to create a Coinbase Cloud Key →
          </a>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Connected but not whitelisted
// ───────────────────────────────────────────────────────────────────────

function ConnectedNotWhitelistedState({ status, onRefresh }: { status: AutoBuyStatus; onRefresh: () => Promise<unknown> }) {
  const [qr, setQr] = useState<string | null>(null);
  const [busyVerify, setBusyVerify] = useState(false);
  const [busyConfirm, setBusyConfirm] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const address = status.config?.withdraw_address ?? "";

  useEffect(() => {
    if (!address) { setQr(null); return; }
    QRCode.toDataURL(address.toUpperCase(), { width: 240 }).then(setQr).catch(() => setQr(null));
  }, [address]);

  const verify = async () => {
    setBusyVerify(true); setToast(null);
    try {
      const r = await api.verifyAutoBuyCredentials();
      setToast({ kind: "success", message: `Verified. ${r.accounts.length} Coinbase account(s) reachable.` });
      await onRefresh();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : "Verification failed." });
    } finally {
      setBusyVerify(false);
    }
  };

  const confirmWhitelist = async () => {
    if (!confirm("Confirm you have added this address to your Coinbase allowlist. If you haven't, withdrawals will fail and Auto-Buy will pause.")) return;
    setBusyConfirm(true); setToast(null);
    try {
      await api.patchAutoBuyConfig({ whitelist_confirmed: true });
      setToast({ kind: "success", message: "Whitelist confirmed. You can now enable Auto-Buy." });
      await onRefresh();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : "Failed to confirm." });
    } finally {
      setBusyConfirm(false);
    }
  };

  const copyAddress = () => {
    if (!address) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(address).then(() => setToast({ kind: "success", message: "Address copied." })).catch(() => fallbackCopy(address));
    } else {
      fallbackCopy(address);
    }
  };

  const fallbackCopy = (text: string) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); setToast({ kind: "success", message: "Address copied." }); }
    catch { setToast({ kind: "error", message: "Copy failed — please copy manually." }); }
    document.body.removeChild(ta);
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Coinbase Integration</div>
      <div className="panel-body">
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 16 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}

        {/* Connection row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
          <div>
            <div className="text-dim" style={{ fontSize: "0.75rem" }}>API Key</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem" }}>{maskKey(status.credentials?.key_name ?? "")}</div>
            <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 2 }}>
              {status.credentials?.last_verified_at
                ? `Last verified ${new Date(status.credentials.last_verified_at * 1000).toLocaleString()}`
                : "Not yet verified"}
            </div>
          </div>
          <button onClick={verify} disabled={busyVerify} style={{ fontSize: "0.8125rem" }}>{busyVerify ? "Verifying…" : "Verify connection"}</button>
        </div>

        {/* Address panel */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: 4 }}>Your dedicated deposit address</div>
          <p className="text-dim" style={{ fontSize: "0.8125rem", marginTop: 0, marginBottom: 12 }}>
            Add this address to Coinbase's withdrawal allowlist before enabling Auto-Buy. Coinbase requires 2FA to add an address — this is enforced in Coinbase's own UI, not ours.
          </p>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            {qr && <img src={qr} alt="QR code" style={{ width: 160, height: 160, borderRadius: 4, background: "white", padding: 8 }} />}
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem", wordBreak: "break-all", padding: 8, background: "var(--panel)", borderRadius: 4, marginBottom: 8 }}>
                {address || <em className="text-dim">address generating…</em>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={copyAddress} disabled={!address} style={{ fontSize: "0.8125rem" }}>Copy</button>
                <a
                  href="https://help.coinbase.com/en/coinbase/privacy-and-security/security/allow-list"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "0.8125rem", alignSelf: "center" }}
                >
                  How to whitelist an address in Coinbase →
                </a>
              </div>
            </div>
          </div>
        </div>

        <button
          onClick={confirmWhitelist}
          disabled={busyConfirm || !address}
          style={{ background: "var(--green)", color: "white", fontWeight: 600 }}
        >
          {busyConfirm ? "Confirming…" : "I've whitelisted this in Coinbase"}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Connected + whitelisted
// ───────────────────────────────────────────────────────────────────────

function ConnectedReadyState({ status, onRefresh }: { status: AutoBuyStatus; onRefresh: () => Promise<unknown> }) {
  const [busyVerify, setBusyVerify] = useState(false);
  const [busyDisconnect, setBusyDisconnect] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const verify = async () => {
    setBusyVerify(true); setToast(null);
    try {
      const r = await api.verifyAutoBuyCredentials();
      setToast({ kind: "success", message: `Verified. ${r.accounts.length} Coinbase account(s) reachable.` });
      await onRefresh();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : "Verification failed." });
    } finally { setBusyVerify(false); }
  };

  const disconnect = async () => {
    if (!confirm("Disconnect Coinbase credentials? This pauses Auto-Buy until you reconnect.")) return;
    setBusyDisconnect(true); setToast(null);
    try {
      await api.deleteAutoBuyCredentials();
      setToast({ kind: "success", message: "Disconnected." });
      await onRefresh();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : "Disconnect failed." });
    } finally { setBusyDisconnect(false); }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Coinbase Integration</div>
      <div className="panel-body">
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 16 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--green)", marginBottom: 2 }}>
              ✓ Connected & Whitelisted
            </div>
            <div className="text-dim" style={{ fontSize: "0.75rem" }}>
              {maskKey(status.credentials?.key_name ?? "")} — connected {new Date((status.credentials?.connected_at ?? 0) * 1000).toLocaleDateString()}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={verify} disabled={busyVerify} style={{ fontSize: "0.8125rem" }}>{busyVerify ? "Verifying…" : "Verify"}</button>
            <button onClick={disconnect} disabled={busyDisconnect} style={{ fontSize: "0.8125rem", color: "var(--red)" }}>{busyDisconnect ? "…" : "Disconnect"}</button>
          </div>
        </div>

        <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>
          Deposit address (whitelisted): <span style={{ fontFamily: "var(--mono)" }}>{status.config?.withdraw_address}</span>
        </div>
      </div>
    </div>
  );
}

function maskKey(keyName: string): string {
  if (!keyName) return "—";
  if (keyName.length <= 24) return keyName;
  return `${keyName.slice(0, 18)}…${keyName.slice(-8)}`;
}
```

- [ ] **Step 2: Wire into `StrategyTab.tsx`**

Add import:

```typescript
import CoinbaseCard from "./CoinbaseCard";
```

Replace `{/* TODO task 7: CoinbaseCard */}` with:

```tsx
      <CoinbaseCard status={status} onRefresh={onRefresh} />
```

Note: the `StrategyTab` component already has the `status` non-null guard near the top — passing `status` as non-null to `CoinbaseCard` is safe.

- [ ] **Step 3: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/components/autoBuy/CoinbaseCard.tsx app/web/src/components/autoBuy/StrategyTab.tsx
git commit -m "feat(web/autoBuy): Coinbase integration card (3-state onboarding)"
```

---

## Task 8: Master enable/pause control + alert banners + Execute Now

Per spec §6.2 bottom rows. Master switch flips `enabled` via the backend routes. Alert row shows `paused_reason` reasons in a human-readable way. Execute Now is available only when enabled.

**Files:**
- Modify: `app/web/src/components/autoBuy/StrategyTab.tsx` (add a new subcomponent at the top of the returned JSX)

- [ ] **Step 1: Add the subcomponent**

Open `StrategyTab.tsx`. Add this function at the bottom of the file (after `MultipliersEditor`):

```typescript
function MasterControl({ status, onRefresh }: { status: AutoBuyStatus; onRefresh: () => Promise<unknown> }) {
  const cfg = status.config;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  if (!cfg) return null;
  const enabled = cfg.enabled;
  const pausedReason = cfg.paused_reason;
  const canEnable = !!status.credentials && !!cfg.withdraw_address_whitelisted_at && cfg.consecutive_failures < 3;

  const doEnable = async () => {
    setBusy(true); setToast(null);
    try { await api.enableAutoBuy(); setToast({ kind: "success", message: "Auto-Buy enabled." }); await onRefresh(); }
    catch (err) { setToast({ kind: "error", message: err instanceof Error ? err.message : "Enable failed." }); }
    finally { setBusy(false); }
  };
  const doPause = async () => {
    setBusy(true); setToast(null);
    try { await api.pauseAutoBuy(); setToast({ kind: "success", message: "Auto-Buy paused." }); await onRefresh(); }
    catch (err) { setToast({ kind: "error", message: err instanceof Error ? err.message : "Pause failed." }); }
    finally { setBusy(false); }
  };
  const doExecuteNow = async () => {
    if (!confirm("Run a buy tick now? This respects all caps and will only place a buy if the schedule is due.")) return;
    setBusy(true); setToast(null);
    try { await api.executeAutoBuyNow(); setToast({ kind: "success", message: "Tick executed. Check history." }); await onRefresh(); }
    catch (err) { setToast({ kind: "error", message: err instanceof Error ? err.message : "Execute failed." }); }
    finally { setBusy(false); }
  };

  return (
    <>
      {pausedReason && <PausedBanner reason={pausedReason} />}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: 2 }}>
              {enabled ? <span style={{ color: "var(--green)" }}>● Enabled</span> : <span className="text-dim">○ Paused</span>}
            </div>
            <div className="text-dim" style={{ fontSize: "0.75rem" }}>
              {enabled
                ? cfg.next_run_at
                  ? `Next scheduled tick: ${new Date(cfg.next_run_at * 1000).toLocaleString()}`
                  : "No scheduled tick yet"
                : pausedReason ? `Paused: ${pausedReason}` : "Master switch is off"}
            </div>
            {cfg.consecutive_failures > 0 && (
              <div style={{ fontSize: "0.75rem", color: "var(--amber)", marginTop: 2 }}>
                {cfg.consecutive_failures} consecutive failure{cfg.consecutive_failures === 1 ? "" : "s"} (auto-pause at 3)
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {enabled ? (
              <>
                <button onClick={doExecuteNow} disabled={busy}>{busy ? "…" : "Execute Now"}</button>
                <button onClick={doPause} disabled={busy}>{busy ? "…" : "Pause"}</button>
              </>
            ) : (
              <button onClick={doEnable} disabled={busy || !canEnable} title={!canEnable ? "Connect + whitelist credentials first" : ""}>
                {busy ? "…" : "Enable"}
              </button>
            )}
          </div>
        </div>
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", margin: "0 16px 16px" }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}
      </div>
    </>
  );
}

function PausedBanner({ reason }: { reason: string }) {
  const { title, body } = PAUSED_MESSAGES[reason] ?? { title: "Auto-Buy paused", body: `paused_reason=${reason}` };
  return (
    <div className="alert warning" style={{ marginBottom: 16 }}>
      <span className="alert-icon">⚠</span>
      <div className="alert-body">
        <div className="alert-type">{title}</div>
        <div className="alert-msg">{body}</div>
      </div>
    </div>
  );
}

const PAUSED_MESSAGES: Record<string, { title: string; body: string }> = {
  user_paused:             { title: "Paused by operator",          body: "You can resume Auto-Buy from the master control." },
  no_credentials:          { title: "No Coinbase credentials",     body: "Connect a Coinbase Cloud Key in the integration panel below." },
  credentials_invalid:     { title: "Coinbase credentials invalid", body: "Coinbase rejected the API key. Rotate the key and re-connect." },
  credentials_corrupted:   { title: "Credentials corrupted",       body: "The encrypted key could not be decrypted. Reconnect to repair." },
  address_not_whitelisted: { title: "Withdrawal address not whitelisted", body: "Add the displayed address to Coinbase's allowlist and confirm via the integration panel below." },
  consecutive_failures:    { title: "Auto-paused after 3 failures", body: "Review the purchase history for error messages, then re-enable." },
};
```

- [ ] **Step 2: Render it at the top of the StrategyTab body**

Insert immediately after the `const cfg = status.config;` early-guard return, before the summary banner:

```tsx
  return (
    <div>
      <MasterControl status={status} onRefresh={onRefresh} />

      {/* Summary banner */}
      <div className="panel" ...
```

(Apply the insertion minimally — just add the `<MasterControl ... />` line. Don't restructure what's already there.)

- [ ] **Step 3: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/components/autoBuy/StrategyTab.tsx
git commit -m "feat(web/autoBuy): master enable/pause/execute-now control + paused banners"
```

---

## Task 9: Model Inputs tab — read-only table

Per spec §6.3. 12 rows listing each valuation input: name, category, source, value, per-input Z, weight, updated_at.

**Files:**
- Modify: `app/web/src/components/autoBuy/InputsTab.tsx` (replace stub)

- [ ] **Step 1: Replace the stub**

```typescript
// app/web/src/components/autoBuy/InputsTab.tsx
import { useEffect, useState } from "react";
import { api, type ValuationInputsResponse } from "../../api/client";

const DISPLAY_ORDER: Array<{ key: string; label: string; category: string; source: string }> = [
  { key: "mvrv",             label: "MVRV Z-Score",          category: "On-chain",      source: "Manual entry" },
  { key: "nvt",              label: "NVT",                    category: "On-chain",      source: "Manual entry" },
  { key: "reserveRisk",      label: "Reserve Risk",           category: "On-chain",      source: "Manual entry" },
  { key: "sopr",             label: "SOPR (30d MA)",          category: "On-chain",      source: "Manual entry" },
  { key: "minerOutflows",    label: "Miner Outflows",         category: "Miner",         source: "Manual entry" },
  { key: "puell",            label: "Puell Multiple",         category: "Miner",         source: "Manual entry" },
  { key: "hashRibbons",      label: "Hash Ribbons",           category: "Miner",         source: "Manual entry" },
  { key: "difficultyRibbon", label: "Difficulty Ribbon",      category: "Miner",         source: "Manual entry" },
  { key: "hodlWaves",        label: "HODL Waves",             category: "Behavior",      source: "Manual entry" },
  { key: "stockToFlow",      label: "Stock-to-Flow",          category: "Market Model",  source: "Computed locally" },
  { key: "ma200w",           label: "200W Moving Average",    category: "Price Model",   source: "Computed locally" },
  { key: "piCycle",          label: "Pi Cycle Top",           category: "Price Model",   source: "Computed locally" },
];

export default function InputsTab() {
  const [inputs, setInputs] = useState<ValuationInputsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getValuationInputs()
      .then(setInputs)
      .catch((err) => setError(err?.message ?? "unavailable"));
  }, []);

  if (error) {
    return (
      <div className="panel"><div className="panel-body">
        <em className="text-dim">Model inputs unavailable: {error}</em>
      </div></div>
    );
  }
  if (!inputs) {
    return <div className="loading-shimmer" style={{ height: 320, borderRadius: 6 }} />;
  }

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-header">Composite Valuation Model</div>
        <div className="panel-body">
          <p style={{ marginTop: 0 }}>
            The composite Z-score is a weighted sum of 12 inputs across 4 categories (on-chain, miner, behavior, price models).
            Each input is normalized to its own Z-score (how many standard deviations from its historical mean), then
            multiplied by the weight shown. A positive composite Z means bitcoin is unusually expensive by this model;
            a negative composite means it's unusually cheap.
          </p>
          <p style={{ marginBottom: 0 }}>
            Most inputs are manually entered weekly via the <strong>Valuation Inputs</strong> page (treasury-only).
            Three are computed locally on the Worker from public BTC price history. Weights are fixed in v1 and sum to 1.00.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-body" style={{ padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: "0.8125rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "8px 12px" }}>Input</th>
                  <th style={{ padding: "8px 12px" }}>Category</th>
                  <th style={{ padding: "8px 12px" }}>Source</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>Value</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>Z</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>Weight</th>
                  <th style={{ padding: "8px 12px" }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {DISPLAY_ORDER.map(({ key, label, category, source }) => {
                  const row = inputs[key];
                  return (
                    <tr key={key} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "8px 12px", fontWeight: 500 }}>{label}</td>
                      <td style={{ padding: "8px 12px", color: "var(--text-dim)" }}>{category}</td>
                      <td style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: "0.75rem" }}>{row?.source ?? source}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{fmtNum(row?.value)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)", color: colorForZ(row?.z) }}>{fmtNum(row?.z)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{row?.weight != null ? row.weight.toFixed(3) : "—"}</td>
                      <td style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: "0.75rem" }}>{fmtDate(row?.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.abs(n) < 100 ? n.toFixed(2) : n.toFixed(0);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}

function colorForZ(z: number | null | undefined): string {
  if (z == null || !Number.isFinite(z)) return "var(--text)";
  if (z <= -2) return "#10b981";
  if (z <= -1) return "#34d399";
  if (z <   1) return "var(--text)";
  if (z <   2) return "#fbbf24";
  if (z <   3) return "#f97316";
  return "#ef4444";
}
```

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run build
```

- [ ] **Step 3: If Task 1's `void` block was needed, remove it now**

If the Task 1 `void` suppression block was added, remove it from `client.ts` — all types are now consumed. Build again to confirm clean.

- [ ] **Step 4: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/web/src/components/autoBuy/InputsTab.tsx app/web/src/api/client.ts
git commit -m "feat(web/autoBuy): Model Inputs tab — read-only 12-input table"
```

---

## Task 10: Polish pass + operational smoke (user runs)

Not a code change — a checklist that the implementer AND the user run together before opening the PR.

- [ ] **Step 1: Visual inspection**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/web && npm run dev
```

Open `http://localhost:3200/auto-buy`. Verify:

- [ ] Sidebar entry is visible in both treasury and member shells (hit the treasury shell first, then switch to a member node if available).
- [ ] Tab 1 — Valuation Chart renders hero cards + zone gauge. If valuation is unavailable, the page shows a helpful banner (not a blank screen or infinite shimmer).
- [ ] Tab 2 — DCA Strategy in disconnected state shows the Coinbase paste area. Entering obviously-invalid JSON shows a clear error. (Do NOT paste a real Coinbase key during this smoke; use a throwaway test value first.)
- [ ] Tab 2 — with credentials connected but not whitelisted, the address panel shows + QR renders. Copy button works on HTTP (Tailscale IP) via the `document.execCommand` fallback.
- [ ] Tab 2 — zone multipliers editor saves without errors; reload confirms the values persisted.
- [ ] Tab 2 — master enable button is disabled until whitelist is confirmed.
- [ ] Tab 3 — Model Inputs renders all 12 rows; empty cells show `—` instead of `NaN` or `undefined`.
- [ ] Pause/Resume toggles the master switch and the banner updates without page reload (polling every 30s is acceptable lag).

Kill the dev server (Ctrl+C) when done.

- [ ] **Step 2: End-to-end backend smoke (user + one operator node)**

Only runs in a context where a real Coinbase Cloud Key is safe to paste. If you don't have a throwaway Coinbase account, skip and open the PR anyway — the code-review gate catches the rest.

```bash
# 1. Start the full stack (Umbrel sideload or local docker compose)
# 2. Open /auto-buy, paste a Coinbase Cloud Key (paper account if available)
# 3. Confirm verify returns USD + BTC balances
# 4. Copy the deposit address, whitelist on Coinbase
# 5. Confirm whitelist, then Enable
# 6. Click Execute Now
# 7. Watch the history table — row should move scheduled → buy_placed → buy_filled → awaiting_withdraw_hold
#    (stops there until the 72h hold elapses — sweep only runs on sweep_day_of_week anyway)
# 8. Optionally: use `sqlite3` to fast-forward `filled_at` to simulate hold elapsed (ADMIN ONLY,
#    never on a real-money row). Skip this in production.
```

- [ ] **Step 3: Open PR**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git push -u origin feature/coinbase-autobuy-ui
gh pr create --base feature/coinbase-autobuy-executor --title "Coinbase Auto-Buy UI (Plan 2b)" --body "$(cat <<'EOF'
## Summary

- Adds `/auto-buy` page with 3 tabs (Valuation / DCA Strategy / Model Inputs)
- Wires 12 new API client wrappers for the Plan 2a backend
- Full 3-state Coinbase credential onboarding flow
- Master enable/pause/execute-now control with human-readable pause banners

## Test plan

- [ ] Sidebar link renders in both treasury and member shells
- [ ] Tab 1 degrades gracefully when Worker is unreachable
- [ ] Coinbase paste → verify → whitelist → enable full onboarding flow completes
- [ ] Purchase history table paginates correctly
- [ ] Master switch toggles + Execute Now triggers a tick

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

Before handing this plan to an implementer:

**Spec coverage:**
- ✅ §6.1 Valuation tab — hero cards, gauge (Task 4); log-price chart explicitly deferred with rationale
- ✅ §6.2 Strategy tab — banner (Task 5), multipliers (Task 5), history (Task 6), Coinbase integration (Task 7), master switch (Task 8)
- ✅ §6.3 Model Inputs — Task 9
- ✅ §6.4 Routing — both shells, Task 2
- ✅ §9.3 Onboarding flow — Tasks 7 + 8 walk the user through each state

**Type consistency:**
- All types declared in Task 1 are referenced consistently: `AutoBuyStatus.config.zone_multipliers` has keys matching `AutoBuyZoneMultipliers`, `ValuationCurrent.zone` matches `ValuationZone` union.

**Known deferrals (explicitly out of Plan 2b scope):**
- BTC log-price chart with daily zone coloring (Task 4 placeholder) — can ship later without breaking anything.
- Backtest simulator (per spec §6.2 — deferred to Plan 2c entirely).
- Model Inputs weight editing (spec §8 — v2).

**No placeholders:** All 9 code tasks have complete code blocks, exact file paths, and exact commit messages. No "TODO: add error handling" or "similar to above."

---

## Execution handoff

Plan complete, saved to `docs/superpowers/plans/2026-04-20-coinbase-autobuy-plan-2b-ui.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration. Same pattern we used for Plan 2a.
2. **Inline execution** — batch execution with checkpoints.

Which approach?
