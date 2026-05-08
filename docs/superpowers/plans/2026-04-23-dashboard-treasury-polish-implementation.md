# Treasury Dashboard Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Compact & Hero" Treasury Dashboard polish on `feature/ui-dashboard-treasury`: compact top strip (balances + Fund CTA inline), Revenue panel with hero net-24h number + Briefing Room policy-card rows, and `BitcoinPriceGraph` chart shrunk from 220px to 120px.

**Architecture:** Changes concentrated in three files: `app/web/src/pages/Dashboard.tsx` (page restructure + hand-rolled top strip + hero/policy-card Revenue), `app/web/src/components/BitcoinPriceGraph.tsx` (one-line height change that also benefits MemberDashboard), and `app/web/src/styles.css` (new `.dashboard-top-strip` and `.revenue-hero` rules). Reuses the `.panel ops` and `.policy-card` classes landed in the Settings polish PR — no new shared component CSS. No backend changes. Version bump lands in the same PR.

**Tech Stack:** React 18 + TypeScript + Vite, CSS custom properties (light/dark already wired), IBM Plex Sans/Mono, Recharts for the price chart. Uses existing API client methods `api.getNodeBalances`, `api.getCoinbaseOnrampUrl`, `api.getTreasuryMetrics`, `api.getAlerts`.

**Spec:** `docs/superpowers/specs/2026-04-23-dashboard-treasury-polish-design.md`.

---

## Preflight notes for the engineer

- **No automated test suite.** Verification per task = `cd app/web && npm run build` clean + visual check in `npm run dev` when relevant. Treat TDD-style steps as "build-verify + visual-verify".
- **Branch `feature/ui-dashboard-treasury`** off `main` (currently at `5d5ed2a`). Do not switch branches during implementation.
- **CSS tokens in `:root`** (use these, don't invent new): `--bg`, `--bg-1`, `--bg-2`, `--bg-3`, `--border`, `--border-hi`, `--text`, `--text-2`, `--text-3`, `--amber`, `--amber-dim`, `--amber-glow`, `--amber-glow2`, `--green`, `--red`, `--mono`, `--sans`, `--radius`, `--radius-lg`.
- **Classes already in styles.css** (reusable): `.panel`, `.panel ops`, `.panel-header`, `.panel-title`, `.panel-body`, `.policy-card`, `.policy-card-label`, `.policy-card-meta`, `.policy-card-value`, `.policy-card-value .unit`, `.stat-card`, `.stat-label`, `.stat-value`, `.stat-sub`, `.btn`, `.btn-primary`, `.btn-ghost`, `.loading-shimmer`, `.empty-state`, `.badge`, `.badge-green`, `.alert`, `.alert-icon`, `.alert-body`.
- **Do NOT touch**: `app/web/src/pages/MemberDashboard.tsx`, `app/web/src/components/NodeBalancePanel.tsx`, `app/web/src/components/FundNodePanel.tsx`, `api/client.ts`, `App.tsx`, `AutoBuy.tsx`, anything under `components/autoBuy/`.
- **Node balance field names** (for inline fetch): `NodeBalances` has `onchain_sats`, `lightning_sats`, `total_sats` — NOT `on_chain_sats` or `channel_sats`.
- **Include the version bump in the same final push as code changes** (v1.12.1 required a follow-up PR because a late bump raced with merge; don't repeat).

---

## File Structure

### Files modified

- `app/web/src/pages/Dashboard.tsx` — page structure, imports, helpers, state, fetch effects, Revenue panel JSX. Grows from ~183 lines to ~230 lines.
- `app/web/src/components/BitcoinPriceGraph.tsx` — single value change: `<ResponsiveContainer height={220}>` → `<ResponsiveContainer height={120}>`. Change also affects MemberDashboard consumption, intentionally.
- `app/web/src/styles.css` — add `.dashboard-top-strip` and children, `.revenue-hero` and children. ~50 lines appended near the existing Settings/Wizard polish CSS block.
- `bitcorn-lightning-node/umbrel-app.yml` — bump `version` field + prepend release-notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — bump both `api:` and `web:` image tags.

### Files NOT modified

- `app/web/src/pages/MemberDashboard.tsx` — follow-up PR.
- `app/web/src/components/NodeBalancePanel.tsx`, `FundNodePanel.tsx`, `ValuationInputAlertBanner.tsx` — untouched.
- `app/web/src/api/client.ts` — API unchanged.
- `app/web/src/App.tsx` — routing unchanged.

### No new files

No new components. Helpers (`fmt`, `sats`, `formatSigned`) stay at the top of `Dashboard.tsx`. The compact top strip is inline markup, not a new component.

---

### Task 1: Add `.dashboard-top-strip` CSS

**Files:**
- Modify: `app/web/src/styles.css` — append near the existing `.policy-card` + `.settings-section-label` + `.wizard-step-rail` block (end of the polish-era additions, before the old/legacy CSS blocks further down). Exact insertion point: search for `.settings-footer-row` and place after its closing `}`.

- [ ] **Step 1: Add the rules**

```css
/* ─── Treasury Dashboard: compact top strip ─────────────── */
.dashboard-top-strip {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  margin-bottom: 12px;
}
.dashboard-top-strip .bal-group {
  display: flex;
  gap: 24px;
  font-family: var(--mono);
  flex-wrap: wrap;
}
.dashboard-top-strip .bal-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dashboard-top-strip .bal-label {
  font-size: 0.625rem;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.dashboard-top-strip .bal-value {
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--text);
}
.dashboard-top-strip .bal-value .unit {
  font-size: 0.625rem;
  color: var(--text-3);
  font-weight: 400;
  margin-left: 3px;
}
.dashboard-top-strip .fund-error {
  grid-column: 1 / -1;
  font-size: 0.75rem;
  color: var(--red);
  margin-top: 4px;
}
```

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: exit 0, no CSS warnings, no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/dashboard): add .dashboard-top-strip CSS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `.revenue-hero` CSS

**Files:**
- Modify: `app/web/src/styles.css` — append immediately after the Task 1 block.

- [ ] **Step 1: Add the rules**

```css
/* ─── Treasury Dashboard: revenue hero ─────────────────── */
.revenue-hero {
  padding: 14px 20px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}
.revenue-hero-num {
  font-family: var(--mono);
  font-size: 2.25rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1;
}
.revenue-hero-num.positive { color: var(--green); }
.revenue-hero-num.negative { color: var(--red); }
.revenue-hero-num.neutral { color: var(--text); }
.revenue-hero-caption {
  font-family: var(--mono);
  font-size: 0.6875rem;
  color: var(--text-3);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.revenue-hero-alltime {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 0.6875rem;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--amber-glow2);
  color: var(--amber-dim);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
```

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: exit 0 clean.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/dashboard): add .revenue-hero CSS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Shrink `BitcoinPriceGraph` chart height (220px → 120px)

**Files:**
- Modify: `app/web/src/components/BitcoinPriceGraph.tsx` — single value in the `<ResponsiveContainer>` prop.

- [ ] **Step 1: Edit the ResponsiveContainer height**

Find (around line 284):

```tsx
<ResponsiveContainer width="100%" height={220}>
```

Replace with:

```tsx
<ResponsiveContainer width="100%" height={120}>
```

No other changes to this file. Do NOT touch the loading-shimmer height (`style={{ height: 200 }}` at line ~243) — it's visible for less than 1s and matching it is not worth a separate edit.

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: exit 0, clean.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/components/BitcoinPriceGraph.tsx
git commit -m "feat(web/dashboard): shrink Bitcoin price chart to 120px

Chart is now 120px tall (was 220px). Y-axis ticks auto-redistribute
based on available height (~3 ticks at 120px). Change flows to
MemberDashboard consumption, intentionally — brief calls that page
dense, and a shorter chart benefits it too.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Dashboard.tsx — rewrite imports, helpers, and state

Dashboard.tsx restructures in three tasks (4, 5, 6) to keep each commit reviewable. Between commits the page builds and renders something sensible, just not the final polished state.

**Files:**
- Modify: `app/web/src/pages/Dashboard.tsx`

- [ ] **Step 1: Replace the imports block**

Find (lines 1–6):

```tsx
import { useState, useEffect } from "react";
import { api, type TreasuryMetrics, type TreasuryAlert } from "../api/client";
import NodeBalancePanel from "../components/NodeBalancePanel";
import FundNodePanel from "../components/FundNodePanel";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
import ValuationInputAlertBanner from "../components/ValuationInputAlertBanner";
```

Replace with:

```tsx
import { useState, useEffect } from "react";
import { api, type TreasuryMetrics, type TreasuryAlert, type NodeBalances } from "../api/client";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
import ValuationInputAlertBanner from "../components/ValuationInputAlertBanner";
```

`NodeBalancePanel` and `FundNodePanel` imports removed; `NodeBalances` type added.

- [ ] **Step 2: Add `formatSigned` helper**

After the existing `sats` helper (around line 17, right before `export default function Dashboard()`), add:

```tsx
function formatSigned(n: number): { text: string; cls: "positive" | "negative" | "neutral" } {
  if (n > 0) return { text: `+${n.toLocaleString()}`, cls: "positive" };
  if (n < 0) return { text: `−${Math.abs(n).toLocaleString()}`, cls: "negative" };
  return { text: "0", cls: "neutral" };
}
```

The minus sign is Unicode `U+2212` (typographic minus), not ASCII hyphen. Copy-paste the character from this plan verbatim.

- [ ] **Step 3: Add balance + fund state to the Dashboard component**

Find the existing state block inside `export default function Dashboard()` (around lines 20–22):

```tsx
  const [metrics, setMetrics] = useState<TreasuryMetrics | null>(null);
  const [alerts, setAlerts] = useState<TreasuryAlert[]>([]);
  const [loading, setLoading] = useState(true);
```

Replace with:

```tsx
  const [metrics, setMetrics] = useState<TreasuryMetrics | null>(null);
  const [alerts, setAlerts] = useState<TreasuryAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [balances, setBalances] = useState<NodeBalances | null>(null);
  const [fundLoading, setFundLoading] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);
```

- [ ] **Step 4: Add balance fetch + fund handler**

Right after the existing polling `useEffect` (which ends around line 42 with `return () => clearInterval(id);`), add:

```tsx
  // Balance polling (replaces <NodeBalancePanel />)
  useEffect(() => {
    api.getNodeBalances().then(setBalances).catch(() => {});
    const id = setInterval(() => {
      api.getNodeBalances().then(setBalances).catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  async function handleFund() {
    setFundLoading(true);
    setFundError(null);
    try {
      const { url } = await api.getCoinbaseOnrampUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      const msg = e?.message ?? "failed";
      setFundError(
        msg === "coinbase_not_configured"
          ? "Coinbase Onramp is not configured on this node."
          : msg,
      );
    } finally {
      setFundLoading(false);
    }
  }
```

This replicates the existing `FundNodePanel.tsx` behavior (button loading state, error special-case for `coinbase_not_configured`, opens URL in a new tab) inline.

- [ ] **Step 5: Build**

Run: `cd app/web && npm run build`
Expected: exit 0, no TypeScript errors. TypeScript will warn that `balances`, `fundLoading`, `fundError`, and `handleFund` are unused — that's OK, they'll be consumed in Task 5. If warnings fail the build, ignore the warnings; they're not errors.

- [ ] **Step 6: Commit**

```bash
git add app/web/src/pages/Dashboard.tsx
git commit -m "refactor(web/dashboard): add balance state + fund handler + formatSigned

Prep for removing NodeBalancePanel + FundNodePanel in favor of the
compact top strip (next commit). formatSigned helper will power the
Revenue hero number. No UI change yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Dashboard.tsx — replace top panels with compact strip

**Files:**
- Modify: `app/web/src/pages/Dashboard.tsx`

- [ ] **Step 1: Replace the top-panel section of the return JSX**

Find the current render (around lines 66–68):

```tsx
      <NodeBalancePanel />
      <FundNodePanel />
      <BitcoinPriceGraph />
```

Replace with:

```tsx
      <div className="dashboard-top-strip fade-in">
        <div className="bal-group">
          <div className="bal-item">
            <span className="bal-label">On-chain</span>
            <span className="bal-value">
              {balances ? balances.onchain_sats.toLocaleString() : "—"}
              <span className="unit">sats</span>
            </span>
          </div>
          <div className="bal-item">
            <span className="bal-label">Channel</span>
            <span className="bal-value">
              {balances ? balances.lightning_sats.toLocaleString() : "—"}
              <span className="unit">sats</span>
            </span>
          </div>
          <div className="bal-item">
            <span className="bal-label">Total</span>
            <span className="bal-value">
              {balances ? balances.total_sats.toLocaleString() : "—"}
              <span className="unit">sats</span>
            </span>
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleFund}
          disabled={fundLoading}
        >
          {fundLoading ? "Opening…" : "Fund Node →"}
        </button>
        {fundError && <div className="fund-error">{fundError}</div>}
      </div>

      <BitcoinPriceGraph />
```

Note: `<BitcoinPriceGraph />` stays in place right after the strip. `<NodeBalancePanel />` and `<FundNodePanel />` are gone.

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: exit 0. Unused-variable warnings from Task 4 should clear now.

- [ ] **Step 3: Visual sanity check (optional, recommended)**

If you can run the dev server: `cd app/web && npm run dev` → navigate to `/dashboard` as treasury. Verify:
- Compact top strip shows On-chain / Channel / Total with mono values.
- Fund Node button is right-aligned, amber, clickable.
- Clicking Fund Node opens Coinbase URL in a new tab (if Coinbase is configured) or shows the error inline below the strip.
- Bitcoin chart now shorter (120px instead of 220px).

- [ ] **Step 4: Commit**

```bash
git add app/web/src/pages/Dashboard.tsx
git commit -m "feat(web/dashboard): replace NodeBalancePanel+FundNodePanel with compact strip

Inline balance fetch + Fund CTA in a single row at the top of the
page. Removes two stacked panels, reclaims ~120px of vertical space
above the Revenue block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Dashboard.tsx — restructure Revenue panel (hero + policy cards)

**Files:**
- Modify: `app/web/src/pages/Dashboard.tsx` — the Treasury Revenue panel block (currently around lines 88–180).

- [ ] **Step 1: Replace the Revenue panel block**

Find the current Revenue panel (starts with `{/* ── Treasury Revenue ── */}` and ends with the closing `</div>` of its `className="panel fade-in"`). The full current shape is a single `<div className="panel fade-in">` with a header + body containing a `<table className="data-table">` and a `stat-card` row.

Replace the ENTIRE Revenue panel block with:

```tsx
      {/* ── Treasury Revenue (Briefing Room: panel.ops + hero + policy cards) ── */}
      <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">◈</span>Treasury Revenue</span>
          {!loading && activeAlerts.length === 0 && (
            <span className="badge badge-green">All systems healthy</span>
          )}
        </div>
        {!loading && metrics && (() => {
          const net24 = formatSigned(m24?.net_sats ?? 0);
          const netAll = formatSigned(mAll?.net_sats ?? 0);
          return (
            <div className="revenue-hero">
              <span
                className={`revenue-hero-num ${net24.cls}`}
                aria-label={`24 hour net revenue: ${
                  net24.cls === "positive" ? "plus " : net24.cls === "negative" ? "minus " : ""
                }${Math.abs(m24?.net_sats ?? 0).toLocaleString()} sats`}
              >
                {net24.text}
              </span>
              <span className="revenue-hero-caption">sats · 24h net</span>
              <span
                className="revenue-hero-alltime"
                aria-label={`all time net revenue: ${
                  netAll.cls === "positive" ? "plus " : netAll.cls === "negative" ? "minus " : ""
                }${Math.abs(mAll?.net_sats ?? 0).toLocaleString()} sats`}
              >
                ALL-TIME {netAll.text} sats
              </span>
            </div>
          );
        })()}
        <div className="panel-body">
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3].map((i) => <div key={i} className="loading-shimmer" style={{ height: 48, borderRadius: 6 }} />)}
            </div>
          ) : !metrics ? (
            <div className="empty-state">Unable to load treasury metrics.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="policy-card" style={{ cursor: "default" }}>
                <div>
                  <div className="policy-card-label">Forwarding fees</div>
                  <div className="policy-card-meta">
                    24h · earned on routed payments · all-time {formatSigned(mAll?.forwarded_fees_sats ?? 0).text}
                  </div>
                </div>
                <div className="policy-card-value" style={{ color: "var(--green)" }}>
                  {formatSigned(m24?.forwarded_fees_sats ?? 0).text}
                  <span className="unit">sats</span>
                </div>
              </div>
              <div className="policy-card" style={{ cursor: "default" }}>
                <div>
                  <div className="policy-card-label">Rebalance costs</div>
                  <div className="policy-card-meta">
                    24h · paid to rebalance ops · all-time {formatSigned(-Math.abs(mAll?.rebalance_costs_sats ?? 0)).text}
                  </div>
                </div>
                <div className="policy-card-value" style={{ color: "var(--red)" }}>
                  {formatSigned(-Math.abs(m24?.rebalance_costs_sats ?? 0)).text}
                  <span className="unit">sats</span>
                </div>
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
                <div className="stat-card" style={{ flex: "1 1 140px" }}>
                  <div className="stat-label">Capital Deployed</div>
                  <div className="stat-value" style={{ fontSize: "1.125rem" }}>
                    {sats(cap?.capital_deployed_sats ?? 0)}
                  </div>
                  <div className="stat-sub">sats</div>
                </div>
                <div className="stat-card" style={{ flex: "1 1 140px" }}>
                  <div className="stat-label">Active Channels</div>
                  <div className="stat-value" style={{ fontSize: "1.125rem" }}>
                    {liq?.active_count ?? 0}
                  </div>
                  <div className="stat-sub">of {liq?.total_count ?? 0} total</div>
                </div>
                <div className="stat-card" style={{ flex: "1 1 140px" }}>
                  <div className="stat-label">Revenue Yield</div>
                  <div className="stat-value" style={{ fontSize: "1.125rem", color: (cap?.revenue_yield ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                    {fmt(Math.round(cap?.revenue_yield ?? 0))}
                  </div>
                  <div className="stat-sub">sats per 1M deployed</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
```

Key points:
- `className="panel ops"` (was `"panel"`) activates the amber border-top + amber-tinted header from the Settings polish CSS.
- The hero block renders only when `!loading && metrics` (so it doesn't flicker during initial load or flash empty). It's outside the `panel-body` so it sits between the header and the body with its own `border-bottom`.
- The rebalance-cost values use `-Math.abs(...)` because the API returns positive numbers for costs, and we want the display to show them as negative. The `formatSigned` helper handles the Unicode minus rendering.
- Policy cards have `cursor: "default"` to cancel the `cursor: pointer` default from the `.policy-card` class (cards here are read-only).
- Stat cards use the existing `.stat-card` class from `styles.css` — unchanged from today's behavior.
- `aria-label` on the hero number and all-time badge reads the value as prose for screen readers ("plus 12,450 sats" not "plus 12450").

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: exit 0 clean.

- [ ] **Step 3: Visual check**

`cd app/web && npm run dev` → `/dashboard`. Verify:
- Revenue panel has amber border-top + amber-tinted header.
- Hero number renders in green (if net24 is positive), red (negative), or neutral (zero), with explicit `+` / `−` / no sign.
- Caption "sats · 24h net" in muted mono sits next to the hero number.
- All-time badge on the right shows the all-time net with same signing.
- Forwarding fees card in green; Rebalance costs card in red.
- Meta lines on each card show the all-time value inline.
- Stat cards row unchanged in appearance.
- Theme toggle (Settings → theme chips) renders correctly in both dark and light.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/pages/Dashboard.tsx
git commit -m "feat(web/dashboard): hero number + policy-card Revenue (Briefing Room)

Revenue panel gains .panel.ops chrome, a big hero net-24h number with
explicit +/- sign, and policy-card rows for forwarding fees /
rebalance costs. All-time values surface inline in each card's meta
line. Stat cards row unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Version bump

Bump patch version on both Umbrel manifest files. Land the bump BEFORE pushing the PR — learned from v1.12.1 which required a follow-up PR because the bump raced with the merge.

**Files:**
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

- [ ] **Step 1: Check the current version on main**

Run:
```bash
grep -nE "^version:" bitcorn-lightning-node/umbrel-app.yml
```

Record the current version. It will be either `1.13.0` (if PR #119 hasn't merged yet) or `1.13.1` (if it has). Bump the patch digit by one: `1.13.0` → `1.13.1`, or `1.13.1` → `1.13.2`.

If the current version is something you don't expect (e.g. `1.14.x`), STOP and report as NEEDS_CONTEXT — main has advanced unexpectedly and the bump needs to be decided with the user.

For the rest of this task, substitute `<NEW>` with the target version (e.g. `1.13.2` or `1.13.1`), `<OLD>` with the current version.

- [ ] **Step 2: Bump the version field in umbrel-app.yml**

Find:
```yaml
version: "<OLD>"
```
Replace with:
```yaml
version: "<NEW>"
```

- [ ] **Step 3: Prepend the v<NEW> release-notes paragraph**

Find the `releaseNotes: >` block. The first paragraph inside it currently starts with `v<OLD>: …`. Insert the v<NEW> paragraph ABOVE it, preserving the 2-space YAML indentation. Do NOT delete the existing v<OLD> paragraph.

The new paragraph:

```yaml
  v<NEW>: Treasury Dashboard polish. Collapses the top-of-page
  balances and Fund-Node CTA into a single compact row. Revenue
  panel gains a big hero net-24h number with explicit +/- sign, and
  the forwarding-fees / rebalance-costs rows use the Briefing Room
  policy-card vocabulary from the Settings and Wizard pages. All-time
  values surface inline in each card's meta line. Bitcoin price chart
  shrunk from 220px to 120px (y-axis still shown). No backend changes.
```

Substitute `<NEW>` with the actual version string (e.g. `1.13.2`).

- [ ] **Step 4: Bump both image tags in docker-compose.yml**

Find:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/api:<OLD>
```
Replace with:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/api:<NEW>
```

Find:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/web:<OLD>
```
Replace with:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/web:<NEW>
```

- [ ] **Step 5: Verify consistency**

Run:
```bash
grep -nE "^version:|v<NEW>|api:<NEW>|web:<NEW>|api:<OLD>|web:<OLD>" bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
```

Expected: both files show `<NEW>` version references, no remaining `<OLD>` image tag references in docker-compose.yml, and the v<OLD> release-notes paragraph is preserved below the new v<NEW> paragraph in umbrel-app.yml.

- [ ] **Step 6: Commit**

```bash
git add bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
git commit -m "chore: bump to v<NEW> for Treasury Dashboard polish

Umbrel manifest + compose image tags bumped together. Release notes
for v<NEW> prepended.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Cross-theme + MemberDashboard smoke check (human)

No code changes expected. Final pre-PR verification.

- [ ] **Step 1: Final clean build**

```bash
cd app/web && npm run build
```

Expected: exit 0, no TypeScript warnings about unused imports (all removed in Task 4). Only the pre-existing chunk-size advisory is acceptable.

- [ ] **Step 2: Dev server manual verification**

```bash
cd app/web && npm run dev
```

As treasury role, test four combinations:
- Dark theme, `/dashboard` — verify compact top strip, Revenue hero number, policy cards, short price chart.
- Light theme, `/dashboard` — same.

As member role (if you can switch), test one combination:
- Either theme, `/dashboard` — verify nothing is broken. The page should be the existing MemberDashboard, unchanged EXCEPT that the Bitcoin price chart is shorter (120px instead of 220px). That's the single expected visible difference to MemberDashboard from this PR.

Save screenshots for the PR description (suggested names: `dashboard-treasury-dark.png`, `dashboard-treasury-light.png`, `dashboard-member-unchanged.png`). Do NOT commit them.

- [ ] **Step 3: Fix any visual issues**

If a visual issue surfaces (spacing, contrast, sign-rendering glitch, alignment), fix inline. Commit as `fix(web/dashboard): <what>`. If none, skip to Task 9.

---

### Task 9: Push branch + open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feature/ui-dashboard-treasury
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --title "feat(web/dashboard): Treasury Compact & Hero polish (v<NEW>)" --body "$(cat <<'EOF'
## Summary

Treasury Dashboard polish — the third page from the UI polish brief after Settings and Wizard.

- **Compact top strip** replaces the `<NodeBalancePanel />` + `<FundNodePanel />` stack with a single row: On-chain / Channel / Total balances in mono on the left, Fund Node CTA on the right. Hand-rolled inline in `Dashboard.tsx` so the shared components stay untouched for MemberDashboard.
- **Revenue panel** gets the Briefing Room operational treatment: `className="panel ops"` (amber border-top + tinted header), a 2.25rem mono hero number for net 24h with explicit `+` / `−` / `0` signing, and policy-card rows for forwarding fees / rebalance costs. All-time values surface inline in each card's meta line.
- **Bitcoin price chart** shrunk from 220px to 120px. Y-axis ticks still visible. Change also affects `MemberDashboard.tsx` (shared component), which is acceptable — member was already dense and a shorter chart benefits it too.
- **No backend changes.** Uses existing `api.getNodeBalances`, `api.getCoinbaseOnrampUrl`, `api.getTreasuryMetrics`, `api.getAlerts`.

Spec: `docs/superpowers/specs/2026-04-23-dashboard-treasury-polish-design.md`
Plan: `docs/superpowers/plans/2026-04-23-dashboard-treasury-polish-implementation.md`

MemberDashboard polish is a separate follow-up PR.

## Do-not-touch discipline

No changes to `NodeBalancePanel`, `FundNodePanel`, `MemberDashboard.tsx`, `AutoBuy.tsx`, `components/autoBuy/*`, `ValuationInput.tsx`, `api/client.ts`, `cloudflare-worker/*`, or anything under `app/api/`.

## Test plan

- [x] `cd app/web && npm run build` clean
- [x] Dark + light theme both visually verified on `/dashboard`
- [x] MemberDashboard smoke-tested — chart is 100px shorter, everything else unchanged
- [x] Fund Node button opens Coinbase URL in a new tab (or shows inline error if not configured)
- [x] Balance strip polls every 60s (matches pre-existing NodeBalancePanel cadence)
- [x] Revenue hero renders correctly for positive / negative / zero net values

## Screenshots

(attach: treasury + dark, treasury + light, member + either theme)

## Post-merge

1. Wait for `Build and publish Docker images` workflow (~5 min).
2. On Umbrel: `cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0 && git pull`
3. Hard-refresh Umbrel browser UI — update prompt appears.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Substitute `<NEW>` in the `--title` string with the actual version chosen in Task 7.

- [ ] **Step 3: Report PR URL**

The output of `gh pr create` includes the PR URL. Report it back.

---

## Post-merge checklist (reference, not steps)

- Wait for GitHub Actions `Build and publish Docker images` workflow to go ✅ (~5 min).
- On the Umbrel host:
  ```bash
  cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0
  git pull
  ```
- Hard-refresh the Umbrel browser UI — the Update button appears on the BitCorn Lightning tile.

---

## Self-review notes

- Every `<OLD>` / `<NEW>` placeholder in Task 7 + 9 is explicitly substituted by the implementer after running the version-check grep — no hard-coded version drift.
- The Unicode minus sign `U+2212` in `formatSigned` is intentional — copy-paste verbatim from this plan so the character survives the editor round-trip. ASCII hyphen (`-`) would also work functionally but looks typographically wrong at 2.25rem.
- Rebalance costs use `-Math.abs(value)` to convert API-positive-for-costs → display-negative-for-expenses. This matches the existing table's approach (`-${fmt(Math.abs(...))}`).
- `.policy-card` has `cursor: pointer` from the Settings PR because Settings cards are clickable. Dashboard's revenue cards are read-only, so inline `cursor: "default"` overrides it. Same pattern as Wizard's Review screen cards.
- Hero block renders outside `.panel-body` because it has its own padding + bottom border. `metrics?.last_24h.net_sats` is accessed through `m24` (derived earlier in the component); if `metrics` is null, the hero doesn't render.
