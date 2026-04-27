# Treasury Dashboard Polish — "Compact & Hero" Design

- **Date:** 2026-04-23
- **Branch:** `feature/ui-dashboard-treasury` (off `main`)
- **Target version:** `v1.13.X+1` patch — determined at commit time based on main's current version (likely `v1.13.2` if Wizard PR #119 is merged, else `v1.13.1`).
- **Scope:** `app/web/src/pages/Dashboard.tsx` + `app/web/src/components/BitcoinPriceGraph.tsx` + `app/web/src/styles.css`.

## Mission

Polish the treasury Dashboard with three lead concerns: reduce above-the-fold information density, give the Revenue panel a hero number that answers "am I making money right now" at a glance, and convert the revenue table rows into the Briefing Room `.policy-card` vocabulary shared with Settings and Wizard. No backend changes.

## Context

The treasury Dashboard is the daily landing page for the hub operator. Today it stacks roughly eight vertical panels (Node Balance, Fund Node, Bitcoin Price chart, Valuation banner, alerts, Treasury Revenue with an internal table + 3 stat cards). Revenue — the page's actual center of gravity per the brief — doesn't show up until after significant scrolling, and when it does show up it reads as a generic data table rather than a "performance report" with a clear headline number.

This PR is the second page after Settings + Wizard in the polish brief's attack order. MemberDashboard polish lands in a follow-up PR.

## Non-goals (explicitly out of scope)

- No changes to `app/web/src/pages/MemberDashboard.tsx` — that's its own PR.
- No changes to `app/web/src/components/NodeBalancePanel.tsx` or `FundNodePanel.tsx`. Dashboard.tsx hand-rolls its own compact top strip and calls the underlying API endpoints directly. MemberDashboard keeps using those components unchanged.
- No changes to `app/web/src/components/ValuationInputAlertBanner.tsx` or the alert list rendering — kept between the top strip and the Revenue panel.
- No backend changes. Reuses existing endpoints: `api.getTreasuryMetrics`, `api.getAlerts`, `api.getNodeBalances`, `api.getCoinbaseOnrampUrl`.
- No changes to anything on `docs/UI_CONVENTIONS.md`'s do-not-touch list.
- No new API client methods, no new routes, no new components outside Dashboard.tsx.

## Page structure

The current page has roughly eight stacked panels. The polished page has five visible blocks:

```
Treasury Dashboard
Capital allocation engine

[.dashboard-top-strip]
  On-chain: 2,450,000  |  Channel: 48,750,000  |  Total: 51,200,000 sats    [Fund Node →]

[BitcoinPriceGraph panel — chart body 120px instead of 220px]

[ValuationInputAlertBanner — if stale]
[Active alerts list — if any]

[Revenue panel (.panel ops)]
  HERO: +12,450  sats · 24h net      [ALL-TIME +485,280 sats]
  ───
  Forwarding fees       24h · earned on routed payments · all-time +520,450          +13,280 sats
  Rebalance costs       24h · paid to rebalance ops · all-time −35,170  −830 sats
  ───
  [Stat cards row: Capital Deployed | Active Channels | Revenue Yield]
```

## Top strip (hand-rolled in `Dashboard.tsx`)

Replaces today's `<NodeBalancePanel />` + `<FundNodePanel />` back-to-back stack with a single row.

### CSS

New rule in `styles.css`:

```css
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
```

### Behavior

- `Dashboard.tsx` adds a `useState<NodeBalances | null>(null)` + `useEffect` that calls `api.getNodeBalances()` on mount and every 60s (same pattern as the existing `getAlerts` polling in the file).
- Three balance items: **On-chain** (`on_chain_sats`), **Channel** (`channel_sats`), **Total** (`total_sats`). Labels render in `--text-3`, values in mono weight 700, `sats` unit subscripted.
- Fund button is a `.btn .btn-primary` that calls `api.getCoinbaseOnrampUrl()` in an async handler and opens the URL in a new tab. Text: `Fund Node →`.
- Loading state: balance values show `—` placeholder (no shimmer — small strip, shimmer would be overkill).

## BitcoinPriceGraph — chart height change

Single-line edit in `app/web/src/components/BitcoinPriceGraph.tsx`:

- Find `<ResponsiveContainer width="100%" height={220}>` and change `height={220}` to `height={120}`.
- All other code in the file unchanged. `<YAxis>` retains its `width={54}` and tick configuration; Recharts auto-distributes ticks based on available height (approximately 3 ticks at 120px, 5 at 220px). `<XAxis>` tick sampling (`sampleTicks`) is height-agnostic.
- Loading-state shimmer height (`style={{ height: 200 }}`) could be changed to `100` for visual consistency, but is acceptable to leave — the shimmer is only visible for <1s.

This change affects MemberDashboard too (which also uses `<BitcoinPriceGraph />`). Acceptable — the brief calls member "dense", and a shorter chart benefits both.

## Revenue panel

Replaces today's `<div className="panel fade-in">` with the Briefing Room operational variant, a hero number, policy-card rows, and a stat-card row.

### Panel chrome

```tsx
<div className="panel ops fade-in" style={{ marginBottom: 16 }}>
  <div className="panel-header">
    <span className="panel-title"><span className="icon">◈</span>Treasury Revenue</span>
    {!loading && activeAlerts.length === 0 && (
      <span className="badge badge-green">All systems healthy</span>
    )}
  </div>
  <div className="revenue-hero">
    {/* hero number + caption + all-time badge */}
  </div>
  <div className="panel-body">
    {/* 2 policy cards + stat cards */}
  </div>
</div>
```

`className="panel ops"` activates the amber border-top + amber-tinted header + amber-dim title rules already defined in `styles.css` (from the Settings polish PR).

### Hero number block

New CSS in `styles.css`:

```css
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

### Sign rendering

- Positive net: render as `+12,450`. Prepend an explicit ASCII `+`.
- Negative net: render as `−830`. Use Unicode minus sign `U+2212` (not ASCII hyphen) for typographic alignment with the positive case. `Math.abs(n).toLocaleString()` handles the digits.
- Zero net: render as `0` with no sign. Class: `.revenue-hero-num.neutral`.

Implementation helper in `Dashboard.tsx`:

```tsx
function formatSigned(n: number): { text: string; cls: "positive" | "negative" | "neutral" } {
  if (n > 0) return { text: `+${n.toLocaleString()}`, cls: "positive" };
  if (n < 0) return { text: `−${Math.abs(n).toLocaleString()}`, cls: "negative" };
  return { text: "0", cls: "neutral" };
}
```

### ARIA on hero

```tsx
<span
  className={`revenue-hero-num ${cls}`}
  aria-label={`24 hour net revenue: ${cls === "positive" ? "plus " : cls === "negative" ? "minus " : ""}${Math.abs(n).toLocaleString()} sats`}
>
  {text}
</span>
```

### Revenue rows as policy cards

Two `.policy-card` rows inside `.panel-body`:

```tsx
<div className="policy-card" style={{ cursor: "default" }}>
  <div>
    <div className="policy-card-label">Forwarding fees</div>
    <div className="policy-card-meta">24h · earned on routed payments · all-time {formatSigned(mAll?.forwarded_fees_sats ?? 0).text}</div>
  </div>
  <div className="policy-card-value" style={{ color: "var(--green)" }}>
    {formatSigned(m24?.forwarded_fees_sats ?? 0).text}
    <span className="unit">sats</span>
  </div>
</div>
```

Second card is identical structure for `rebalance_costs_sats`, except the value color is `var(--red)` and the meta line reads `"24h · paid to rebalance ops · all-time ${allTimeCost}"`.

Both cards use `cursor: "default"` inline override to cancel the `cursor: pointer` default set by `.policy-card` in Settings (cards here are read-only, not clickable).

### Stat cards

Exactly today's layout — a `.stat-card` flex row containing three cards:

| Stat | Value | Sub |
|---|---|---|
| Capital Deployed | `sats(cap?.capital_deployed_sats)` | sats |
| Active Channels | `liq?.active_count` | of `liq?.total_count` total |
| Revenue Yield | `fmt(Math.round(cap?.revenue_yield))` green/red | sats per 1M deployed |

No class changes. No markup changes. Keeps the existing `sats()` and `fmt()` helpers at the top of `Dashboard.tsx`.

### Loading and error states

- Loading: three `.loading-shimmer` rows (48px height, 6px border-radius) inside `.panel-body`, matching today's behavior but sized to match the new policy-card heights.
- Empty (`!metrics`): a single `.empty-state` div with the existing "Unable to load treasury metrics." message inside `.panel-body`. The hero block is not rendered when metrics is null.

## Accessibility

- Hero number: `aria-label="24 hour net revenue: plus 12,450 sats"` (or "minus" / no sign word) so screen readers read it as prose, not as `+12,450`.
- All-time badge: `aria-label="all time net revenue: plus 485,280 sats"` — same prose-reading pattern.
- Revenue policy cards are read-only markup; no `role="button"` needed. Plain text suffices.
- Top strip: balance items are plain text in mono; no ARIA required.
- Fund button inherits existing `.btn-primary` focus ring.

## Theme compatibility

All new styles resolve through CSS vars. Specifically verify in both themes:
- Dashboard top-strip background and border contrast.
- Revenue hero number in green / red / neutral — green and red are the same tokens Settings uses for its badges, already proven to work in both themes.
- All-time badge (amber-glow2 background + amber-dim text) reads against the panel body backgrounds in both themes.
- Shortened Bitcoin chart at 120px still has legible y-axis tick labels.

Screenshots for the PR: treasury role × {dark, light} × {revenue +net, revenue -net — if feasible to simulate a negative-net scenario with local policy settings, otherwise just the positive-net screenshot plus a note}.

## Risks

1. **`BitcoinPriceGraph` height change flows to MemberDashboard.** Member operators lose ~100px of inline chart. Brief says member is already dense; shorter chart is probably net positive. If a member power-user pushes back, the next PR (MemberDashboard polish) can revisit with a `height` prop if needed.

2. **Duplicated fetch logic.** `Dashboard.tsx` adds ~15 lines to call `api.getNodeBalances` + `api.getCoinbaseOnrampUrl`, which `NodeBalancePanel` / `FundNodePanel` already do internally. Accepted for scope isolation; if a third compact consumer appears, factor into a hook.

3. **Hero number visual weight.** 2.25rem is bigger than anything currently on the Dashboard. If it reads as shouting rather than emphasizing, back off to 1.75rem and re-screenshot. Small design-tuning risk.

4. **Revenue sign ambiguity.** The `−` Unicode minus sign is typographically correct but may render differently from the ASCII `-` elsewhere in the codebase. Acceptable — it's only used in the hero number. Internal consistency check: today's table uses an explicit `-${fmt(Math.abs(n))}` pattern which is ASCII. The new hero uses Unicode minus in a single place. Both are acceptable; the Unicode minus is the more considered choice for a hero.

## Implementation surface

Files modified:

- `app/web/src/pages/Dashboard.tsx` — remove `NodeBalancePanel` and `FundNodePanel` imports and renders, add hand-rolled top strip + fetch logic, restructure Revenue panel with `className="panel ops"`, hero block, two `.policy-card` rows, and the existing stat-card row. Add `formatSigned` helper.
- `app/web/src/components/BitcoinPriceGraph.tsx` — single value change: `height={220}` → `height={120}`.
- `app/web/src/styles.css` — add `.dashboard-top-strip` and children, `.revenue-hero` and children.
- `bitcorn-lightning-node/umbrel-app.yml` — version bump + release-notes paragraph prepended.
- `bitcorn-lightning-node/docker-compose.yml` — both `api:` and `web:` image tags bumped.

Files NOT touched:

- Everything else. `MemberDashboard.tsx`, `NodeBalancePanel.tsx`, `FundNodePanel.tsx`, `api/client.ts`, `App.tsx`, `ValuationInputAlertBanner.tsx`.

## Release notes line (version determined at commit time)

> **v1.13.X** — Treasury Dashboard polish: compact top strip (on-chain / channel / total balances + Fund Node CTA inline), Revenue panel gets a big hero net-24h number with explicit ± sign, revenue rows use the Briefing Room policy-card vocabulary, Bitcoin price chart height reduced from 220px to 120px (y-axis still shown). No backend changes.

## PR checklist (per polish brief)

- [ ] Before + after screenshots attached.
- [ ] Dark + light theme both tested + attached.
- [ ] `cd app/web && npm run build` clean.
- [ ] MemberDashboard smoke-tested — chart is shorter, nothing else should change.
- [ ] Version bumped in both `bitcorn-lightning-node/umbrel-app.yml` and `bitcorn-lightning-node/docker-compose.yml` in the same push as final code.
- [ ] Release-notes paragraph added to `umbrel-app.yml`.
