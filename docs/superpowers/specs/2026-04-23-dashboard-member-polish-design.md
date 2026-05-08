# Member Dashboard Polish — "Balanced Member" Design

- **Date:** 2026-04-23
- **Branch:** `feature/ui-dashboard-member` (off `main`)
- **Target version:** `v1.13.X+1` patch — determined at commit time based on main's current version (likely `v1.13.3` if Treasury Dashboard PR #120 is merged, else `v1.13.2`).
- **Scope:** `app/web/src/pages/MemberDashboard.tsx` + `app/web/src/styles.css`.

## Mission

Apply the Briefing Room aesthetic direction to the member dashboard symmetrically with the treasury PR #120. Compact top strip replacing the stacked `NodeBalancePanel` + `FundNodePanel` components, `.panel.ops` chrome on the channel panel + forwarded-fees panel, role-aware hero-color signaling, extracted CSS classes replacing inline-style soup. Preserve all conditional branching logic (merchant / farmer / unknown × pending / none / active channel) exactly as-is.

## Context

The member dashboard is the daily landing page for a non-treasury node. Today it stacks a verbose top chrome (NodeBalance + FundNode + BitcoinPriceGraph, each a full panel) followed by a status row, a role-aware channel panel (with conditional branches for the three channel states), an optional upgrade banner, and a forwarded-fees panel. The page is already information-dense — the brief calls it out as "lots of conditional panels based on channel state" — which is a feature; the polish target is aesthetic coherence, not restructure.

This is the fourth page after Settings (v1.12.1), Wizard (v1.13.1), and Treasury Dashboard (v1.13.2) in the polish brief's attack order. It directly mirrors the treasury dashboard's pattern where sensible; it respects member-specific nuances (role-aware content, channel-state conditionals, centered rather than left-aligned hero).

## Non-goals (explicitly out of scope)

- No changes to `app/web/src/pages/Dashboard.tsx` (treasury) — its own polish landed in PR #120.
- No changes to `NodeBalancePanel.tsx` or `FundNodePanel.tsx`. After this PR, they're no longer imported by either dashboard page. They remain in the repo; their cleanup is a follow-up decision.
- No changes to `BitcoinPriceGraph.tsx` — already shortened to 120px by PR #120. Member inherits this automatically.
- No changes to the `ConnectToHub` component internals (the ~290-line form). Only its outer panel wrapper's className changes; the form markup inside stays identical.
- No backend changes. Reuses existing API methods: `api.getMemberStats`, `api.getMemberLiquidityStatus`, `api.getExchangeRate`, `api.getPendingChannels`, `api.getTreasuryInfo`, `api.getNodeBalances`, `api.getCoinbaseOnrampUrl`.
- No changes to the role-aware branching logic (merchant / farmer / unknown) or the channel-state logic (pending / no channel / has channel). All existing conditionals stay bit-for-bit.
- No changes to `AutoBuy.tsx`, `Wizard.tsx`, Settings pages, `ValuationInput.tsx`, `cloudflare-worker/*`, or anything under `app/api/`.
- No new components, no new routes, no new API client methods.

## Page structure

Same information architecture as today; different chrome. Eight visible blocks on the most common happy path:

```
My Dashboard
Your connection to the Bitcorn Lightning hub

[.dashboard-top-strip]
  On-chain: 1,250,000  |  Channel: 8,750,000  |  Total: 10,000,000 sats    [Fund Node →]

[BitcoinPriceGraph panel — 120px via PR #120]

[.member-status-row: "Membership status" · Active Member badge]

[Channel panel (.panel ops) — one of three states]
  State A (no channel, pending open):
    "Channel Opening Submitted" alert
  State B (no channel, no pending):
    <ConnectToHub /> form
  State C (has channel):
    Hero number (centered, role-aware color)
    Role-aware gauge
    Advisor alert (conditional)
    Role-not-set prompt (conditional)
    Action button (farmer cash-out, conditional)
    <details>Channel details</details>

[Upgrade banner (.panel ops) — if ?upgrade_capacity URL param present]

[Forwarded Fees Earned (.panel ops)]
  3-stat grid: Last 24h | Last 30d | All Time
```

## Top strip — hand-rolled, matching treasury

Identical pattern to `app/web/src/pages/Dashboard.tsx` after PR #120. Replaces today's `<NodeBalancePanel />` + `<FundNodePanel />` stack with:

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
  <button className="btn btn-primary" onClick={handleFund} disabled={fundLoading}>
    {fundLoading ? "Opening…" : "Fund Node →"}
  </button>
  {fundError && <div className="fund-error">{fundError}</div>}
</div>
```

Reused state + handler (copy the treasury pattern verbatim):
- `const [balances, setBalances] = useState<NodeBalances | null>(null);`
- `const [fundLoading, setFundLoading] = useState(false);`
- `const [fundError, setFundError] = useState<string | null>(null);`
- A `useEffect` polling `api.getNodeBalances()` every 60s.
- An `async function handleFund()` that calls `api.getCoinbaseOnrampUrl()` and opens the URL in a new tab, with `"coinbase_not_configured"` special-case error handling.

### CSS dependency on PR #120

The `.dashboard-top-strip` class and its children were added to `app/web/src/styles.css` in PR #120. Two cases:

- **PR #120 merges first** → the class already exists on main; member's rebase finds it; no CSS work needed in this PR.
- **This PR merges first** → the class doesn't exist on main yet; this PR's plan includes adding the CSS rules as a task. If #120 is later rebased onto main and the class already exists, the rebase drops the duplicate CSS task as a no-op (same pattern git used on my wizard-spec rebase).

The implementation plan **includes the CSS class rules as a conditional task** — implementer first greps `styles.css` for `.dashboard-top-strip`; if present, skips the task; if absent, adds it.

## Status row — compressed (no panel wrapper)

Today: `<div className="panel fade-in">` containing a `.panel-body` with "Membership status" label + `<span className={\`badge ${badge.cls}\`}>{badge.text}</span>`.

Polished: compressed to a single bordered row with no header/body layering. New CSS class:

```css
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
.member-status-row .lbl { color: var(--text-3); }
```

Markup becomes:

```tsx
<div className="member-status-row">
  <span className="lbl">Membership status</span>
  {loading ? (
    <div className="loading-shimmer" style={{ height: 20, width: 120 }} />
  ) : (
    <span className={`badge ${badge.cls}`}>{badge.text}</span>
  )}
</div>
```

Saves ~30px vertical space vs today's panel wrapper. Reads at a glance: label + badge inline.

## Channel panel — three states, `.panel.ops` chrome

All three state branches use `className="panel ops fade-in"` (change from today's `"panel fade-in"`). Inner content of each branch described below.

### State A — no channel, pending open

Change to:
```tsx
<div className="panel ops fade-in" style={{ marginBottom: 16 }}>
  <div className="panel-header">
    <span className="panel-title"><span className="icon">◈</span>Connect to Hub</span>
  </div>
  <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div className="alert healthy" style={{ marginBottom: 0 }}>
      <span className="alert-icon">✓</span>
      <div className="alert-body">
        <div className="alert-type">Channel Opening Submitted</div>
        <div className="alert-msg">
          Your channel to the hub is being broadcast. It will become active after 1–3 on-chain confirmations. This page will update automatically.
        </div>
      </div>
    </div>
  </div>
</div>
```

Only change vs today: `"panel fade-in"` → `"panel ops fade-in"`.

### State B — no channel, no pending

Change only the outer className: `"panel fade-in"` → `"panel ops fade-in"`. `<ConnectToHub>` form inside stays identical.

### State C — has channel (the biggest block)

This is the main has-channel panel. Role-aware content driven by `advisor?.classification?.channelRole` — one of `"merchant"` / `"farmer"` / `"unknown"`.

**Role-aware derived values** (all already computed in the component today; no logic changes):

| Variable | Merchant | Farmer | Unknown |
|---|---|---|---|
| `panelTitle` | "Merchant Channel" | "Your Earnings" | "Your Channel" |
| `heroLabel` | "Available to send" | "Available to withdraw" | "Your balance" |
| `heroSats` | `ch.local_sats` | `ch.local_sats` | `ch.local_sats` |
| `gaugeLabel` | "Outbound capacity" | "Earnings accumulated" | "Channel balance" |
| `gaugePct` | `localPct` | `localPct` | `localPct` |
| `gaugeColor` | `localPct < 15 ? red : localPct < 30 ? amber : green` | `localPct >= 85 ? red : localPct >= 70 ? amber : green` | same as merchant |

**New: `heroColor`** — computed once, reused for the hero value color:

```tsx
const heroColor = role === "unknown" ? "var(--text)" : gaugeColor;
```

For merchant: low hero = red (can't send, needs refill). High hero = green (healthy send capacity).
For farmer: high hero = red (channel full, cash out now). Low hero = green (earning room).
For unknown: hero stays `var(--text)`.

**Panel markup**:

```tsx
<div className="panel ops fade-in" style={{ marginBottom: 16 }}>
  <div className="panel-header">
    <span className="panel-title"><span className="icon">◈</span>{panelTitle}</span>
    <span className={`badge ${ch!.is_active ? "badge-green" : "badge-muted"}`}>
      {ch!.is_active ? "active" : "inactive"}
    </span>
  </div>
  <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <div className="member-hero">
      <div className="lbl">{heroLabel}</div>
      <div
        className="val"
        style={{ color: heroColor }}
        aria-label={`${heroLabel}: ${heroSats.toLocaleString()} sats`}
      >
        {heroSats.toLocaleString()}
        <span className="unit">sats</span>
      </div>
      {toUsd(heroSats) && <div className="usd">{toUsd(heroSats)}</div>}
    </div>

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

    {showAlert && (
      <div className={`alert ${alertClass}`} style={{ marginBottom: 0 }}>
        <span className="alert-icon">{alertIcon}</span>
        <div className="alert-body">
          <div className="alert-msg">{rec!.reason}</div>
        </div>
      </div>
    )}

    {role === "unknown" && (
      <div className="alert info" style={{ marginBottom: 0 }}>
        <span className="alert-icon">◈</span>
        <div className="alert-body">
          <div className="alert-msg">Set your channel role to get tailored capacity recommendations.</div>
          <button
            className="btn btn-outline"
            style={{ marginTop: 8, fontSize: "0.75rem" }}
            onClick={() => navigate("/settings")}
          >
            Set Role in Settings →
          </button>
        </div>
      </div>
    )}

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
    {isFarmer && ch!.local_sats > 0 && ch!.local_sats < 250_000 && (
      <div style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text-3)" }}>
        Minimum withdrawal: 250,000 sats. You have {ch!.local_sats.toLocaleString()} sats.
      </div>
    )}

    <details style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
      <summary style={{ cursor: "pointer", userSelect: "none" }}>Channel details</summary>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Channel capacity</span>
          <span style={{ fontFamily: "var(--mono)" }}>{ch!.capacity_sats.toLocaleString()} sats</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Your balance (outbound)</span>
          <span style={{ fontFamily: "var(--mono)" }}>{ch!.local_sats.toLocaleString()} sats</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Receiving capacity (inbound)</span>
          <span style={{ fontFamily: "var(--mono)" }}>{ch!.remote_sats.toLocaleString()} sats</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Channel role</span>
          <span style={{ fontFamily: "var(--mono)", textTransform: "capitalize" }}>{role}</span>
        </div>
      </div>
    </details>
  </div>
</div>
```

### New CSS for the channel panel internals

Extracted from today's inline-style soup. New rules in `styles.css`:

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

## Upgrade banner — `.panel.ops` chrome

Today: `<div className="panel fade-in">` rendered when `upgradeCapacity && ch && ch.capacity_sats < upgradeCapacity`. Change to `"panel ops fade-in"`; inner `.alert.info` + `<ConnectToHub>` unchanged.

## Forwarded Fees panel

Today: `<div className="panel fade-in">` with header + 3-stat grid (24h / 30d / all-time). Change to `"panel ops fade-in"`; inner content unchanged. Three `.stat-card` entries stay — this is the right treatment for 3 equal-weight time-windowed metrics (same decision as the treasury dashboard's 3 stat cards at the bottom of the Revenue panel).

## Loading state

When `loading` is true and neither `hasChannel` nor `noChannel` has resolved yet, today's code renders a `<div className="panel fade-in">` skeleton. Change to `"panel ops fade-in"` so the skeleton's outer chrome matches the real channel panel — avoids a visual flash when loading completes.

## Accessibility

- Hero value: `aria-label="${heroLabel}: ${heroSats.toLocaleString()} sats"` so screen readers read it as prose.
- Gauge: `role="progressbar"` with `aria-valuenow={gaugePct}`, `aria-valuemin={0}`, `aria-valuemax={100}`, `aria-label={gaugeLabel}`.
- Top strip: balance items are plain text; no ARIA needed.
- Status row: plain text + badge; no additional ARIA.
- Advisor alert / role-not-set prompt: keep existing (no ARIA today).

## Theme compatibility

All new styles use CSS vars (`--bg-1`, `--bg-2`, `--bg-3`, `--border`, `--text`, `--text-2`, `--text-3`, `--amber`, `--amber-dim`, `--amber-glow`, `--amber-glow2`, `--green`, `--red`, `--mono`, `--sans`, `--radius`, `--radius-lg`). Both dark and light mode auto-adapt. Specific visual checks in both themes:

- Amber border-top + tinted header on `.panel.ops` panels (already validated on Settings / Wizard / Treasury).
- Hero value color in green / amber / red tiers — already validated on Treasury (same tokens).
- Compact top strip reads correctly (already validated on Treasury).
- Gauge fill color tiers — reused from today's existing code; no new colors.

## Risks

1. **Hero color may "double up" with gauge color.** Both encode the same role-aware urgency. Mitigation: intentional — the hero is the first-glance answer; doubling up makes urgent states unmissable. If it feels over-saturated in visual check, drop to `var(--text)` on the `neutral` tier and keep amber/red only for warnings.
2. **Top strip duplicates treasury's fetch code.** Same ~15 lines of `useEffect` + `handleFund` copy-pasted from `Dashboard.tsx`. Acceptable for scope isolation; revisit via a shared hook if a third compact consumer appears.
3. **ConnectToHub form visual mismatch inside `.panel.ops`.** The form's internal styling may conflict with the amber border-top when rendered inside the newly-chromed wrapper. Verify in visual check; if clash, drop the `ops` modifier from the "no channel" state wrapper only (back to plain `.panel`).
4. **CSS coordination with PR #120.** The `.dashboard-top-strip` class is shared. Implementer's plan includes a grep-first step: add the CSS only if not already on main (either from PR #120 merging ahead, or from this PR rebasing onto post-#120 main).

## Implementation surface

Files modified:

- `app/web/src/pages/MemberDashboard.tsx` — imports (drop `NodeBalancePanel`, `FundNodePanel`; add `NodeBalances` type), add balance/fund state + polling effect + handler (copy the treasury pattern), replace top-panel section with compact strip, replace status row with `.member-status-row`, apply `"panel ops fade-in"` to all three channel-state branches + upgrade banner + forwarded fees, extract hero / gauge / action inline-style soup into new CSS classes.
- `app/web/src/styles.css` — conditionally add `.dashboard-top-strip` (only if not already present from PR #120). Always add `.member-status-row`, `.member-hero` + children, `.member-gauge` + children, `.member-action` + children. ~60 lines of CSS.
- `bitcorn-lightning-node/umbrel-app.yml` — version bump + release-notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — both `api:` and `web:` image tags bumped.

Files NOT modified:

- `app/web/src/pages/Dashboard.tsx` — treasury, untouched here.
- `app/web/src/components/NodeBalancePanel.tsx`, `FundNodePanel.tsx` — no imports from MemberDashboard after this PR, but files stay.
- `app/web/src/components/BitcoinPriceGraph.tsx` — unchanged (already 120px via PR #120).
- `app/web/src/components/ValuationInputAlertBanner.tsx` — unused in member (was already not imported); unchanged.
- `ConnectToHub` internal form markup — only its outer panel's className changes.
- `api/client.ts`, `App.tsx`, anything under `components/autoBuy/` / `cloudflare-worker/` / `app/api/`.

## Release notes line (version filled at commit time)

> **v1.13.X** — Member Dashboard polish. Compact top strip (on-chain / channel / total balances + Fund Node CTA inline, matching treasury). Role-aware channel panel gains Briefing Room chrome (amber border-top + tinted header); hero number's color now follows role-aware urgency (merchant: low = red; farmer: high = red; unknown: neutral). Status row compressed to a single line. Forwarded Fees panel and pending / no-channel / upgrade states inherit the same chrome. No backend changes.

## PR checklist (per polish brief)

- [ ] Before + after screenshots attached.
- [ ] Dark + light theme both tested + attached.
- [ ] Visual check covers multiple states: farmer healthy, farmer filling up (high hero red), merchant healthy, merchant low-local (low hero red), no-channel (ConnectToHub), pending state.
- [ ] `cd app/web && npm run build` clean.
- [ ] Version bumped in both `bitcorn-lightning-node/umbrel-app.yml` and `bitcorn-lightning-node/docker-compose.yml` in the same push as final code.
- [ ] Release-notes paragraph added to `umbrel-app.yml`.
