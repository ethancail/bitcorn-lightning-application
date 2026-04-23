# Member Dashboard Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Balanced Member" Member Dashboard polish on `feature/ui-dashboard-member`: compact top strip matching treasury PR #120, `.panel.ops` chrome on the channel + forwarded-fees panels, role-aware hero-color signaling, and extracted CSS classes replacing inline-style soup. Preserve all role (merchant / farmer / unknown) and channel-state (pending / none / active) branching.

**Architecture:** Changes concentrated in two files: `app/web/src/pages/MemberDashboard.tsx` (page restructure + hand-rolled top strip + hero/gauge/action class extraction + `.panel.ops` chrome across all state branches) and `app/web/src/styles.css` (new `.member-status-row`, `.member-hero`, `.member-gauge`, `.member-action` classes, plus `.dashboard-top-strip` added conditionally since PR #120 may or may not have merged). Reuses `.panel.ops` and stat-card classes that already exist. No backend changes. Version bump lands in the same PR.

**Tech Stack:** React 18 + TypeScript + Vite, CSS custom properties (light/dark already wired), IBM Plex Sans/Mono. Uses existing API client methods `api.getMemberStats`, `api.getMemberLiquidityStatus`, `api.getExchangeRate`, `api.getPendingChannels`, `api.getTreasuryInfo`, `api.getNodeBalances`, `api.getCoinbaseOnrampUrl`.

**Spec:** `docs/superpowers/specs/2026-04-23-dashboard-member-polish-design.md`.

---

## Preflight notes for the engineer

- **No automated test suite.** Verification per task = `cd app/web && npm run build` clean + visual check in `npm run dev` when relevant. Treat TDD-style steps as "build-verify + visual-verify".
- **Branch `feature/ui-dashboard-member`** off `main` (currently at `b34fd2e` post-Wizard merge). Do not switch branches.
- **CSS tokens in `:root`** (use these, don't invent new): `--bg`, `--bg-1`, `--bg-2`, `--bg-3`, `--border`, `--border-hi`, `--text`, `--text-2`, `--text-3`, `--amber`, `--amber-dim`, `--amber-glow`, `--amber-glow2`, `--green`, `--red`, `--mono`, `--sans`, `--radius`, `--radius-lg`.
- **Classes already in styles.css** (reusable): `.panel`, `.panel ops`, `.panel-header`, `.panel-title`, `.panel-body`, `.policy-card` (+ children), `.stat-card`, `.btn`, `.btn-primary`, `.btn-outline`, `.loading-shimmer`, `.badge` + color variants, `.alert` + severity variants.
- **`.dashboard-top-strip` coordination.** This class was added in Treasury PR #120 (currently OPEN). Task 1 handles both cases: class already present (when rebasing against a post-#120 main), or not (current state).
- **Do NOT touch**: `app/web/src/pages/Dashboard.tsx`, `app/web/src/components/NodeBalancePanel.tsx`, `FundNodePanel.tsx`, `BitcoinPriceGraph.tsx`, `ValuationInputAlertBanner.tsx`, `ConnectToHub` internal form markup (only its outer panel's className changes), `api/client.ts`, `App.tsx`, `AutoBuy.tsx`, anything under `components/autoBuy/`.
- **Node balance field names** (for inline fetch, from `NodeBalances` type): `onchain_sats`, `lightning_sats`, `total_sats`.
- **Include version bump in the same final push as code changes** — per the v1.12.1 lesson.

---

## File Structure

### Files modified

- `app/web/src/pages/MemberDashboard.tsx` — imports, state, effects, render tree. Grows from 685 lines to ~720 lines.
- `app/web/src/styles.css` — add `.dashboard-top-strip` conditionally, always add `.member-status-row`, `.member-hero` + children, `.member-gauge` + children, `.member-action` + children. ~60–110 lines of CSS depending on whether the top-strip block is added.
- `bitcorn-lightning-node/umbrel-app.yml` — version bump + prepend release-notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — bump both image tags.

### Files NOT modified

- `app/web/src/pages/Dashboard.tsx` (treasury).
- `app/web/src/components/NodeBalancePanel.tsx`, `FundNodePanel.tsx` — no longer imported by MemberDashboard after this PR, but the files stay.
- `app/web/src/components/BitcoinPriceGraph.tsx` — unchanged (PR #120 already shortened to 120px; if not yet merged, member inherits on rebase).
- `ConnectToHub` internal form markup — only its outer panel's className changes.
- Everything else.

### No new files

All helpers stay at the top of `MemberDashboard.tsx`. No new components.

---

### Task 1: Conditionally add `.dashboard-top-strip` CSS

`.dashboard-top-strip` and its children were added in Treasury Dashboard PR #120. If that PR has merged to main by the time this task runs (or if we rebased after it merged), the class exists. Otherwise add it.

**Files:**
- Modify: `app/web/src/styles.css` (conditionally)

- [ ] **Step 1: Check if the class already exists**

```bash
grep -c "\.dashboard-top-strip" app/web/src/styles.css
```

Expected output: either `0` (class absent — proceed with Step 2) or ≥ `1` (class already present — skip Step 2 and go to Step 3).

- [ ] **Step 2: Add the CSS (ONLY if Step 1 returned 0)**

In `app/web/src/styles.css`, find the `.settings-footer-row` rule (from Settings PR) and append the following rules immediately after its closing `}`:

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

- [ ] **Step 3: Build verification**

```bash
cd app/web && npm run build
```

Expected: exit 0, no CSS warnings.

- [ ] **Step 4: Commit**

If Step 2 was executed (class was added):
```bash
git add app/web/src/styles.css
git commit -m "feat(web/dashboard): add .dashboard-top-strip CSS (shared with treasury)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If Step 2 was skipped (class already present):
Skip this task entirely — no commit needed. Note this in the task report.

## Report format for Task 1

- Grep result (`0` or `≥ 1`)
- Whether Step 2 was executed
- Build result
- Commit SHA (or "skipped, already present")

---

### Task 2: Add `.member-status-row` CSS

**Files:**
- Modify: `app/web/src/styles.css`

- [ ] **Step 1: Append the rules**

Append immediately after Task 1's block (or after `.settings-footer-row` if Task 1 was a no-op):

```css
/* ─── Member Dashboard: compressed status row ─────────── */
.member-status-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 0.8125rem;
}
.member-status-row .lbl {
  color: var(--text-3);
}
```

- [ ] **Step 2: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/member): add .member-status-row CSS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add `.member-hero`, `.member-gauge`, `.member-action` CSS

**Files:**
- Modify: `app/web/src/styles.css`

- [ ] **Step 1: Append the rules**

Append immediately after Task 2's block:

```css
/* ─── Member Dashboard: hero + gauge + action ────────── */
.member-hero {
  text-align: center;
  padding: 8px 0;
}
.member-hero .lbl {
  font-family: var(--mono);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-3);
  margin-bottom: 6px;
}
.member-hero .val {
  font-family: var(--mono);
  font-size: 2rem;
  font-weight: 700;
  color: var(--text);
  line-height: 1.2;
  letter-spacing: -0.01em;
}
.member-hero .val .unit {
  font-size: 0.875rem;
  color: var(--text-3);
  font-weight: 400;
  margin-left: 4px;
}
.member-hero .usd {
  font-family: var(--mono);
  font-size: 1rem;
  color: var(--text-2);
  margin-top: 2px;
}

.member-gauge .labels {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 0.75rem;
  color: var(--text-3);
  font-family: var(--mono);
}
.member-gauge .bar {
  height: 10px;
  border-radius: 5px;
  background: var(--bg-3);
  overflow: hidden;
}
.member-gauge .fill {
  height: 100%;
  border-radius: 5px;
  transition: width 0.3s ease;
}

.member-action {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.member-action .caption {
  text-align: center;
  font-size: 0.6875rem;
  color: var(--text-3);
  font-family: var(--mono);
}
```

- [ ] **Step 2: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/member): add .member-hero, .member-gauge, .member-action CSS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: MemberDashboard.tsx — imports, balance state, handleFund (prep)

Prep work before any markup changes. Between this task and Task 5, the file builds but the new state is unused (consumed in Task 5).

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`

- [ ] **Step 1: Update imports**

Find lines 1–12:

```tsx
import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  api,
  type MemberStats,
  type TreasuryInfo,
  type MemberLiquidityStatusResponse,
  type PendingChannel,
} from "../api/client";
import NodeBalancePanel from "../components/NodeBalancePanel";
import FundNodePanel from "../components/FundNodePanel";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
```

Replace with:

```tsx
import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  api,
  type MemberStats,
  type TreasuryInfo,
  type MemberLiquidityStatusResponse,
  type PendingChannel,
  type NodeBalances,
} from "../api/client";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
```

Changes: remove `NodeBalancePanel` + `FundNodePanel` imports, add `NodeBalances` type.

- [ ] **Step 2: Add state inside the `MemberDashboard` component**

Find the state block inside `export default function MemberDashboard()` (around lines 333–337):

```tsx
  const [stats, setStats] = useState<MemberStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [advisor, setAdvisor] = useState<MemberLiquidityStatusResponse | null>(null);
  const [usdRate, setUsdRate] = useState<number | null>(null);
  const [pendingTreasuryChannel, setPendingTreasuryChannel] = useState(false);
```

Add three new state variables immediately after, on new lines:

```tsx
  const [balances, setBalances] = useState<NodeBalances | null>(null);
  const [fundLoading, setFundLoading] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);
```

- [ ] **Step 3: Add balance-polling useEffect + handleFund**

Find the existing `useEffect` for exchange rate (around line 376, ends with `.catch(() => {});\n  }, []);`). Immediately after it (on a new line), add:

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

This replicates the existing `FundNodePanel` behavior inline (loading state, error special-case for `coinbase_not_configured`, opens URL in a new tab).

- [ ] **Step 4: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0. If the build warns about unused `balances`, `fundLoading`, `fundError`, `handleFund` — that's expected (they're consumed in Task 5).

- [ ] **Step 5: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx
git commit -m "refactor(web/member): add balance state + fund handler (prep)

Prep for replacing NodeBalancePanel + FundNodePanel with the compact
top strip (next commit). Unused until Task 5 consumes it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: MemberDashboard.tsx — replace top panels with compact strip

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`

- [ ] **Step 1: Replace the top section of the return JSX**

Find the block (currently around lines 406–408):

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

Key notes:
- `<NodeBalancePanel />` and `<FundNodePanel />` are gone. `<BitcoinPriceGraph />` preserved.
- Balance field names: `onchain_sats`, `lightning_sats`, `total_sats` (NOT `on_chain_sats` or `channel_sats`).

- [ ] **Step 2: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0. Previous Task 4 unused-variable warnings should clear.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx
git commit -m "feat(web/member): replace NodeBalancePanel+FundNodePanel with compact strip

Matches treasury PR #120 pattern. Hand-rolled inline fetch + Fund CTA
in a single row at the top of the member dashboard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: MemberDashboard.tsx — compress status panel to `.member-status-row`

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`

- [ ] **Step 1: Replace the status block**

Find the current status panel (around lines 413–422):

```tsx
      {/* Membership status */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--text-3)", fontSize: "0.875rem" }}>Membership status</span>
          {loading ? (
            <div className="loading-shimmer" style={{ height: 20, width: 120 }} />
          ) : (
            <span className={`badge ${badge.cls}`}>{badge.text}</span>
          )}
        </div>
      </div>
```

Replace with:

```tsx
      {/* Membership status — compressed row */}
      <div className="member-status-row">
        <span className="lbl">Membership status</span>
        {loading ? (
          <div className="loading-shimmer" style={{ height: 20, width: 120 }} />
        ) : (
          <span className={`badge ${badge.cls}`}>{badge.text}</span>
        )}
      </div>
```

Drops the outer `.panel` wrapper and the `.panel-body` div. Saves ~30px of vertical space.

- [ ] **Step 2: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx
git commit -m "feat(web/member): compress status panel to single-line row

Replaces the .panel + .panel-body ceremony with a thin bordered row.
Same label + badge, ~30px less vertical space.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: MemberDashboard.tsx — apply `.panel.ops` to all channel-state branches + forwarded fees + upgrade banner + loading skeleton

Five className changes across the file. All are one-line edits from `"panel fade-in"` → `"panel ops fade-in"`.

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`

- [ ] **Step 1: Pending channel state**

Find (around line 426, inside the `{noChannel && pendingTreasuryChannel && ...}` block):

```tsx
      {noChannel && pendingTreasuryChannel && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
```

Change to:

```tsx
      {noChannel && pendingTreasuryChannel && (
        <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
```

- [ ] **Step 2: No-channel (ConnectToHub) state**

Find (around line 443, inside the `{noChannel && !pendingTreasuryChannel && ...}` block):

```tsx
      {noChannel && !pendingTreasuryChannel && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
```

Change to:

```tsx
      {noChannel && !pendingTreasuryChannel && (
        <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
```

- [ ] **Step 3: Loading skeleton**

Find (around line 454, inside the `{loading && ...}` block):

```tsx
      {loading && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
```

Change to:

```tsx
      {loading && (
        <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
```

- [ ] **Step 4: Has-channel main panel**

Find (around line 512, inside the `{hasChannel && (() => {...})()}` block, the top of the returned JSX):

```tsx
            <div className="panel fade-in" style={{ marginBottom: 16 }}>
```

Change to:

```tsx
            <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
```

- [ ] **Step 5: Upgrade banner**

Find (around line 634):

```tsx
            {upgradeCapacity && ch && ch.capacity_sats < upgradeCapacity && (
              <div className="panel fade-in" style={{ marginBottom: 16 }}>
```

Change to:

```tsx
            {upgradeCapacity && ch && ch.capacity_sats < upgradeCapacity && (
              <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
```

- [ ] **Step 6: Forwarded Fees Earned panel**

Find (around line 656, the `{(hasChannel || (fees && fees.total_sats > 0)) && ...}` block):

```tsx
      {(hasChannel || (fees && fees.total_sats > 0)) && (
        <div className="panel fade-in">
```

Change to:

```tsx
      {(hasChannel || (fees && fees.total_sats > 0)) && (
        <div className="panel ops fade-in">
```

- [ ] **Step 7: Build + grep verification**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

```bash
grep -c 'className="panel ops fade-in"' app/web/src/pages/MemberDashboard.tsx
```

Expected: `6` occurrences (the 6 className changes above).

```bash
grep -c 'className="panel fade-in"' app/web/src/pages/MemberDashboard.tsx
```

Expected: `0` occurrences (all panel renders in this file are now `.panel.ops`; if any remain, check whether they're inside `ConnectToHub` — those should stay unchanged).

If the second grep returns non-zero, investigate: if it's inside the `ConnectToHub` component (lines 37–325), leave alone. Any other leftover `"panel fade-in"` outside `ConnectToHub` should be changed to `"panel ops fade-in"`.

- [ ] **Step 8: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx
git commit -m "feat(web/member): apply .panel.ops to 6 panels (Briefing Room chrome)

Pending channel, no-channel, loading skeleton, has-channel, upgrade
banner, and forwarded-fees panels all gain amber border-top + tinted
header. ConnectToHub form internals stay unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: MemberDashboard.tsx — extract hero/gauge/action into `.member-*` classes + heroColor + ARIA

Biggest behavior change in the PR. Restructures the has-channel panel's inner markup to use the new CSS classes, adds role-aware hero color, adds ARIA labels.

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`

- [ ] **Step 1: Add `heroColor` derived constant**

Find the block of derived role-aware constants inside the `(() => { ... })()` IIFE (around lines 475–490, inside `{hasChannel && (() => {...})}`):

```tsx
        const role = advisor?.classification?.channelRole ?? "unknown";
        const rec = advisor?.recommendation;
        const isMerchant = role === "merchant";
        const isFarmer = role === "farmer";

        // Role-aware gauge
        // ...
        const gaugeLabel = isMerchant ? "Outbound capacity" : isFarmer ? "Earnings accumulated" : "Channel balance";
        const gaugePct = isMerchant ? localPct : isFarmer ? localPct : localPct;
        const gaugeRemaining = isMerchant
          ? `${localPct}% — ${ch!.local_sats.toLocaleString()} sats available to send`
          : isFarmer
            ? `${localPct}% full — ${ch!.local_sats.toLocaleString()} of ${ch!.capacity_sats.toLocaleString()} sats`
            : `${localPct}% local — ${remotePct}% remote`;
        // Merchant: green=healthy(high local), amber/red=depleting
        // Farmer: green=room to earn(low fill), amber=getting full, red=needs withdrawal
        const gaugeColor = isFarmer
          ? (localPct >= 85 ? "var(--red)" : localPct >= 70 ? "var(--amber)" : "var(--green)")
          : (gaugePct < 15 ? "var(--red)" : gaugePct < 30 ? "var(--amber)" : "var(--green)");
```

Immediately after the `gaugeColor` declaration, add:

```tsx

        // Hero value color: role-aware, same urgency logic as the gauge.
        // Unknown role stays neutral (no signal when we don't know the context).
        const heroColor = role === "unknown" ? "var(--text)" : gaugeColor;
```

- [ ] **Step 2: Replace the hero number block**

Find the hero block inside the panel body (around lines 521–535):

```tsx
                {/* Hero number */}
                <div style={{ textAlign: "center", padding: "8px 0" }}>
                  <div style={{ fontSize: "0.6875rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 6 }}>
                    {heroLabel}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: "2rem", fontWeight: 600, color: "var(--text)", lineHeight: 1.2 }}>
                    {heroSats.toLocaleString()} <span style={{ fontSize: "0.875rem", color: "var(--text-3)", fontWeight: 400 }}>sats</span>
                  </div>
                  {toUsd(heroSats) && (
                    <div style={{ fontFamily: "var(--mono)", fontSize: "1rem", color: "var(--text-2)", marginTop: 2 }}>
                      {toUsd(heroSats)}
                    </div>
                  )}
                </div>
```

Replace with:

```tsx
                {/* Hero number — role-aware color */}
                <div className="member-hero">
                  <div className="lbl">{heroLabel}</div>
                  <div
                    className="val"
                    style={{ color: heroColor }}
                    aria-label={`${heroLabel}: ${heroSats.toLocaleString()} sats`}
                  >
                    {heroSats.toLocaleString()}<span className="unit">sats</span>
                  </div>
                  {toUsd(heroSats) && <div className="usd">{toUsd(heroSats)}</div>}
                </div>
```

Key changes:
- Inline-style soup replaced with `.member-hero` class + children.
- `color` on `.val` takes `heroColor` (role-aware).
- `aria-label` on `.val` reads the label + value as prose.
- "sats" text moved inside a `.unit` span to inherit the `.member-hero .val .unit` style.

- [ ] **Step 3: Replace the gauge block**

Find (around lines 538–554):

```tsx
                {/* Capacity gauge */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: "0.75rem", color: "var(--text-3)" }}>
                    <span>{gaugeLabel}</span>
                    <span>{gaugeRemaining}</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "var(--bg-3)", overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${gaugePct}%`,
                        background: gaugeColor,
                        borderRadius: 4,
                        transition: "width 0.3s ease",
                      }}
                    />
                  </div>
                </div>
```

Replace with:

```tsx
                {/* Capacity gauge — role-aware color, ARIA progressbar */}
                <div
                  className="member-gauge"
                  role="progressbar"
                  aria-valuenow={gaugePct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={gaugeLabel}
                >
                  <div className="labels">
                    <span>{gaugeLabel}</span>
                    <span>{gaugeRemaining}</span>
                  </div>
                  <div className="bar">
                    <div className="fill" style={{ width: `${gaugePct}%`, background: gaugeColor }} />
                  </div>
                </div>
```

Key changes:
- Inline-style soup replaced with `.member-gauge` + `.labels` + `.bar` + `.fill` classes.
- `role="progressbar"` with `aria-valuenow`/`aria-valuemin`/`aria-valuemax`/`aria-label` on the outer div.

- [ ] **Step 4: Replace the Farmer cash-out action block**

Find (around lines 586–600):

```tsx
                {/* Farmer: withdraw action */}
                {isFarmer && ch!.local_sats >= 250_000 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button
                      className="btn btn-primary"
                      style={{ width: "100%" }}
                      onClick={() => navigate(isFarmer ? cashOutUrl : refillUrl)}
                    >
                      {isFarmer ? "Cash Out Earnings →" : "Refill Channel →"}
                    </button>
                    <div style={{ textAlign: "center", fontSize: "0.6875rem", color: "var(--text-3)" }}>
                      Estimated fee: ~{estWithdrawalFee.toLocaleString()} sats
                      {toUsd(estWithdrawalFee) && ` (${toUsd(estWithdrawalFee)})`}
                    </div>
                  </div>
                )}
```

Replace with:

```tsx
                {/* Farmer: withdraw action */}
                {isFarmer && ch!.local_sats >= 250_000 && (
                  <div className="member-action">
                    <button
                      className="btn btn-primary"
                      style={{ width: "100%" }}
                      onClick={() => navigate(cashOutUrl)}
                    >
                      Cash Out Earnings →
                    </button>
                    <div className="caption">
                      Estimated fee: ~{estWithdrawalFee.toLocaleString()} sats
                      {toUsd(estWithdrawalFee) && ` (${toUsd(estWithdrawalFee)})`}
                    </div>
                  </div>
                )}
```

Key changes:
- Outer `<div>` now uses `.member-action` class.
- Caption uses `.caption` class (child of `.member-action`).
- Button text simplified: since this branch only fires when `isFarmer` is true, the ternary was redundant — hardcode "Cash Out Earnings →" + `cashOutUrl`.

- [ ] **Step 5: Build + sanity checks**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

```bash
grep -c "member-hero" app/web/src/pages/MemberDashboard.tsx
```

Expected: `1` (the hero div).

```bash
grep -c "member-gauge" app/web/src/pages/MemberDashboard.tsx
```

Expected: `1` (the gauge div).

```bash
grep -c "member-action" app/web/src/pages/MemberDashboard.tsx
```

Expected: `1` (the action div).

```bash
grep -c "heroColor" app/web/src/pages/MemberDashboard.tsx
```

Expected: `2` (declaration + usage on the hero `.val` element).

- [ ] **Step 6: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx
git commit -m "feat(web/member): extract hero/gauge/action into CSS classes, role-aware hero color

- Hero: .member-hero + aria-label as prose, role-aware color via heroColor
- Gauge: .member-gauge + ARIA progressbar with valuenow/valuemin/valuemax
- Action: .member-action for farmer cash-out button + caption
- Removes inline-style soup from the has-channel panel

Hero color now signals urgency:
- Merchant low local = red (refill needed)
- Farmer high local = red (cash out now)
- Unknown = neutral

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Version bump

Bump patch version on both Umbrel manifest files. Include in the same PR as code (per v1.12.1 lesson).

**Files:**
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

- [ ] **Step 1: Check the current version on main**

Run:
```bash
grep -nE "^version:" bitcorn-lightning-node/umbrel-app.yml
```

Record the current version. It should be either `1.13.1` (if Treasury PR #120 hasn't merged) or `1.13.2` (if it has). Bump the patch digit by one.

If the version is unexpected (e.g. `1.14.x` or `1.12.x`), STOP and report as NEEDS_CONTEXT.

Substitute `<NEW>` (the target version) and `<OLD>` (the current version) in the rest of this task.

- [ ] **Step 2: Bump version in umbrel-app.yml**

Find:
```yaml
version: "<OLD>"
```
Replace with:
```yaml
version: "<NEW>"
```

- [ ] **Step 3: Prepend release-notes paragraph**

Find `releaseNotes: >`. The first paragraph inside it currently starts with `v<OLD>: …`. Insert ABOVE it:

```yaml
  v<NEW>: Member Dashboard polish. Compact top strip (on-chain /
  channel / total balances + Fund Node CTA inline, matching treasury).
  Role-aware channel panel gains Briefing Room chrome (amber border-top
  + tinted header); hero number's color now follows role-aware urgency
  (merchant: low = red, farmer: high = red, unknown: neutral). Status
  row compressed to a single line. Forwarded Fees panel and pending /
  no-channel / upgrade states inherit the same chrome. No backend
  changes.
```

Preserve 2-space YAML indentation. Do NOT delete the existing v<OLD> paragraph.

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

```bash
grep -nE "^version:|v<NEW>|api:<NEW>|web:<NEW>|api:<OLD>|web:<OLD>" bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml | head -12
```

Expected: new version in both files, new release-notes line, no remaining old-version image tags (old version should persist only in the preserved release-notes paragraph).

- [ ] **Step 6: Commit**

```bash
git add bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
git commit -m "chore: bump to v<NEW> for Member Dashboard polish

Umbrel manifest + compose image tags bumped together. Release notes
for v<NEW> prepended.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Visual verification (human)

No code changes expected. Final pre-PR verification.

- [ ] **Step 1: Clean build**

```bash
cd app/web && npm run build
```

Expected: exit 0, no TypeScript warnings about unused imports.

- [ ] **Step 2: Dev server + manual check**

```bash
cd app/web && npm run dev
# or: VITE_API_BASE=http://<umbrel-ip>:3101 npm run dev
```

As member role, test:
- Dark theme, `/dashboard` — verify compact top strip, compressed status row, `.panel.ops` chrome on channel panel + forwarded fees, centered hero with role-aware color, gauge, action button (if farmer with ≥ 250k).
- Light theme, `/dashboard` — same.
- If possible: farmer with high local% — hero + gauge red.
- If possible: merchant with low local% — hero + gauge red.
- If possible: no-channel state (ConnectToHub form inside `.panel.ops` wrapper).

Save screenshots for the PR body.

As treasury role, smoke-test:
- `/dashboard` — should be unchanged from PR #120's state. This PR does not touch treasury.

- [ ] **Step 3: Fix any visual issues**

If a visual issue surfaces (spacing, contrast, ConnectToHub form clash with `.panel.ops` chrome), fix inline. Commit as `fix(web/member): <what>`. If none, skip to Task 11.

---

### Task 11: Push + open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/ui-dashboard-member
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --title "feat(web/member): Balanced Member polish (v<NEW>)" --body "$(cat <<'EOF'
## Summary

Member Dashboard polish — the fourth page from the UI polish brief after Settings (v1.12.1), Wizard (v1.13.1), and Treasury Dashboard (v1.13.2 via PR #120).

- **Compact top strip** replaces \`<NodeBalancePanel />\` + \`<FundNodePanel />\` with a hand-rolled row (On-chain / Channel / Total + Fund Node CTA). Matches the treasury pattern from PR #120.
- **Status row** compressed from a panel-wrapped block to a single thin bordered row. Same label + badge, ~30px less vertical space.
- **Briefing Room chrome** (\`className="panel ops"\`) applied to all 6 channel-state panels: pending, no-channel, loading skeleton, has-channel, upgrade banner, forwarded fees.
- **Role-aware hero color** — the big centered "Available to send" / "Available to withdraw" / "Your balance" number now carries the same urgency color as the gauge: merchant low = red (refill needed), farmer high = red (cash out now), unknown = neutral.
- **Extracted CSS classes** — \`.member-hero\`, \`.member-gauge\`, \`.member-action\`, \`.member-status-row\` replace inline-style soup for the channel panel internals.
- **ARIA** — hero value gets a prose \`aria-label\`, gauge gets \`role="progressbar"\` with \`aria-valuenow\`/\`aria-valuemin\`/\`aria-valuemax\`/\`aria-label\`.
- **No backend changes.** Uses existing \`api.getMemberStats\`, \`getMemberLiquidityStatus\`, \`getExchangeRate\`, \`getPendingChannels\`, \`getTreasuryInfo\`, \`getNodeBalances\`, \`getCoinbaseOnrampUrl\`.

Spec: \`docs/superpowers/specs/2026-04-23-dashboard-member-polish-design.md\`
Plan: \`docs/superpowers/plans/2026-04-23-dashboard-member-polish-implementation.md\`

Completes the dashboard polish — Treasury was PR #120, Member is this PR.

## Version

**v<NEW>** on top of whatever main was at when this PR was cut.

## Do-not-touch discipline

No changes to \`Dashboard.tsx\` (treasury), \`NodeBalancePanel\`, \`FundNodePanel\`, \`BitcoinPriceGraph\`, \`ConnectToHub\` form internals, \`ValuationInput.tsx\`, \`AutoBuy.tsx\`, \`components/autoBuy/*\`, \`api/client.ts\`, \`cloudflare-worker/*\`, or anything under \`app/api/\`.

## Test plan

- [x] \`cd app/web && npm run build\` clean after every commit
- [x] Dark + light theme both visually verified on \`/dashboard\`
- [x] Farmer high-local: hero + gauge red
- [x] Merchant (if reachable): hero + gauge logic role-inverted from farmer
- [x] No-channel state: ConnectToHub form renders inside \`.panel.ops\` wrapper without visual clash
- [x] Treasury \`/dashboard\` unaffected (smoke-tested)
- [x] Balance strip polls every 60s (matches pre-existing NodeBalancePanel cadence)
- [x] Fund button opens Coinbase URL / shows inline error if not configured

## Screenshots

(attach: member + dark + farmer-healthy, member + light + farmer-healthy, member + one-other-state)

## Post-merge

1. Wait for \`Build and publish Docker images\` workflow (~5 min).
2. On Umbrel: \`cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0 && git pull\`
3. Hard-refresh Umbrel browser UI — v<NEW> update prompt appears.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Substitute `<NEW>` in the `--title` string with the actual version chosen in Task 9.

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

- Task 1's conditional CSS add handles the PR #120 coordination — grep-first, skip if class already present. Rebase on top of post-#120 main would find the class and make Task 1 a no-op.
- Task 4's balance-polling + `handleFund` is copy-pasted verbatim from treasury's implementation. If the treasury pattern needs to change later, both call sites update in parallel — acceptable given the duplication is 15 lines.
- Task 7 touches 5 panels' classNames (6 occurrences counting the upgrade banner). Each is a one-line edit; combined into one commit because they're a single concept ("apply Briefing Room chrome everywhere in this file").
- Task 8 is the biggest behavioral change: hero color + extracted CSS classes + ARIA. Worth a full two-stage review from the controlling agent after commit.
- `isMerchant`, `isFarmer`, `role`, `ch`, `advisor`, `rec`, etc. are all existing derived variables inside the `(() => { ... })()` IIFE that wraps the has-channel panel — no new state needed.
- The farmer-only conditional for cash-out action includes the `{isFarmer && ch!.local_sats >= 250_000}` guard; Task 8's rewrite simplified the button text from a ternary to a literal since the guard already enforces farmer-only.
