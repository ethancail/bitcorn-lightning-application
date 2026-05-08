# Charts Ticker Strip Polish — "Token polish + micro-tweaks" Design

- **Date:** 2026-04-24
- **Branch:** `feature/ui-charts` (off `main` at v1.13.4).
- **Target version:** **v1.13.6** patch — assumes Contacts PR #123 (v1.13.5) merges first. If #123 is still open when this PR is ready, bump to v1.13.5 and #123 gets rebumped on rebase; if #123 has merged, bump to v1.13.6 straight.
- **Scope:** `app/web/src/components/CommodityPricesPanel.tsx` + `app/web/src/styles.css`.

## Mission

Final page in the UI polish brief's attack order. The ticker strip at the top of `/charts` already looks reasonable; the brief explicitly calls it "small tweaks possible." This PR does exactly that — swap hardcoded hex colors for CSS tokens, introduce a missing `--purple` token for Soybeans, and apply three small visible readability improvements (firmer border, bigger unit text, less-washed dollar sign, subtle hover background shift).

## Context

`CommodityPricesPanel.tsx` renders as `<PriceTickerStrip btcPrice={...} btcLoading={...} />` at the top of the `/charts` page. It displays 5 tickers — BTC, Gold, Corn, Soybeans, Wheat — in a flex-wrap row. Each ticker is a bordered card with a colored SVG icon, uppercase mono label (colored), formatted price with faded dollar sign prefix, and a tiny unit suffix (USD / $/oz / $/bu).

The component is 173 lines and was built before the CSS-token system was fully populated. Several values are hardcoded hex strings:
- SVG `stroke` attributes on icon paths
- Inline `style={{ color: ... }}` on label divs (via the `items[].color` field)
- `background: item.glow` on icon boxes (via `items[].glow` with raw rgba strings)
- `borderColor: item.color + "25"` — string concatenation to tack `0x25` alpha onto a hex

Most of these map cleanly to existing tokens (`--amber`, `--yellow`, `--green`, `--amber-dim`). One doesn't — Soybean purple `#a78bfa` has no corresponding token today. This PR adds `--purple` + `--purple-glow` to close that gap.

This is the seventh and final page in the polish brief after Settings (v1.12.1), Wizard (v1.13.1), Member Dashboard (v1.13.2), Treasury Dashboard (v1.13.3), Channels (v1.13.4), and Contacts (v1.13.5 in PR #123, currently open).

## Non-goals (explicitly out of scope)

- **No changes to the ticker count or data.** BTC + 4 commodities stay. API calls (`api.getCommodityPrices()`, BTC price prop from parent) unchanged.
- **No changes to the layout structure.** Flex-wrap row, 36×36 icon boxes, label/value/unit column — all unchanged.
- **No panel wrapper.** The "C" direction from the brainstorm explicitly rejected. The bare strip has a lighter feel that's right for a secondary header element on the charts page.
- **No changes to the parent `/charts` page** (`Charts.tsx`). Only the ticker component + styles.
- **No changes to other `.price-ticker-*` consumers** (there are none; the class names are specific to this component).
- **No changes to the 10-minute polling interval, `PriceItem` type, or `formatPrice()` helper.**
- **No changes to the SVG icon shapes** — only the `stroke` attribute.
- No changes to any path on `docs/UI_CONVENTIONS.md`'s do-not-touch list.

## Change 1: New `--purple` / `--purple-glow` tokens

Soybean purple has no matching token today. Add one pair in `app/web/src/styles.css`.

Dark mode (primary `:root` block, around line 4–50):
```css
:root {
  /* …existing tokens… */
  --purple:      #a78bfa;
  --purple-glow: rgba(167,139,250,0.10);
}
```

Light mode overrides (`[data-theme="light"] :root`, around line 1356+):
```css
[data-theme="light"] :root {
  /* …existing light-mode overrides… */
  --purple:      #7c3aed;
  --purple-glow: rgba(124,58,237,0.10);
}
```

Same naming convention as existing color/glow pairs (`--amber/--amber-glow`, `--green/--green-glow`, `--red/--red-glow`, `--blue/--blue-glow`, `--yellow/--yellow-glow`). Dark-mode purple (`#a78bfa`) is the current hardcoded Soybean value; light-mode purple (`#7c3aed`) is darker/firmer to read on cream backgrounds, matching how other colors tone down in light mode.

Place the new rules alphabetically or next to their closest siblings — either works; pick one consistent with surrounding order in the existing file.

## Change 2: Swap hardcoded hex for CSS-var strings in `items`

In `app/web/src/components/CommodityPricesPanel.tsx`, the `items: PriceItem[]` array (currently lines 93–144) has five entries with hardcoded `color` + `glow` hex/rgba strings.

Today:
```tsx
const items: PriceItem[] = [
  { key: "btc", label: "BTC", price: btcPrice ?? null, unit: "USD",
    color: "#f59e0b", glow: "rgba(245,158,11,0.12)", icon: BtcIcon, loading: btcLoading ?? false },
  { key: "gold", label: "Gold", price: commodities?.gold?.price ?? null, unit: commodities?.gold?.unit ?? "$/oz",
    color: "#eab308", glow: "rgba(234,179,8,0.12)", icon: GoldIcon, loading: !commodities },
  { key: "corn", label: "Corn", price: commodities?.corn?.price ?? null, unit: commodities?.corn?.unit ?? "$/bu",
    color: "#22c55e", glow: "rgba(34,197,94,0.10)", icon: CornIcon, loading: !commodities },
  { key: "soybeans", label: "Soy", price: commodities?.soybeans?.price ?? null, unit: commodities?.soybeans?.unit ?? "$/bu",
    color: "#a78bfa", glow: "rgba(167,139,250,0.10)", icon: SoybeansIcon, loading: !commodities },
  { key: "wheat", label: "Wheat", price: commodities?.wheat?.price ?? null, unit: commodities?.wheat?.unit ?? "$/bu",
    color: "#d97706", glow: "rgba(217,119,6,0.12)", icon: WheatIcon, loading: !commodities },
];
```

Replace with CSS-var strings:

```tsx
const items: PriceItem[] = [
  { key: "btc", label: "BTC", price: btcPrice ?? null, unit: "USD",
    color: "var(--amber)", glow: "var(--amber-glow)", icon: BtcIcon, loading: btcLoading ?? false },
  { key: "gold", label: "Gold", price: commodities?.gold?.price ?? null, unit: commodities?.gold?.unit ?? "$/oz",
    color: "var(--yellow)", glow: "var(--yellow-glow)", icon: GoldIcon, loading: !commodities },
  { key: "corn", label: "Corn", price: commodities?.corn?.price ?? null, unit: commodities?.corn?.unit ?? "$/bu",
    color: "var(--green)", glow: "var(--green-glow)", icon: CornIcon, loading: !commodities },
  { key: "soybeans", label: "Soy", price: commodities?.soybeans?.price ?? null, unit: commodities?.soybeans?.unit ?? "$/bu",
    color: "var(--purple)", glow: "var(--purple-glow)", icon: SoybeansIcon, loading: !commodities },
  { key: "wheat", label: "Wheat", price: commodities?.wheat?.price ?? null, unit: commodities?.wheat?.unit ?? "$/bu",
    color: "var(--amber-dim)", glow: "var(--amber-glow2)", icon: WheatIcon, loading: !commodities },
];
```

Only the `color` and `glow` field values change. All other fields (key, label, price, unit, icon, loading) stay identical.

Wheat maps to `var(--amber-dim)` + `var(--amber-glow2)` — the existing 6%-alpha amber glow is close enough to the current 12%-alpha hardcoded value that the visible difference is negligible. If the visual feels too faded in practice, we can revisit by introducing `--amber-glow-dim` in a follow-up; not worth it pre-emptively.

## Change 3: SVG icon strokes → `currentColor`

Each of the five icon SVG definitions (`BtcIcon`, `GoldIcon`, `CornIcon`, `SoybeansIcon`, `WheatIcon` at lines 19–63) has `stroke="<hex>"` hardcoded. Change all five to `stroke="currentColor"`.

Example — BtcIcon today:
```tsx
const BtcIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M9 8h4.5a2 2 0 0 1 0 4H9V8z" />
    <path d="M9 12h5a2 2 0 0 1 0 4H9v-4z" />
    <path d="M10 6v2m4-2v2m-4 8v2m4-2v2" />
  </svg>
);
```

Change to:
```tsx
const BtcIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M9 8h4.5a2 2 0 0 1 0 4H9V8z" />
    <path d="M9 12h5a2 2 0 0 1 0 4H9v-4z" />
    <path d="M10 6v2m4-2v2m-4 8v2m4-2v2" />
  </svg>
);
```

Only the `stroke="#..."` attribute changes to `stroke="currentColor"`. All other SVG attributes (viewBox, strokeWidth, strokeLinecap, etc.) and all path data are unchanged.

Apply the identical treatment to `GoldIcon` (stroke was `#eab308`), `CornIcon` (was `#22c55e`), `SoybeansIcon` (was `#a78bfa`), and `WheatIcon` (was `#d97706`) — all become `stroke="currentColor"`.

## Change 4: Set `color` on the icon parent div so `currentColor` inherits

The render at lines 147–169 today:
```tsx
{items.map((item) => (
  <div key={item.key} className="price-ticker" style={{ borderColor: item.price ? item.color + "25" : undefined }}>
    <div className="price-ticker-icon" style={{ background: item.glow }}>
      {item.icon}
    </div>
    ...
```

Add `color: item.color` to the `.price-ticker-icon` style:

```tsx
{items.map((item) => (
  <div key={item.key} className="price-ticker" style={{ borderColor: item.price ? `color-mix(in srgb, ${item.color} 25%, transparent)` : undefined }}>
    <div className="price-ticker-icon" style={{ background: item.glow, color: item.color }}>
      {item.icon}
    </div>
    ...
```

Two changes in the same JSX node:
- `borderColor` — string-concat `+ "25"` hack replaced with `color-mix(in srgb, ${item.color} 25%, transparent)`. `color-mix` is already used elsewhere in the codebase (the `.panel.ops .panel-header` rule added in the Settings polish PR). Resolves CSS-var colors correctly.
- `.price-ticker-icon` inline style — adds `color: item.color` alongside the existing `background: item.glow`. The SVG's new `stroke="currentColor"` inherits from this parent's color.

**Border alpha bump**: `+ "25"` = `0x25` = decimal 37 = ~14.5% alpha; `color-mix(... 25%)` = 25% alpha. Visible bump for firmer ticker definition when prices are loaded.

## Change 5: Label color stays inline

The `.price-ticker-label` inline color (`style={{ color: item.color }}` at line 154) is already correct — it resolves CSS vars the same as any other inline style. No change needed here beyond the `items[].color` swap from Change 2.

## Change 6: `styles.css` micro-tweaks

Three small rule changes in `app/web/src/styles.css`:

### Unit text — slightly bigger

Rule around line 728–735 currently:
```css
.price-ticker-unit {
  font-family: var(--mono);
  font-size: 0.5625rem;
  color: var(--text-3);
  letter-spacing: 0.04em;
  line-height: 1;
  margin-top: 1px;
}
```

Change `font-size: 0.5625rem` → `font-size: 0.625rem`. That's 9px → 10px, noticeably more readable without crowding. All other properties unchanged.

### Dollar sign — less washed out

Rule around line 723–726:
```css
.price-ticker-dollar {
  font-weight: 400;
  opacity: 0.5;
}
```

Change `opacity: 0.5` → `opacity: 0.65`. Dollar still visually recedes from the number but reads more cleanly. Font-weight unchanged.

### Hover — background shift added

Rule around line 686–688:
```css
.price-ticker:hover {
  border-color: var(--border-hi);
}
```

Change to:
```css
.price-ticker:hover {
  border-color: var(--border-hi);
  background: var(--bg-3);
}
```

Background shift from `var(--bg-2)` (base) to `var(--bg-3)` (slightly lighter in dark / slightly darker in light). Existing border-color transition in `.price-ticker` (`transition: border-color 0.2s`) should expand to include background — either via `transition: all 0.2s` or by adding `background 0.2s` explicitly. Do the latter for surgical precision:

```css
.price-ticker {
  /* …existing rules… */
  transition: border-color 0.2s, background 0.2s;
}
```

## Accessibility

No new ARIA needed. SVG icons are purely decorative (the label text provides the "what"), so `stroke="currentColor"` + inherited color has no a11y implications.

## Theme compatibility

All color values now resolve through CSS vars. Both dark and light mode auto-adapt. Specific checks:

- `--purple` / `--purple-glow` defined in both `:root` and `[data-theme="light"] :root`.
- Wheat using `var(--amber-dim)` has the same value in both themes (`#b45309`); icon + label read slightly differently against cream vs dark bg but both work.
- `color-mix()` resolves correctly in both themes since it's applied via CSS-var arithmetic.

Screenshots in both themes required in the PR body.

## Risks

1. **Wheat visual mapping.** `var(--amber-dim)` is darker than the current hardcoded `#d97706` (which is actually light-mode `--amber`, not `--amber-dim`). Wheat may read slightly more muted than it does today. Verify in visual check; if too muted, can switch to keeping `#d97706` hardcoded in the one Wheat entry (losing one token-consistency point) or add a new `--wheat` token. My lean: accept `--amber-dim` and move on.
2. **`currentColor` in SVG doesn't cascade automatically in all stroke scenarios.** SVG stroke explicitly uses `currentColor` when set; React doesn't strip this; browsers honor it. Well-precedented pattern. No real risk.
3. **`color-mix()` browser support.** Chrome 111+, Safari 16.2+, Firefox 113+. Already used elsewhere in this codebase without issue. Modern browsers only — acceptable for this app.

## Implementation surface

Files modified:

- `app/web/src/components/CommodityPricesPanel.tsx`:
  - Lines 19–63: five SVG icons' `stroke` attributes → `"currentColor"`.
  - Lines 93–144: five `items` entries' `color` + `glow` fields → CSS-var strings.
  - Lines 147–169: `.price-ticker-icon` inline style gets `color: item.color`; `.price-ticker` inline borderColor uses `color-mix()` instead of string concat.

- `app/web/src/styles.css`:
  - `:root` block: add `--purple` + `--purple-glow` tokens.
  - `[data-theme="light"] :root` block: add light-mode overrides for the same pair.
  - `.price-ticker`: add `background 0.2s` to the `transition` property.
  - `.price-ticker:hover`: add `background: var(--bg-3)`.
  - `.price-ticker-dollar`: change `opacity: 0.5` → `opacity: 0.65`.
  - `.price-ticker-unit`: change `font-size: 0.5625rem` → `font-size: 0.625rem`.

- `bitcorn-lightning-node/umbrel-app.yml` — patch version bump + prepend release-notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — bump both image tags.

Files NOT touched:

- Everything else. `Charts.tsx`, `api/client.ts`, other pages/components, do-not-touch list items.

## Release notes line (version filled at commit time)

> **v1.13.X** — Charts ticker strip polish. Swaps hardcoded hex colors for CSS tokens (new `--purple` / `--purple-glow` for Soybeans), uses `currentColor` on SVG icons so theme switches cascade properly. Small readability tweaks: firmer border on loaded tickers, slightly larger unit text, less-washed dollar sign, hover background shift. No backend changes. Completes the UI polish brief's attack order (7/7 pages shipped).

## PR checklist

- [ ] Before + after screenshots attached.
- [ ] Dark + light theme both tested + attached.
- [ ] `cd app/web && npm run build` clean.
- [ ] Visual verification: open `/charts`, verify all 5 tickers render with correct colors (BTC amber, Gold yellow, Corn green, Soy purple, Wheat amber-dim), icon colors match labels, dollar sign reads cleanly, hover works in both themes.
- [ ] Toggle theme via Settings; verify tickers re-color correctly in both directions.
- [ ] Version bumped in both `bitcorn-lightning-node/umbrel-app.yml` and `bitcorn-lightning-node/docker-compose.yml` in the same push.
- [ ] Release-notes paragraph added to `umbrel-app.yml`.
