# Liquidity Page Overhaul — Design Spec

**Date:** 2026-04-24
**Branch:** `feature/ui-liquidity` (off `main`)
**Target page:** Treasury sidebar `/liquidity` — currently renders `<NetworkGraph />`

## Goal

Redesign the treasury Liquidity page so the operator can answer two questions at a glance:

1. Which merchants are running low on **send capacity** (and need refill)?
2. Which farmers are running low on **receive capacity** (and need cash-out)?

The current NetworkGraph shows spatial topology with a role-uniform "fill from hub" encoding that means *opposite things* depending on role. It forces the operator to mentally invert the reading per peer. The overhaul surfaces role-specific health up front and keeps the topology as a secondary orientation anchor.

## The role-framing problem (why today's view is misleading)

On the treasury's channel with a member, the data we have is `local` (treasury's share) and `remote` (member's share). But:

- For a **merchant**, the member's concern is their own **send capacity** → `member-local / capacity` (which is `treasury-remote / capacity` from our side).
- For a **farmer**, the member's concern is their own **receive capacity** → `member-remote / capacity` (which is `treasury-local / capacity` from our side).

A 20% treasury-local bar means "merchant has 80% send-capacity" (healthy) *or* "farmer has 20% receive-capacity" (near-empty), depending entirely on who the peer is. Today's UI doesn't distinguish — it shows the same fill color and direction regardless.

## Architecture

One page at `/liquidity`, three stacked sections:

```
┌─────────────────────────────────────────────────┐
│ KPI Banner (3 cards)                            │  ~80px
├─────────────────────────────────────────────────┤
│ Slim Topology Map (interactive)                 │  ~140px
├─────────────────────────────────────────────────┤
│ Merchants lane         │ Farmers lane           │  fills remainder
│ (send capacity)        │ (receive capacity)     │
├─────────────────────────────────────────────────┤
│ ▸ External & Unclassified (collapsed)           │
└─────────────────────────────────────────────────┘
```

All sections share one data fetch: `GET /api/channels` + `api.getContacts()` + `api.getNode()`. Same calls the current NetworkGraph makes. Data re-fetches on manual refresh only.

## Sections

### 1. KPI Banner

Three KPI cards across the top, same Briefing Room chrome as the Treasury Dashboard's net-24h hero row.

| Card | Value | Sub-label |
|---|---|---|
| **Total Deployed** | Sum of all channel capacities, sats | "{peer-count} peers" |
| **Merchants Send-Ready** | `{n-healthy}/{n-total}` | Green if all healthy, amber if any tight, red if any critical |
| **Farmers Receive-Ready** | `{m-healthy}/{m-total}` | Same color rule |

"Healthy" = send/receive % ≥ 30% (per threshold policy below).

Font: mono for the big value, sans for labels, same sizing convention as existing `.panel.ops` hero cards.

### 2. Slim Topology Map

Height: ~140px. No zoom, no pan — the map is small enough to always fit.

- Treasury hub in center
- All peers arranged radially around it
- Each spoke = a line from hub to peer
- Line color = peer's role color (amber / green / blue / gray)
- Line thickness = capacity (thicker = more capacity)
- Peer node = small circle, filled with role color
- Node ring color encodes **health** — green/amber/red per the threshold policy, using the peer's role-appropriate metric (merchant → send%, farmer → receive%, external/unknown → neutral gray ring)
- Label: peer name + capacity in short form (e.g. "MerchB · 320k")

**Interactions:**

- **Hover a peer:** node briefly enlarges (+6px radius, 200ms ease-out), its lane row scrolls into view and highlights with a subtle amber border pulse (2 beats, 600ms total)
- **Click a peer:** same as hover + permanent highlight until another peer is clicked (single-select pattern). Pulse animation replays on each click.
- **Keyboard:** tab into the topology, arrow keys move between peers (clockwise → right, counter-clockwise → left), enter triggers the same as click, esc deselects
- **Accessibility:** each peer node gets an `aria-label` like "Merchant B, 320k capacity, 12% send capacity, critical"

### 3. Two Role Lanes

Side-by-side on wide viewports, stacked vertically on narrow (<720px) viewports. Each lane is a `.panel.ops`.

| Lane | Header | Metric |
|---|---|---|
| Left | `[ Merchants · Send Capacity ]` | `member-local / capacity` |
| Right | `[ Farmers · Receive Capacity ]` | `member-remote / capacity` |

#### Row content (Standard)

Each row, left-to-right:

1. **Name** — `{contact name or short pubkey}`, role-colored mono text
2. **Capacity** — `{short-format sats}`, monospace, muted color (e.g. "320k", "1.2M")
3. **Health bar** — horizontal bar, fill color matches health tier (red/amber/green), full width of available space
4. **%-chip** — `{integer}%`, small pill, matching health tier color

#### Sorting

Urgency-first:

1. Red (< 15%) — critical first
2. Amber (15–30%) — heavy next
3. Green (≥ 30%) — healthy last

Within a tier: alphabetical by peer name (stable, deterministic).

#### Animation on refresh

When the user clicks Refresh:

1. Data fetches in background (panel header shows a subtle spinner)
2. When new data arrives, each row's bar width smoothly animates to new % (400ms cubic-bezier(0.4, 0, 0.2, 1))
3. Rows that change tier (e.g. amber → green) re-sort with **FLIP animation** — rows slide to new positions over 500ms, no snap
4. New peers fade in; removed peers fade out

### 4. External & Unclassified (collapsible)

Beneath the two lanes, a single collapsible panel:

- **Closed by default.** Header reads `▸ External & Unclassified ({n})` with a chevron
- **Opens on click** to reveal a table of external + unknown peers with columns: Name · Capacity · Local · Remote · Utilization% (no role-specific framing — they don't have a role preference)
- Same Briefing Room chrome, but header uses `--text-3` instead of `--amber-dim` since these peers are out of scope for the role-aware flows

## Thresholds & colors

| Metric | Range | Color | Meaning |
|---|---|---|---|
| send/receive % | `< 15%` | `var(--red)` | Critical — needs action |
| send/receive % | `15% ≤ x < 30%` | `var(--amber)` | Heavy — watch it |
| send/receive % | `≥ 30%` | `var(--green)` | Healthy |

Chip background is the matching color at ~20% alpha (`color-mix`), chip text is the full color. Bar fill is the full color.

These thresholds match the existing member-side advisor's `heavy/saturated` classification bands, keeping the mental model consistent across treasury and member views.

## Refresh behavior

- Initial load: on mount, fetch once.
- Manual refresh: button in panel header (`{icon}` reused from existing refresh buttons). Click triggers a new fetch. Spinner in-header while loading.
- No auto-polling in v1. Avoiding the "content moves while I'm reading" problem.

## Quality bar: seamless & fluid

The overhaul's success criteria beyond "right data in the right place" are:

1. **Hover is smooth** — no layout shift when a row scrolls into view on peer-hover; no border flash that makes the eye jump
2. **Refresh re-sort is fluid** — FLIP animation for lane re-order, width transitions for bars, not snap
3. **Topology interactions feel responsive** — hover feedback <16ms, click pulse completes cleanly (2 beats of amber, no jitter)
4. **Theme cascades cleanly** — all role colors, chip backgrounds, bar fills use CSS vars so light/dark toggle doesn't require per-component work
5. **No layout thrash on data change** — use `will-change` hints sparingly where needed, fixed-height rows so bar width change doesn't push siblings

## Out of scope for v1

Deliberately deferred:

- Per-channel breakdown (multi-channel peers aggregate to one row; per-channel drill-down can come later)
- Click-to-navigate to `/channels` filtered view
- Auto-polling / live updates
- Historical view ("how has this peer's send capacity trended over 24h?")
- Bulk actions (approve multiple refills at once)
- The orphaned `MemberLiquidity.tsx` (754 lines) stays orphaned — not wiring it up in this PR. It was from an older workflow that's been superseded

## Files

### New

- `app/web/src/pages/Liquidity.tsx` — replaces the 2-line TODO stub with the real page (KPI banner + topology + lanes + external section). Composed of smaller sub-components.
- `app/web/src/components/liquidity/LiquidityKpiBanner.tsx` — 3 KPIs across the top
- `app/web/src/components/liquidity/LiquidityTopology.tsx` — slim interactive topology map
- `app/web/src/components/liquidity/LiquidityLane.tsx` — one role-aware lane (reusable for merchants + farmers)
- `app/web/src/components/liquidity/LiquidityLaneRow.tsx` — one row within a lane
- `app/web/src/components/liquidity/ExternalUnclassifiedSection.tsx` — collapsible section

### Modified

- `app/web/src/App.tsx` — change `<Route path="/liquidity" element={<LiquidityPage />} />` to render `<Liquidity />` from the new `pages/Liquidity.tsx` instead of the inline `LiquidityPage()` that returns `<NetworkGraph />`
- `app/web/src/styles.css` — new classes: `.liq-kpi-banner`, `.liq-kpi-card`, `.liq-topology`, `.liq-lane`, `.liq-lane-row`, `.liq-health-bar`, `.liq-health-chip`, `.liq-external-section`. All using existing CSS vars.

### Unchanged (do-not-touch)

- `app/web/src/components/NetworkGraph.tsx` — stays on disk, unused after this change. Can be removed in a follow-up PR once we confirm the new page covers everything.
- `app/web/src/pages/MemberLiquidity.tsx` — orphaned, stays that way.
- Anything on the UI polish brief's do-not-touch list (AutoBuy, ValuationInput, docker-compose lifecycle, etc.)

## Data model

One type, computed client-side from the existing `/api/channels` response:

```ts
type LiquidityPeer = {
  pubkey: string;
  name: string;
  role: "merchant" | "farmer" | "external" | "unknown";
  capacity: number;          // sum across channels
  memberLocal: number;       // = treasury's remote, sum across channels
  memberRemote: number;      // = treasury's local, sum across channels
  channelCount: number;
  // role-aware computed metric — send% for merchants, receive% for farmers
  // undefined for external/unknown (they don't have a role-appropriate metric)
  rolePct: number | null;
  healthTier: "critical" | "heavy" | "healthy" | "neutral";
};
```

A merchant's `rolePct` = `memberLocal / capacity`. A farmer's `rolePct` = `memberRemote / capacity`. External/unknown → `rolePct: null`, `healthTier: "neutral"`.

## Chrome & visual tokens

Every panel uses the established Briefing Room vocabulary from the UI polish brief:

- Panel root: `.panel.ops` (amber border-top + tinted header + `--amber-dim` title)
- KPI cards: `.panel.ops` with `.liq-kpi-card` modifier for the sans-label + mono-value pattern (reuses Treasury Dashboard's net-24h hero styling)
- Lane headers: `[ Bracket ]` convention in `--amber-dim`
- Collapsible section: neutral `--text-3` header (not amber) to distinguish "out of primary flow"
- Health colors: existing `--red`, `--amber`, `--green` tokens; chips use `color-mix(in srgb, ${color} 20%, transparent)` for soft backgrounds

## Test plan

- `cd app/web && npm run build` clean at every commit
- Visual verification on `/liquidity` in both themes:
  - All 3 KPI cards render correct counts
  - Topology map shows all peers with correct role colors + health rings
  - Hover a topology node → its lane row scrolls into view, border pulses
  - Click a topology node → row highlights permanently; clicking another peer moves the highlight
  - Tab into the topology, arrow-key navigation moves the "focused" peer
  - Merchants lane sorts red-first-amber-second-green-third, alphabetical tie-break
  - Farmers lane same
  - Refresh button triggers smooth re-sort + bar-width animation; no snap
  - External & Unclassified section opens/closes on click
  - Narrow viewport (<720px): lanes stack vertically; topology stays at top
  - Theme toggle: all colors, chips, bars re-color correctly — no hardcoded hex bleeding through

## Risks & open questions

- **Role-color ring on the topology node may fight with the role-color fill.** If the merchant node is amber-filled AND has an amber ring ("healthy"), the ring gets lost visually. Mitigation: use distinct luminosity for ring vs. fill, OR only show a ring for non-healthy states. Revisit after first visual check.
- **`health bar` inside a role-colored lane may look redundant.** E.g. a farmer lane row's bar is green-filled for a healthy farmer; the lane header is already green-tinted. Revisit if the visual feels noisy.
- **FLIP animation implementation.** React doesn't ship one; we'll use a small `useFlip` hook (vanilla approach — measure before, measure after, animate with `transform: translateY`). No new dependencies.

## Quality check

- No TBDs, TODOs, or placeholders above.
- No contradictions between sections (role-aware metric is defined once; threshold policy is defined once).
- Scope is focused on one subsystem; implementation plan will be a single feature branch → single PR.
- Every requirement is concrete enough to implement without a second round of questions.
