# Channels Page Polish — "Chrome + Density" Design

- **Date:** 2026-04-24
- **Branch:** `feature/ui-channels` (off `main`)
- **Target version:** `v1.13.X+1` patch — determined at commit time. Main is currently v1.13.1; PRs #120 (treasury dashboard) and #121 (member dashboard) may merge before this does, shifting the base version.
- **Scope:** Treasury-only lane tables and related panels in `ChannelsPage` (inline in `app/web/src/App.tsx`) + supporting CSS in `app/web/src/styles.css`.

## Mission

Polish the treasury `/channels` page — the 3 lane tables (Merchant / Farmer / External) plus the Unclassified, Projected Capital Needs, and Treasury Open Channel panels — with Briefing Room chrome and tighter table density, without sacrificing the column-scan readability operators rely on. The brief specifically flagged this page as "🔴 Rough" with "lane tables got column-alignment fixes in v1.9.31-32 but still a lot of information density."

## Context

`ChannelsPage` is inline in `app/web/src/App.tsx` (lines 1398–2113, 716 lines). It renders two distinct views based on `nodeRole`:

- **Treasury** (`nodeRole === "treasury" && channels.length > 0`): 6 operational panels — Merchant Lanes, Farmer Lanes, External Routing Peers, Unclassified Channels, Projected Capital Needs, Treasury Open Channel.
- **Member / loading / empty**: a simpler flat channel list (line 1950 onward).

Per the Scope A pick, this PR polishes **treasury only**. Member view stays untouched.

This is the fifth page after Settings (v1.12.1), Wizard (v1.13.1), Treasury Dashboard (PR #120, pending merge at target v1.13.2), and Member Dashboard (PR #121, pending merge at target v1.13.2). Same Briefing Room aesthetic direction.

## Non-goals (explicitly out of scope)

- **No changes to the member view** (the "original channel list" branch rendered when `nodeRole !== "treasury"` or `loading` or `channels.length === 0`).
- **No changes to lane classification logic** — `merchantState()`, `farmerState()`, `externalState()`, purpose tagging, lane sorting, state badge mapping all unchanged.
- **No changes to the close-channel confirmation dialog** (`.dialog-overlay` + `.dialog-card`). Modal styling untouched.
- **No extraction of `ChannelsPage` to its own file.** The 716-line inline function stays inline. Scope creep.
- **No changes to API calls.** `/api/channels`, `getContacts`, `getLiquidityHealth`, `getPendingChannels`, `treasuryCloseChannel` unchanged.
- **No changes to `ChannelLiquidityHealth`, `Contact`, `PendingChannel` types.**
- **No changes to other pages** (Settings, Wizard, Dashboard, Peers, Payments, MemberLiquidity).
- **No changes to any path on `docs/UI_CONVENTIONS.md`'s do-not-touch list.**

## Panel chrome coverage

Six operational panels on the treasury Channels page get `.panel.ops` chrome (amber border-top + amber-tinted header + amber-dim title). One-line className edit per panel: `"panel fade-in"` → `"panel ops fade-in"`.

| # | Panel | Function / approximate line | Condition |
|---|---|---|---|
| 1 | Merchant Lanes | inside `ChannelsPage` at ~L1713 | treasury + channels > 0 |
| 2 | Farmer Lanes | ~L1775 | same |
| 3 | External Routing Peers | ~L1837 | same |
| 4 | Unclassified Channels | ~L1894 | same, plus `unclassified.length > 0` |
| 5 | Projected Capital Needs | ~L1695 | same, plus data exists |
| 6 | Treasury Open Channel Panel (bottom) | root of `TreasuryOpenChannelPanel` function at L2115 | always for treasury |

Same `.panel.ops` CSS that Settings, Wizard, and Dashboard already use — no new CSS for the panel chrome. Uses the `.panel.ops .panel-header` + `.panel.ops .panel-title` rules added in the Settings polish PR.

## Table polish

### CSS scoping

One new rule-block in `styles.css`, scoped via the descendant selector `.panel.ops .data-table`:

```css
/* ─── Channels page: lane table polish (scoped to .panel.ops) ─── */
.panel.ops .data-table th {
  padding: 6px 10px;
  letter-spacing: 0.06em;
}
.panel.ops .data-table td {
  padding: 7px 10px;
}
```

The descendant selector means only `.data-table` instances inside `.panel.ops` panels get the tighter padding. Other `.data-table` consumers (`Dashboard.tsx` (pre-PR-#120), `Peers.tsx`, `Payments.tsx`, `MemberLiquidity.tsx`) are unaffected — they keep today's `9px 12px` / `8px 12px` base padding.

### What changes

- **Row padding shrinks** — `td`: `9px 12px` → `7px 10px`. `th`: `8px 12px` → `6px 10px`. Visible effect: ~4px less per row.
- **Letter-spacing on column headers** — `0.08em` → `0.06em`, matching the mono uppercase treatment used for panel titles and stat-card labels.
- **Font sizes unchanged** — headers at `0.625rem` (10px), body at `0.8125rem` (13px). Already compact; shrinking further would hurt readability.

### What stays as-is

- **Row hover highlight** — `tr:hover td { background: var(--bg-2) }` from base `.data-table`, preserved.
- **Forwarding-left inline bar** — each row's bar has dynamic width (from `localPct` or `fwdLeftPct`) and dynamic color (role-aware via `stateColor()`). Implemented as inline-styled `<div>` children inside a `<td>`. JSX unchanged.
- **State badges** — `.badge-green` / `.badge-amber` / `.badge-red` (existing classes) cover all 9 state labels. No CSS change.
- **Column widths** — `<colgroup>` widths (25% / 12% / 15% / 20% / 15% / 13% for merchant + farmer + external; unclassified columns differ slightly) balanced for the 6-column layout. No change.
- **Table header background** — stays neutral. The panel's `.panel-header` (with Merchant Lanes / Farmer Lanes title + count badge) IS amber-tinted; the table's own `<thead>` row (column labels) stays on its default. Two stacked amber bars would be visually redundant.

## Action button polish

Lane tables' action column (rightmost) renders buttons via a helper (inspected at implementation time — likely `closeBtn()` or similar). Today those buttons use default `.btn` size (`padding: 8px 14px; font-size: 0.8125rem`).

Change to use `.btn-sm` size (`padding: 5px 10px; font-size: 0.75rem`) for visual consistency with Settings' "Edit" buttons on `.panel.ops` panels and with other polished pages.

If the helper renders a specific className, add `"btn-sm"` alongside it. If the helper takes a size prop, pass `"sm"`. If the helper wraps the className internally, modify the helper itself to emit `"btn btn-<variant> btn-sm"`.

The "Renew Now" / "Renew Soon" / "Close" action buttons all use the same helper today; changing size applies uniformly.

## Accessibility

Current table HTML is already semantic (`<table>` / `<thead>` / `<tbody>` / `<th>` / `<td>`). Screen readers get standard table navigation for free. No ARIA additions in this PR.

Row hover highlight relies on CSS `:hover` pseudo-class, so it's mouse-agnostic. Keyboard users get the same affordance via browser focus ring on the in-row action button.

## Theme compatibility

All modified styles resolve through existing CSS vars:

- `--bg-2` (panel-header background before amber mix)
- `--border` (table row dividers)
- `--text-3` (column header text)
- `--amber`, `--amber-dim`, `--amber-glow2` (used by `.panel.ops` rules, not added here)

Both dark and light mode auto-adapt. PR screenshots include both themes.

## Risks

1. **`.panel.ops .data-table` descendant selector** applies to any future `.data-table` dropped inside a `.panel.ops` wrapper. Today, that's only the Channels page. Mitigation: the overrides are *density* tweaks (tighter padding, tighter letter-spacing), not loud stylistic changes — future accidental inheritance is benign and might even be desirable.

2. **Action button helper structure** is unknown until implementation inspects it. If the helper is a one-off inline renderer, `.btn-sm` is a simple className append. If it's a named `closeBtn()` function, the change lives in the helper and propagates automatically. Either way, a one-line edit — just can't pre-spec exactly what line until we look.

3. **Merge collision with PR #120 / PR #121** — both touch the `.panel.ops` tree. This PR only ADDS a new descendant rule (`.panel.ops .data-table`), so no content collision. Version-bump collision stays — whichever PR merges second rebases + rebumps, same pattern we've handled.

4. **`TreasuryOpenChannelPanel` is a separate function** at line 2115 but visually part of the page. Its className is different from the other five (checked at implementation — likely `"panel"` not `"panel fade-in"`). Implementation task must handle whatever className it has today and swap to `"panel ops"` form (with or without `fade-in`).

## Implementation surface

Files modified:

- `app/web/src/App.tsx` — 6 className edits + action-button size change(s):
  - `ChannelsPage` function body: 5 lane / Unclassified / Capital-Needs panels' classNames swap to `"panel ops fade-in"`.
  - `TreasuryOpenChannelPanel` function body: root panel className swap.
  - Lane-table action buttons: add `.btn-sm` modifier.
- `app/web/src/styles.css` — append one new rule-block (`.panel.ops .data-table th` + `td` padding + letter-spacing).
- `bitcorn-lightning-node/umbrel-app.yml` — version bump + prepend release-notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — both image tags bumped.

Files NOT touched:

- All other pages (Settings, Wizard, Dashboard, MemberDashboard, Peers, Payments, MemberLiquidity, Contacts, etc.).
- `api/client.ts`, `App.tsx` shell routes, anything under `components/`.
- Close-channel dialog.
- Member view branch inside `ChannelsPage`.

## Release notes line (version filled at commit time)

> **v1.13.X** — Channels page lane-table polish. Applies Briefing Room chrome (amber border-top + tinted header) to all 6 treasury panels: Merchant Lanes, Farmer Lanes, External Routing Peers, Unclassified Channels, Projected Capital Needs, Treasury Open Channel. Tighter row padding on lane tables via `.panel.ops .data-table` descendant CSS (no spillover to other `.data-table` consumers). Action buttons use the smaller `.btn-sm` size for visual consistency with Settings. Member view and close-channel dialog unchanged. No backend changes.

## PR checklist (per polish brief)

- [ ] Before + after screenshots attached.
- [ ] Dark + light theme both tested + attached.
- [ ] Visual check: treasury `/channels` with channels spanning multiple states (exhausted, renew-soon, active, fresh). Member `/channels` smoke-tested — expected unchanged.
- [ ] `cd app/web && npm run build` clean.
- [ ] Other `.data-table` pages smoke-tested — Peers, Payments, MemberLiquidity should render unchanged (since the new CSS is scoped to `.panel.ops` which those pages don't use).
- [ ] Version bumped in both `bitcorn-lightning-node/umbrel-app.yml` and `bitcorn-lightning-node/docker-compose.yml` in the same push as final code.
- [ ] Release-notes paragraph added to `umbrel-app.yml`.
