# Settings Page Polish — "Briefing Room" Design

- **Date:** 2026-04-22
- **Branch:** `feature/ui-settings` (off `main`)
- **Target version:** v1.12.1 (patch — UI only, no API changes)
- **Scope:** `SettingsPage` + its embedded panels in `app/web/src/App.tsx`, plus supporting CSS in `app/web/src/styles.css`.

## Mission

Give the Settings page a real visual hierarchy between personal preferences and operational controls, and make the operational panels feel like instruments the operator reads before editing. No backend changes, no new routes, no new data.

## Non-goals (explicitly out of scope)

- No changes to backend APIs (`getFeePolicy`, `setFeePolicy`, `getCapitalPolicy`, `setCapitalPolicy`, `setChannelRole`, `getMemberLiquidityStatus`).
- No changes to theme, font, or text-scale plumbing (`changeTheme`, `changeTextScale`, `applyFont`, `FONT_PRESETS`).
- No changes to any do-not-touch paths listed in `docs/UI_CONVENTIONS.md` — `AutoBuy.tsx`, `components/autoBuy/*`, `ValuationInput.tsx`, `cloudflare-worker/src/valuation/*`, `bitcorn-lightning-node/*`, `app/api/src/autoBuy/*`.
- No changes to other pages (Wizard, Channels, Contacts, etc.) — those are separate `feature/ui-*` branches per the polish brief.
- No new routes, no new components outside `App.tsx`, no migrations.
- No per-field auto-save; keep today's whole-policy POST contract.

## Structure

Three-section stack, with the Node row unlabeled at the bottom:

```
Settings
Preferences for your BitCorn node

─── PERSONAL ──────────────────────────────
  [Appearance]

─── [ OPERATIONS ] ────────────────────────    amber-tinted label
  [Channel Role]                (member only)
  [Routing Fee Policy]          (treasury only)
  [Capital Guardrails]          (treasury only)

  [Re-run Setup Wizard, small]  (treasury only, unlabeled)
```

A section is hidden entirely when it has zero panels for the current role (member view has no treasury panels, so the unlabeled Node row doesn't appear).

### Per-role layout

| Section | Member view | Treasury view |
|---|---|---|
| Personal | Appearance | Appearance |
| Operations | Channel Role | Routing Fee Policy, Capital Guardrails |
| (unlabeled row) | — | Re-run Setup Wizard |

`ChannelRolePanel` moves into Operations because it drives backend recommendations — it's config, not preference.

## Visual language

### Section labels

- New class `.settings-section-label` — small uppercase micro-label above a section.
  - Default: `color: var(--text-2)`, neutral `--border` horizontal rule on the right.
  - `.ops` variant: `color: var(--amber-dim)`, brackets around the label text (`[ OPERATIONS ]`), amber→border linear-gradient rule on the right.
- Top margin 18px above the label, 6px below it before the next panel.

### Operational panel chrome

Operational panels use a new `.panel.ops` variant with three layered cues:

1. **Amber border-top stripe** — `border-top: 2px solid var(--amber);` on `.panel.ops`.
2. **Amber-tinted header background** — `background: color-mix(in srgb, var(--amber) 6%, var(--bg-2));` on `.panel.ops .panel-header` (mixes amber into the existing `--bg-2` header bg so un-opsified panels still look consistent).
3. **Amber-dim header text + icon** — `color: var(--amber-dim);` on the header title (letter-spacing unchanged from existing `.panel-header`).

All three use existing CSS vars, so dark mode follows automatically. No new tokens introduced.

### Unlabeled "Re-run Setup Wizard" row (treasury)

Keep today's ghost-button layout but drop the `panel` wrapper and the "Treasury" section header. Render it as a small left-aligned `btn-ghost` (matches the existing `alignSelf: flex-start` pattern) with the existing help text below in `var(--text-3)`. Total visual weight equivalent to a footer row.

## Policy cards — read/edit interaction

The novel part of this PR. Applies to `FeePolicyPanel` and `CapitalPolicyPanel` only. Does **not** apply to `ChannelRolePanel` (which stays a 2-option picker).

### Read state (default)

Each policy field renders as a `.policy-card`:

- Grid: `1fr auto` — label+meta on the left, big value on the right.
- Label: 12px semibold, `var(--text)`.
- Meta/help: 10px, `var(--text-2)`, one or two lines.
- Value: IBM Plex Mono, ~17px, bold, right-aligned, `font-variant-numeric: tabular-nums` for column alignment across rows.
- Unit: 10px, `var(--text-3)`, subscript-right of value.
- Trailing `›` caret in `var(--text-3)` to signal interactivity.
- Card background: `var(--bg-2)` (slightly recessed against the panel body).
- `cursor: pointer`; hover = amber border + amber-wash background.

### Edit state

Triggered by (a) the panel-header "Edit" button, or (b) clicking any single card.

- All cards in the panel flip to inputs simultaneously (never just one).
- Card `background` becomes `var(--bg-1)`; border becomes `var(--amber)`.
- Large value becomes a text input with the existing inline-numeric pattern (comma-formatted via `Number.toLocaleString()`, digit-only `onChange` strip).
- Input width stays constant across the panel (150px treasury, 120px fee-rate) for column alignment.
- If triggered by clicking a specific card, that card gets `.focus` and `autoFocus` on its input.
- Panel header: "Edit" button disappears; "· editing" badge appears next to the title (amber, mono, lowercase); "N unsaved" counter appears on the right (`aria-live="polite"`).
- Bottom of the panel body gains an action row: `[Cancel] [Save Changes]`, right-aligned.

### Save / Cancel semantics

- **Save Changes** — single API call (same whole-policy POST as today). On success, show the existing "✓ Applied" flash in the header for 3s, then drop back to read state. On error, stay in edit mode, show the existing red error line above the action row.
- **Cancel** — revert local state to the last-loaded policy, drop back to read state. No API call.
- **Esc key** — same as Cancel, when edit mode is active and any input in the panel has focus.
- **Enter key** — native form submit on inputs is the existing behavior; we don't override it.

### Dirty counter

"N unsaved" in the header = count of cards whose current value differs from the last-loaded value. Already implied by today's `dirty` flag, just exposed visually. Updates on every `onChange`.

## Per-panel breakdown

### `AppearancePanel` (inline in `SettingsPage`)

- Theme chips: switch `fontFamily` from `var(--mono)` to `var(--sans)`. Keep existing selected-state styling, layout, and border color behavior.
- Text-size slider and font grid: no behavior, layout, or spacing changes.
- No `.panel.ops` chrome — stays Personal.

### `ChannelRolePanel` (member only)

- Gains `.panel.ops` chrome (amber border-top, tinted header, Operations section label above).
- Interior behavior unchanged — two stacked Merchant/Farmer option cards, immediate click-to-commit. The numeric cockpit doesn't fit a binary role choice.
- `.theme-option` styling is already defined in `styles.css`; no changes there.

### `FeePolicyPanel` (treasury only)

- Two policy cards: **Base Fee** (msat) and **Fee Rate** (ppm).
- Example-calculation box stays, but moves to *inside* the panel body between the two cards and the action row. Same visual treatment it has today.
- "Apply Fee Policy" button is replaced by the shared Cancel/Save action row in edit mode. Read mode shows no button.

### `CapitalPolicyPanel` (treasury only)

- All 8 fields from `POLICY_FIELDS` render as policy cards in a single column (vertical list — 2-column risks pairing unrelated fields).
- "Save Changes" button replaced by the shared Cancel/Save action row.
- Loading skeleton (4 shimmer rows) unchanged — still shown while `api.getCapitalPolicy()` resolves.

### Re-run Setup Wizard (treasury only)

- Strip the `.panel` wrapper and header.
- Render as a compact left-aligned `btn-ghost` (matches existing `alignSelf: flex-start`) with the existing help text below at `var(--text-3)`.
- Positioned below Capital Guardrails, outside both Personal and Operations sections.

## Accessibility

Matching precedent is fine for existing patterns, but since we're adding a new edit-mode affordance, layer in minimal ARIA:

- Edit button: `aria-pressed={isEditing}`.
- "N unsaved" counter: `aria-live="polite"`.
- Cards in read mode: `role="button"`, `tabindex="0"`, Enter/Space triggers the same handler as click.
- Esc key handler: scoped to the panel, only active while `isEditing` is true.

No focus trap is required (the panel is inline, not a modal). No overhaul of existing ARIA in Settings.

## Theme compatibility

All color values resolve from CSS vars (`--amber`, `--amber-dim`, `--border`, `--bg-1`, `--text`, `--text-2`, `--text-3`, `--bg-2`). Both dark and light mode must be screenshotted in the PR description per the polish brief. Hand-verify before opening the PR:

- Light: `--amber = #d97706`, reads correctly against cream panel backgrounds.
- Dark: `--amber = #f59e0b`, reads correctly against dark slate panels.
- The 6%-alpha amber wash and border-top stripe both work in either theme without color drift.

## Risks

1. **Novel interaction pattern.** No other page in the codebase uses a read-then-edit-mode toggle. If code review decides this shouldn't spread, it stays scoped to Settings (acceptable either way).
2. **Click-to-edit on whole card = larger hit target.** Accidental clicks during scrolling could enter edit mode. Mitigated by Esc-to-cancel + Cancel button both exiting cleanly with no dirty state, and Save remains disabled when nothing has changed.
3. **Channel Role contrast asymmetry.** It gets Operations chrome but doesn't get cards (it's role-picker, not numeric). Risk: it visually announces Operations but interior style doesn't match Fee Policy / Capital Guardrails. Acceptable — the chrome signals importance; the interior matches the interaction (binary choice, not field entry).

## Implementation surface

Files touched:

- `app/web/src/App.tsx` — `SettingsPage`, `ChannelRolePanel`, `FeePolicyPanel`, `CapitalPolicyPanel`. Rework render tree, add `isEditing` state + handlers to `FeePolicyPanel` and `CapitalPolicyPanel`. Extract `PolicyCard` as a local component inside `App.tsx` (no new file — matches existing file-layout convention).
- `app/web/src/styles.css` — new rules for `.settings-section-label` (+ `.ops` variant), `.panel.ops` (+ `.panel-header` overrides), `.policy-card` (+ `.editing`, `.focus` variants), `.policy-action-row`.

Files **not** touched:

- `app/web/src/api/client.ts` — API unchanged.
- `app/web/src/pages/*` — no other page changes.
- `app/api/**/*` — backend untouched.
- `bitcorn-lightning-node/**/*` — Umbrel manifests not bumped until PR is ready (patch bump = v1.12.1).

## Release notes line

> **v1.12.1** — Settings page polish: Personal / Operations section split, "briefing room" read-then-edit for Fee Policy + Capital Guardrails, Appearance typography cleanup.

## PR checklist (from the polish brief)

- [ ] Before + after screenshots attached.
- [ ] Dark + light theme both tested and attached.
- [ ] `cd app/web && npm run build` clean.
- [ ] Tested at a Tailscale IP (plain HTTP) — no clipboard / HTTPS-only regressions. (Settings has no clipboard actions today; confirm nothing added.)
- [ ] Version bumped in both `bitcorn-lightning-node/umbrel-app.yml` and `bitcorn-lightning-node/docker-compose.yml` image tags.
- [ ] Release-notes paragraph added to `umbrel-app.yml`.

## Appendix: conventions-doc drift noted during spec writing

`docs/UI_CONVENTIONS.md` (committed 2026-04-22) names three CSS tokens that don't exist in `app/web/src/styles.css`: `--panel`, `--text-dim`, `--text-mute`. Actual tokens are `--bg-1` (panel body bg), `--text-2` (secondary), `--text-3` (tertiary/muted). This spec uses the real tokens. Worth correcting the conventions doc in a follow-up.
