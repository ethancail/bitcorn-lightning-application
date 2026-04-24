# Channels Page Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Chrome + Density" Channels page polish on `feature/ui-channels`: apply Briefing Room `.panel.ops` chrome to the 4 treasury lane panels (Merchant / Farmer / External / Unclassified) plus the Treasury Open Channel panel, and tighten lane-table row padding via a scoped `.panel.ops .data-table` descendant rule.

**Architecture:** Changes in two files: `app/web/src/App.tsx` (5 className edits total — 4 panels inside `ChannelsPage` plus the root of `TreasuryOpenChannelPanel`) and `app/web/src/styles.css` (one new rule-block scoped to `.panel.ops .data-table`). No backend changes, no logic changes, no component extraction. Version bump lands in the same PR.

**Tech Stack:** React 18 + TypeScript + Vite, CSS custom properties (light/dark already wired). Uses existing API methods (`/api/channels`, `getContacts`, `getLiquidityHealth`, `getPendingChannels`, `treasuryCloseChannel`) — no changes to any of them.

**Spec:** `docs/superpowers/specs/2026-04-24-channels-page-polish-design.md`.

---

## Preflight notes for the engineer

- **No automated test suite.** Verification per task = `cd app/web && npm run build` clean + visual check in `npm run dev` when relevant.
- **Branch `feature/ui-channels`** off `main` (currently at `b34fd2e`). Do not switch branches.
- **CSS tokens already in `:root`** (use, don't invent): `--bg-2`, `--border`, `--text-3`, `--amber`, `--amber-dim`, `--amber-glow2`.
- **Classes already in `styles.css`** (reusable): `.panel`, `.panel ops`, `.panel-header`, `.panel-title`, `.data-table` (+ `th`/`td`/hover rules), `.btn`, `.btn-sm`, `.btn-outline`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.badge-green`/`-amber`/`-red`/`-muted`.
- **Spec correction — "Projected Capital Needs" is an `.alert warning`, NOT a panel.** The spec's list of 6 panels includes it, but inspection of `app/web/src/App.tsx` line 1697 confirms it's rendered as `<div className="alert warning">`. The actual panel count is 5: 4 lane/table panels inside `ChannelsPage` + the `TreasuryOpenChannelPanel` root. The plan enumerates the 5.
- **Spec correction — `.btn-sm` is already applied.** The `closeBtn` helper at `app/web/src/App.tsx:1658` already renders `className="btn btn-outline btn-sm"`. No action-button size change needed; the plan's Task 4 is a verification-only step.
- **Do NOT touch**: member view branch (line 1951 onward), close-channel confirmation dialog (`.dialog-overlay`), lane classification logic (`merchantState`/`farmerState`/`externalState`), any API calls, any other page.
- **Include version bump in the same final push as code changes** — per the v1.12.1 lesson.

---

## File Structure

### Files modified

- `app/web/src/App.tsx` — 5 className edits (4 inside `ChannelsPage`, 1 in `TreasuryOpenChannelPanel` root). No logic changes.
- `app/web/src/styles.css` — append one new rule-block for `.panel.ops .data-table th`/`td`.
- `bitcorn-lightning-node/umbrel-app.yml` — patch version bump + prepend release-notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — bump both image tags.

### Files NOT modified

- Everything else. `api/client.ts`, all other page files, `App.tsx` shell routes, `components/*`, `cloudflare-worker/*`, `app/api/*`.

### No new files

All edits are in-place.

---

### Task 1: Add `.panel.ops .data-table` CSS

**Files:**
- Modify: `app/web/src/styles.css`

- [ ] **Step 1: Append the rule-block**

Find the existing `.data-table tr.negative-roi:hover td { ... }` rule (near line 664 of the current file, inside the `/* ─── Tables ─── */` section). Immediately after its closing `}`, append:

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

Rationale: scoping via the descendant selector `.panel.ops .data-table` means these overrides only apply to `.data-table` instances inside `.panel.ops` wrappers. Other `.data-table` consumers (`Peers.tsx`, `Payments.tsx`, `MemberLiquidity.tsx`, any pre-PR-#120 Dashboard.tsx table) keep their base padding.

- [ ] **Step 2: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0, no new CSS warnings.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/channels): scoped .data-table polish for .panel.ops lane tables

Tighter td/th padding and tighter letter-spacing on column headers.
Scoped via the .panel.ops descendant selector so other .data-table
consumers (Peers, Payments, MemberLiquidity) are unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Apply `.panel.ops` to 4 lane panels in `ChannelsPage`

Four mechanical className edits, all inside `ChannelsPage` (inline in `app/web/src/App.tsx`, function starts at line 1398). Each edit changes `"panel fade-in"` → `"panel ops fade-in"`.

**Files:**
- Modify: `app/web/src/App.tsx`

- [ ] **Step 1: Identify all 4 panel className occurrences in `ChannelsPage`**

Run:
```bash
grep -nE 'className="panel fade-in"' app/web/src/App.tsx | awk -F: '$1 >= 1398 && $1 <= 1950'
```

Expected output — four lines, one per panel (line numbers approximate):
- `1713: <div className="panel fade-in" style={{ marginBottom: 16 }}>` — Merchant Lanes
- `1775: <div className="panel fade-in" style={{ marginBottom: 16 }}>` — Farmer Lanes
- `1838: <div className="panel fade-in" style={{ marginBottom: 16 }}>` — External Routing Peers
- `1896: <div className="panel fade-in" style={{ marginBottom: 16 }}>` — Unclassified Channels

If the grep returns more or fewer than four lines in that range, STOP and report as DONE_WITH_CONCERNS. Lines 1951+ belong to the member view (out of scope) and should NOT be touched.

- [ ] **Step 2: Edit each of the 4 panels**

For each of the four lines identified above, change:
```tsx
<div className="panel fade-in" style={{ marginBottom: 16 }}>
```
to:
```tsx
<div className="panel ops fade-in" style={{ marginBottom: 16 }}>
```

The panels' `<div className="panel-header">` children (with the title + count badge) stay unchanged — they inherit the new chrome through the `.panel.ops .panel-header` CSS rule that already exists from the Settings polish PR.

- [ ] **Step 3: Verify edit count**

```bash
grep -c 'className="panel ops fade-in"' app/web/src/App.tsx
```

Expected: this returns the running total across the file. After this task, the count should be **4 higher** than before (the four you just edited). Earlier polish PRs (Settings, Wizard, Dashboards) may have other `.panel ops fade-in` usages — acceptable; only the 4 new ones in `ChannelsPage` matter for this task.

```bash
grep -nE 'className="panel fade-in"' app/web/src/App.tsx | awk -F: '$1 >= 1398 && $1 <= 1950'
```

Expected: no output (the 4 lane panels no longer match this pattern). If any remain, a panel was missed.

- [ ] **Step 4: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

- [ ] **Step 5: Commit**

```bash
git add app/web/src/App.tsx
git commit -m "feat(web/channels): apply .panel.ops to 4 lane panels

Merchant Lanes, Farmer Lanes, External Routing Peers, and Unclassified
Channels panels all gain amber border-top + tinted header. Inner table
content unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Apply `.panel.ops` to `TreasuryOpenChannelPanel` root

Single className edit in a separate function at `app/web/src/App.tsx:2115`.

**Files:**
- Modify: `app/web/src/App.tsx`

- [ ] **Step 1: Edit the root className**

Find (at line 2171 or thereabouts — inside `TreasuryOpenChannelPanel`'s return JSX):

```tsx
<div className="panel fade-in" style={{ marginTop: 16 }}>
```

Change to:

```tsx
<div className="panel ops fade-in" style={{ marginTop: 16 }}>
```

Note: the `style={{ marginTop: 16 }}` is different from the 4 lane panels' `marginBottom: 16`. That's intentional — this panel sits at the bottom of the page and uses top margin instead. Preserve the existing style attribute.

The `.panel-body` divs inside this panel (rendered at roughly lines 2189 and 2250) stay unchanged — they're children of the root and inherit chrome.

- [ ] **Step 2: Verify**

```bash
grep -nE 'className="panel.*fade-in"' app/web/src/App.tsx | awk -F: '$1 >= 2115 && $1 <= 2463'
```

Expected: one line, with `"panel ops fade-in"` at the location you just edited.

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0 clean.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/App.tsx
git commit -m "feat(web/channels): apply .panel.ops to TreasuryOpenChannelPanel root

Completes the chrome pass for treasury /channels — open-channel panel
at the bottom of the page matches the lane tables above.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Verify action buttons already use `.btn-sm` (no-op)

The spec called for adding `.btn-sm` to lane-table action buttons for visual consistency with Settings. Inspection of the code shows `closeBtn()` at `app/web/src/App.tsx:1654–1671` already renders `className="btn btn-outline btn-sm"`. This task is verification-only; no code changes expected.

**Files:**
- None modified.

- [ ] **Step 1: Confirm the helper uses `.btn-sm`**

```bash
sed -n '1654,1672p' app/web/src/App.tsx
```

Expected: the `<button>` element rendered by `closeBtn` has `className="btn btn-outline btn-sm"`. If the className does NOT include `btn-sm`, STOP and report as NEEDS_CONTEXT — the spec assumed it was already there; handling the change requires instruction.

- [ ] **Step 2: Report**

Report as DONE with "verified `.btn-sm` already applied at line 1658; no code changes needed". No commit for this task.

---

### Task 5: Version bump

Bump the patch version on both Umbrel manifest files. Include the bump in the same PR as code (per the v1.12.1 lesson).

**Files:**
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

- [ ] **Step 1: Check the current version on the branch (inherits from main)**

```bash
grep -nE "^version:" bitcorn-lightning-node/umbrel-app.yml
```

Record the current version. Possible values and target bumps:

- Current `1.13.1` (Treasury Dashboard #120 + Member Dashboard #121 both still open) → target `1.13.2`. When one of those Dashboard PRs merges first, this PR rebases and rebumps.
- Current `1.13.2` (one of #120/#121 merged) → target `1.13.3`.
- Current `1.13.3` (both #120 and #121 merged) → target `1.13.4`.
- Any other version: STOP and report as NEEDS_CONTEXT.

Substitute `<NEW>` (target version) and `<OLD>` (current version) throughout the rest of this task.

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

Find the `releaseNotes: >` block. The first paragraph currently starts with `v<OLD>: …`. Insert the v<NEW> paragraph ABOVE it (preserve 2-space YAML indentation, do NOT delete the v<OLD> paragraph):

```yaml
  v<NEW>: Channels page lane-table polish. Applies Briefing Room
  chrome (amber border-top + tinted header) to the 4 treasury lane
  panels (Merchant / Farmer / External / Unclassified) plus the
  Treasury Open Channel panel at the bottom. Tighter row padding on
  lane tables via a .panel.ops .data-table descendant rule — no
  spillover to other data-table consumers (Peers, Payments,
  MemberLiquidity). Member /channels view and close-channel dialog
  unchanged. No backend changes.
```

- [ ] **Step 4: Bump image tags in docker-compose.yml**

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

Expected: new version in both files, new release-notes line, no remaining `<OLD>` image tag lines (old version should persist only in the preserved release-notes paragraph).

- [ ] **Step 6: Commit**

```bash
git add bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
git commit -m "chore: bump to v<NEW> for Channels page polish

Umbrel manifest + compose image tags bumped together. Release notes
for v<NEW> prepended.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

## Report format for Task 5

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- `<OLD>` value → `<NEW>` value
- Verification grep output (verbatim)
- Commit SHA

---

### Task 6: Visual verification (human)

No code changes expected. Final pre-PR verification.

- [ ] **Step 1: Clean build**

```bash
cd app/web && npm run build
```

Expected: exit 0, no TypeScript warnings.

- [ ] **Step 2: Dev server + manual verification**

```bash
cd app/web && npm run dev
# or: VITE_API_BASE=http://<umbrel-ip>:3101 npm run dev
```

As treasury role, test:
- Dark theme, `/channels` — verify all 4 lane panels (Merchant / Farmer / External / Unclassified) have amber border-top + tinted header. Lane tables render with tighter row spacing. Treasury Open Channel panel at the bottom also has the chrome.
- Light theme, `/channels` — same checks.
- Visual consistency with Settings / Dashboard — the amber chrome should read identically across polished pages.

As member role, smoke-test:
- `/channels` — should render the "original channel list" (simpler flat list), UNCHANGED from today. If it inherits any amber chrome, investigate.

Also smoke-test other pages to verify the `.panel.ops .data-table` scoping didn't spillover:
- `/peers` (treasury only) — `.data-table` rows should keep today's `9px 12px` padding.
- `/payments` — same; table rows unchanged.
- `/liquidity` → Member Liquidity tables — same; rows unchanged.

Save screenshots for the PR body.

- [ ] **Step 3: Fix any visual issues**

If a visual issue surfaces (spacing, contrast, spillover, chrome misapplied), fix inline. Commit as `fix(web/channels): <what>`. If none, skip to Task 7.

---

### Task 7: Push + open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feature/ui-channels
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --title "feat(web/channels): treasury lane tables polish (v<NEW>)" --body "$(cat <<'EOF'
## Summary

Channels page polish — the fifth page from the UI polish brief, after Settings (v1.12.1), Wizard (v1.13.1), Treasury Dashboard (PR #120, pending), and Member Dashboard (PR #121, pending).

- **`.panel.ops` chrome** applied to all 4 treasury lane panels (Merchant / Farmer / External / Unclassified) plus the Treasury Open Channel panel at the bottom. Amber border-top + amber-tinted header, matching the Briefing Room aesthetic from Settings / Wizard / Dashboard pages.
- **Tighter row padding** on lane tables via a scoped `.panel.ops .data-table` descendant CSS rule. Other `.data-table` consumers (Peers, Payments, MemberLiquidity, any pre-polish Dashboard) are unaffected — the new rule only applies to tables inside `.panel.ops` wrappers.
- **No changes** to the member view branch (the "original channel list" rendered when `nodeRole !== "treasury"` or loading or empty), the close-channel confirmation dialog, lane classification logic (`merchantState`/`farmerState`/`externalState`), or any API call.
- Action buttons (Renew Now / Renew Soon / Close) already use `.btn-sm` per `closeBtn` helper at line 1658 — no change needed there.

Spec: \`docs/superpowers/specs/2026-04-24-channels-page-polish-design.md\`
Plan: \`docs/superpowers/plans/2026-04-24-channels-page-polish-implementation.md\`

## Version

**v<NEW>** (sized at commit time based on main's current version — Treasury PR #120 and Member PR #121 may have shifted the base).

## Do-not-touch discipline

No changes to `Dashboard.tsx`, `MemberDashboard.tsx`, `Settings`, `Wizard.tsx`, `AutoBuy.tsx`, `components/autoBuy/*`, `ValuationInput.tsx`, `ConnectToHub`, `api/client.ts`, `cloudflare-worker/*`, or anything under `app/api/`.

## Test plan

- [x] \`cd app/web && npm run build\` clean after every commit
- [x] Dark + light theme visually verified on \`/channels\` (treasury)
- [x] Member \`/channels\` smoke-tested — unchanged
- [x] Other \`.data-table\` pages smoke-tested (Peers, Payments, MemberLiquidity) — padding unchanged
- [x] Close-channel dialog smoke-tested — modal styling unchanged
- [x] Action buttons render at `.btn-sm` size (already verified; no change needed)

## Screenshots

(attach: treasury + dark with multi-state channels, treasury + light, member + either theme)

## Post-merge

1. Wait for \`Build and publish Docker images\` workflow (~5 min).
2. On Umbrel: \`cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0 && git pull\`
3. Hard-refresh Umbrel browser UI — v<NEW> update prompt appears.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Substitute `<NEW>` in the `--title` string with the actual version from Task 5.

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

- **Spec said 6 panels, actual count is 5.** The spec's 6th panel ("Projected Capital Needs") is actually an `.alert warning` (line 1697), not a panel. The plan's Task 2 enumerates the correct 4 lane panels; Task 3 covers `TreasuryOpenChannelPanel`. No 6th target exists.
- **Spec said add `.btn-sm` to action buttons; already done.** `closeBtn` helper at line 1658 renders `className="btn btn-outline btn-sm"` today. Task 4 is a verification-only check.
- **`.panel.ops .data-table` descendant scoping** means Peers / Payments / MemberLiquidity tables are unaffected. Implementer must verify by smoke-testing those pages in Task 6.
- **Task 1's CSS addition must land after `.data-table`'s base rules** so the overrides take precedence via cascade (descendant specificity `.panel.ops .data-table th` beats `.data-table th`). Placing the new rule block immediately after the `.data-table` section satisfies this naturally.
- **Merge collision with PRs #120 / #121** on the version bump is the expected pattern. Whichever of the three PRs merges last gets to keep the highest version number; prior ones rebase to v1.13.3 / v1.13.4 accordingly.
