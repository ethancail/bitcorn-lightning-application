# Charts Ticker Strip Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Token polish + micro-tweaks" Charts ticker strip polish on `feature/ui-charts`: token-ize hardcoded hex values in the 5 commodity tickers, switch SVG icons to `stroke="currentColor"` so theme changes cascade, and apply three small readability improvements (firmer border, larger unit text, less-washed dollar sign, hover background shift).

**Architecture:** Changes in two files — `app/web/src/components/CommodityPricesPanel.tsx` (items array + SVG icons + icon parent color + border `color-mix()`) and `app/web/src/styles.css` (new `--purple` tokens + 3 micro-tweaks on existing `.price-ticker-*` rules). No backend changes, no logic changes, no new components. Version bump lands in the same PR.

**Tech Stack:** React 18 + TypeScript + Vite, CSS custom properties (already wired). Uses existing API method `api.getCommodityPrices()` unchanged.

**Spec:** `docs/superpowers/specs/2026-04-24-charts-ticker-polish-design.md`.

---

## Preflight notes for the engineer

- **No automated test suite.** Verification = `cd app/web && npm run build` clean + visual check in `npm run dev`.
- **Branch `feature/ui-charts`** off `main` (at v1.13.4, commit `1f64a1b`). Do not switch branches.
- **Classes already in `styles.css`** (all reused): `.price-ticker-strip`, `.price-ticker`, `.price-ticker:hover`, `.price-ticker-icon`, `.price-ticker-info`, `.price-ticker-label`, `.price-ticker-value`, `.price-ticker-dollar`, `.price-ticker-unit`. No new classes needed.
- **Tokens currently in `:root`**: `--amber`, `--amber-dim`, `--amber-glow`, `--amber-glow2`, `--yellow`, `--yellow-glow`, `--green`, `--green-glow`, `--red`, `--red-glow`, `--blue`, `--blue-glow`. This plan adds **`--purple`** + **`--purple-glow`** as the seventh color/glow pair.
- **Do NOT touch**: `Charts.tsx` or any other page, `api/client.ts`, other components, anything on `docs/UI_CONVENTIONS.md`'s do-not-touch list.
- **Version bump goes in the same final push** — per the v1.12.1 lesson.
- **Current main is at v1.13.4.** Contacts PR #123 (targeting v1.13.5) is still open. Task 4's version-bump step handles either outcome — grep-first for the current main version, bump by one patch.

---

## File Structure

### Files modified

- `app/web/src/styles.css` — add `--purple` + `--purple-glow` tokens in both `:root` and `[data-theme="light"] :root`; tweak 3 existing rules (`.price-ticker:hover`, `.price-ticker-dollar`, `.price-ticker-unit`); add `background 0.2s` to `.price-ticker`'s transition.
- `app/web/src/components/CommodityPricesPanel.tsx` — 5 SVG `stroke` attribute changes, 5 `items` array entries' `color` + `glow` values, icon parent div `style` addition, border-color `color-mix()` replacement. No logic changes.
- `bitcorn-lightning-node/umbrel-app.yml` — version bump + prepend release-notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — bump both image tags.

### Files NOT modified

- `Charts.tsx`, `api/client.ts`, anything else.

### No new files

All edits in place.

---

### Task 1: Add `--purple` + `--purple-glow` tokens

**Files:**
- Modify: `app/web/src/styles.css`

- [ ] **Step 1: Add to the primary `:root` block**

Find the existing `:root` block (lines 4–50 in current `styles.css`), specifically the color token cluster where `--blue` + `--blue-glow` live (around lines 29–30):

```css
  --blue:        #60a5fa;
  --blue-glow:   rgba(96,165,250,0.10);
```

Immediately after the `--blue-glow` line (before the text color block `--text:`), add:

```css
  --purple:      #a78bfa;
  --purple-glow: rgba(167,139,250,0.10);
```

- [ ] **Step 2: Add to the `[data-theme="light"] :root` override block**

Find the light-mode overrides block. It's further down in the file (around lines 1356+). Locate the cluster with other light-mode color overrides (`--blue`, `--blue-glow`, or similar). Add immediately after:

```css
  --purple:      #7c3aed;
  --purple-glow: rgba(124,58,237,0.10);
```

If you can't identify the exact spot, place it right before the closing `}` of the `[data-theme="light"] :root` block — the token order within the block doesn't affect rendering.

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0, no CSS errors. `--purple` and `--purple-glow` are defined but not yet consumed — that's fine, Vite doesn't warn on unused CSS vars.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/charts): add --purple / --purple-glow tokens

New color/glow pair for the Soybeans ticker. Dark mode uses #a78bfa;
light mode uses #7c3aed for better contrast on cream backgrounds.
Matches the existing --amber / --yellow / --green / --red / --blue
token pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `CommodityPricesPanel.tsx` — full refactor (items + SVG + border + icon color)

Four coordinated changes in one file; all must land together for the tickers to render correctly. Keep as a single coherent commit.

**Files:**
- Modify: `app/web/src/components/CommodityPricesPanel.tsx`

- [ ] **Step 1: Swap hardcoded hex in `items` array for CSS-var strings**

Find the `items: PriceItem[] = [ ... ]` declaration (lines 93–144 in current file). Replace the entire array with:

```tsx
  const items: PriceItem[] = [
    {
      key: "btc",
      label: "BTC",
      price: btcPrice ?? null,
      unit: "USD",
      color: "var(--amber)",
      glow: "var(--amber-glow)",
      icon: BtcIcon,
      loading: btcLoading ?? false,
    },
    {
      key: "gold",
      label: "Gold",
      price: commodities?.gold?.price ?? null,
      unit: commodities?.gold?.unit ?? "$/oz",
      color: "var(--yellow)",
      glow: "var(--yellow-glow)",
      icon: GoldIcon,
      loading: !commodities,
    },
    {
      key: "corn",
      label: "Corn",
      price: commodities?.corn?.price ?? null,
      unit: commodities?.corn?.unit ?? "$/bu",
      color: "var(--green)",
      glow: "var(--green-glow)",
      icon: CornIcon,
      loading: !commodities,
    },
    {
      key: "soybeans",
      label: "Soy",
      price: commodities?.soybeans?.price ?? null,
      unit: commodities?.soybeans?.unit ?? "$/bu",
      color: "var(--purple)",
      glow: "var(--purple-glow)",
      icon: SoybeansIcon,
      loading: !commodities,
    },
    {
      key: "wheat",
      label: "Wheat",
      price: commodities?.wheat?.price ?? null,
      unit: commodities?.wheat?.unit ?? "$/bu",
      color: "var(--amber-dim)",
      glow: "var(--amber-glow2)",
      icon: WheatIcon,
      loading: !commodities,
    },
  ];
```

Only `color` + `glow` values change per entry. All other fields (`key`, `label`, `price`, `unit`, `icon`, `loading`) are identical to today.

- [ ] **Step 2: Change SVG icon `stroke` attributes to `"currentColor"`**

Find each of the 5 icon constants (lines 19–63): `BtcIcon`, `GoldIcon`, `CornIcon`, `SoybeansIcon`, `WheatIcon`.

Each currently has `stroke="<hex>"` in the `<svg>` opening tag. Change each to `stroke="currentColor"`:

**BtcIcon** — change `stroke="#f59e0b"` → `stroke="currentColor"`.

**GoldIcon** — change `stroke="#eab308"` → `stroke="currentColor"`.

**CornIcon** — change `stroke="#22c55e"` → `stroke="currentColor"`.

**SoybeansIcon** — change `stroke="#a78bfa"` → `stroke="currentColor"`.

**WheatIcon** — change `stroke="#d97706"` → `stroke="currentColor"`.

No other SVG attribute changes; `width`, `height`, `viewBox`, `fill`, `strokeWidth`, `strokeLinecap`, `strokeLinejoin`, and all inner `<path>`/`<circle>` elements stay identical.

- [ ] **Step 3: Add `color: item.color` on the `.price-ticker-icon` parent + switch border to `color-mix()`**

Find the render JSX (lines 146–171). Today's `{items.map((item) => ( ... ))}` body has:

```tsx
        <div key={item.key} className="price-ticker" style={{ borderColor: item.price ? item.color + "25" : undefined }}>
          <div className="price-ticker-icon" style={{ background: item.glow }}>
            {item.icon}
          </div>
```

Change to:

```tsx
        <div key={item.key} className="price-ticker" style={{ borderColor: item.price ? `color-mix(in srgb, ${item.color} 25%, transparent)` : undefined }}>
          <div className="price-ticker-icon" style={{ background: item.glow, color: item.color }}>
            {item.icon}
          </div>
```

Two changes:
- `.price-ticker` inline `borderColor`: the `item.color + "25"` string-concat hack becomes `color-mix(in srgb, ${item.color} 25%, transparent)`. This resolves CSS-var strings correctly (the old concat only worked on raw hex). Side effect: alpha bumps from ~14.5% (0x25) to 25%.
- `.price-ticker-icon` inline `style`: add `color: item.color` alongside the existing `background: item.glow`. The SVG's new `stroke="currentColor"` inherits from this parent's `color`.

The `.price-ticker-label` inline style (`style={{ color: item.color }}` at line 154) is already correct — `item.color` is now a CSS-var string, which resolves fine in inline style.

- [ ] **Step 4: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

- [ ] **Step 5: Grep verification**

```bash
grep -c '"#f59e0b"\|"#eab308"\|"#22c55e"\|"#a78bfa"\|"#d97706"\|"rgba(245,158,11\|"rgba(234,179,8\|"rgba(34,197,94\|"rgba(167,139,250\|"rgba(217,119,6' app/web/src/components/CommodityPricesPanel.tsx
```

Expected: `0` — no hardcoded hex or rgba for the 5 ticker colors remain.

```bash
grep -c 'stroke="currentColor"' app/web/src/components/CommodityPricesPanel.tsx
```

Expected: `5` (one per icon).

- [ ] **Step 6: Commit**

```bash
git add app/web/src/components/CommodityPricesPanel.tsx
git commit -m "refactor(web/charts): token-ize ticker colors + currentColor SVG

- items[] color/glow fields now use CSS-var strings (var(--amber),
  var(--green), etc. — new var(--purple) for Soybeans).
- All 5 icon SVGs now use stroke='currentColor'. Icon box parent
  div inherits the ticker color, so theme switches cascade.
- Border color switches from hex+'25' string concat hack to
  color-mix(in srgb, \${color} 25%, transparent) — composes with
  CSS-var colors. Alpha bumps from ~14.5% to 25% (firmer tint).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `styles.css` micro-tweaks

Three small CSS rule edits + one transition property addition.

**Files:**
- Modify: `app/web/src/styles.css`

- [ ] **Step 1: Add `background` to `.price-ticker` transition**

Find (around line 684):
```css
.price-ticker {
  /* …other properties… */
  transition: border-color 0.2s;
}
```

Change the `transition` property to:
```css
  transition: border-color 0.2s, background 0.2s;
```

Leave all other `.price-ticker` properties untouched.

- [ ] **Step 2: Add hover background shift**

Find (around line 686):
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

Only the added `background` line. `border-color` stays.

- [ ] **Step 3: Change dollar sign opacity**

Find (around line 723):
```css
.price-ticker-dollar {
  font-weight: 400;
  opacity: 0.5;
}
```

Change `opacity: 0.5` → `opacity: 0.65`. Keep `font-weight: 400`.

- [ ] **Step 4: Change unit text font size**

Find (around line 728):
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

Change `font-size: 0.5625rem` → `font-size: 0.625rem`. Leave all other properties.

- [ ] **Step 5: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

- [ ] **Step 6: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/charts): ticker readability micro-tweaks

- Unit text 0.5625rem (9px) → 0.625rem (10px).
- Dollar sign opacity 0.5 → 0.65.
- Hover state gains subtle background shift (bg-2 → bg-3).
- .price-ticker transition extended to include background.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Version bump

**Files:**
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

- [ ] **Step 1: Check current version**

```bash
grep -nE "^version:" bitcorn-lightning-node/umbrel-app.yml
```

Possible values and target bumps:

- `version: "1.13.4"` (Contacts PR #123 still open, hasn't merged yet) → bump to `1.13.5`. In this case, if #123 merges before this PR lands, this PR's branch will need a rebase + rebump at merge time (same 4-PR-collision pattern we've handled).
- `version: "1.13.5"` (Contacts PR #123 has merged first) → bump to `1.13.6`. Clean.

Any other value: STOP and report as NEEDS_CONTEXT — main has advanced unexpectedly.

Substitute `<NEW>` (target) and `<OLD>` (current) throughout the rest of this task.

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

Find the `releaseNotes: >` block. The first paragraph currently starts with `v<OLD>: …`. Insert ABOVE it (preserving 2-space YAML indentation; do NOT delete the v<OLD> paragraph):

```yaml
  v<NEW>: Charts ticker strip polish. Swaps hardcoded hex colors
  for CSS tokens (new --purple / --purple-glow for Soybeans), uses
  currentColor on SVG icons so theme switches cascade properly.
  Small readability tweaks: firmer border on loaded tickers, slightly
  larger unit text, less-washed dollar sign, hover background shift.
  No backend changes. Completes the UI polish brief's attack order
  (7/7 pages shipped).
```

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

- [ ] **Step 5: Verify**

```bash
grep -nE "^version:|v<NEW>|api:<NEW>|web:<NEW>|api:<OLD>|web:<OLD>" bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml | head -12
```

Expected: new version in both files, new release-notes line, no remaining `<OLD>` image tags (old version should persist only in the preserved release-notes paragraph).

- [ ] **Step 6: Commit**

```bash
git add bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
git commit -m "chore: bump to v<NEW> for Charts ticker polish

Umbrel manifest + compose image tags bumped together. Release notes
for v<NEW> prepended. Final page in the UI polish brief's attack
order — 7/7 pages now shipped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

## Report format for Task 4

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- `<OLD>` → `<NEW>` values
- Grep verification output (verbatim)
- Commit SHA

---

### Task 5: Visual verification (human)

No code changes expected.

- [ ] **Step 1: Clean build**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

- [ ] **Step 2: Dev server + manual verification**

```bash
cd app/web && npm run dev
# or: VITE_API_BASE=http://<umbrel-ip>:3101 npm run dev
```

Open `/charts`. Check:

- All 5 tickers render with the correct colors:
  - BTC: amber
  - Gold: yellow
  - Corn: green
  - Soy: purple (new)
  - Wheat: amber-dim (darker amber)
- SVG icon stroke color matches the label color for each ticker.
- Dollar sign prefix on each price reads cleanly (not washed out).
- Unit text under each price is readable.
- Hovering a ticker shifts its background subtly.
- Border tint around loaded tickers is firmer than before.

Toggle theme via Settings (or DevTools `document.documentElement.dataset.theme = "light"`). Verify the tickers re-color correctly in both directions — no hardcoded hex bleeding through.

Save screenshots for the PR body (both themes).

- [ ] **Step 3: Fix any visual issues**

If something looks off, commit a `fix(web/charts): <what>` commit. If all good, skip to Task 6.

---

### Task 6: Push + open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/ui-charts
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --title "feat(web/charts): ticker strip polish (v<NEW>)" --body "$(cat <<'EOF'
## Summary

Charts ticker strip polish — the **seventh and final** page from the UI polish brief, after Settings (v1.12.1), Wizard (v1.13.1), Member Dashboard (v1.13.2), Treasury Dashboard (v1.13.3), Channels (v1.13.4), and Contacts (v1.13.5).

- **Token-ize hardcoded hex values** in the 5-ticker items array (BTC → \`var(--amber)\`, Gold → \`var(--yellow)\`, Corn → \`var(--green)\`, Soy → \`var(--purple)\` NEW, Wheat → \`var(--amber-dim)\`).
- **New \`--purple\` + \`--purple-glow\` tokens** in both dark and light \`:root\` blocks — the first token pair added since the initial palette.
- **SVG icons use \`stroke="currentColor"\`** and inherit color from the ticker's inline style. Theme switches cascade cleanly without per-icon tweaks.
- **Border color** uses \`color-mix()\` instead of the hex string-concat \`+"25"\` hack. Side effect: alpha bumps from ~14.5% to 25% for firmer ticker definition.
- **Readability tweaks**: unit text 9px → 10px, dollar sign opacity 0.5 → 0.65, hover adds a subtle background shift.
- Smallest polish PR after Contacts — 2 files touched, no logic changes.

Spec: \`docs/superpowers/specs/2026-04-24-charts-ticker-polish-design.md\`
Plan: \`docs/superpowers/plans/2026-04-24-charts-ticker-polish-implementation.md\`

**This completes the UI polish brief's attack order (7/7 pages shipped).**

## Version

**v<NEW>** on top of main's current version.

## Do-not-touch discipline

No changes to \`Charts.tsx\`, \`api/client.ts\`, any other component, or any other page. Only \`CommodityPricesPanel.tsx\` + \`styles.css\`.

## Test plan

- [x] \`cd app/web && npm run build\` clean after every commit
- [x] Visual verification: all 5 tickers render with correct colors, SVG icons match labels, dollar sign/unit readable, hover works, both themes cascade correctly

## Screenshots

(attach: ticker strip, dark + light themes, on \`/charts\`)

## Post-merge

1. Wait for \`Build and publish Docker images\` workflow (~5 min).
2. On Umbrel: \`cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0 && git pull\`
3. Hard-refresh Umbrel browser UI — v<NEW> update prompt appears.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Substitute `<NEW>` in `--title` with the actual version from Task 4.

- [ ] **Step 3: Report PR URL**

The output of `gh pr create` includes the PR URL.

---

## Post-merge checklist (reference, not steps)

- Wait for GitHub Actions `Build and publish Docker images` workflow to go ✅ (~5 min).
- On the Umbrel host:
  ```bash
  cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0
  git pull
  ```
- Hard-refresh the Umbrel browser UI — Update button appears on the BitCorn Lightning tile.

---

## Self-review notes

- The refactor in Task 2 touches 4 concerns (items array, SVG strokes, icon parent color, border color-mix) that all must land together — splitting them would leave the SVG icons uncolored between commits. Kept as one atomic commit.
- Task 3's transition addition (`background 0.2s`) is necessary or hover's new background shift will snap rather than animate. Subtle but important.
- `var(--amber-glow2)` for wheat glow is a 6%-alpha amber vs. the current 12%-alpha hardcoded `rgba(217,119,6,0.12)`. The visible difference on the icon box is negligible; if it looks too pale in visual check, can switch to `rgba(217,119,6,0.12)` hardcoded for wheat only (sacrificing one token-consistency point). Don't pre-emptively fix — wait for visual verification.
- Version cascade: Settings (1.12.1) → Wizard (1.13.1) → Member (1.13.2) → Treasury Dashboard (1.13.3) → Channels (1.13.4) → Contacts (1.13.5) → Charts (1.13.5 or 1.13.6). This PR will be the seventh and final bump.
- Tasks 1–3 each build and commit independently. Between Task 1 and Task 2, `--purple` is defined but unused; that's fine. Between Task 2 and Task 3, the tickers render with new colors but without the hover bg shift or readability tweaks; still functional.
