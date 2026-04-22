# Wizard Page Polish — "Guided Ledger" Design

- **Date:** 2026-04-22
- **Branch:** `feature/ui-wizard` (off `main` after PR #117 merged)
- **Target version:** v1.12.2 (patch — UI only, no API changes)
- **Scope:** `app/web/src/pages/Wizard.tsx` + supporting CSS in `app/web/src/styles.css`.

## Mission

Polish the treasury first-run setup wizard to match the Briefing Room aesthetic direction landed with Settings in v1.12.1, and trim 5 steps to 4 by folding the information-only "Identity" screen into the node-detection screen. Re-entry via Settings → "Re-run Setup Wizard" becomes a review-and-tweak experience by pre-populating the current live policy instead of resetting to defaults.

## Context

The wizard is **treasury-only**, not member onboarding. `useAppStatus` in `app/web/src/App.tsx` routes treasury nodes whose policy is unset (or whose initial metrics call fails) to status `"treasury_setup"` → `/setup` → `Wizard`. Member nodes (`node_role === "node"`) skip the wizard entirely and get MemberDashboard with an inline "Connect to Hub" CTA. The only other entry into the wizard is via Settings → "Re-run Setup Wizard" on the treasury view, which clears `localStorage.bitcorn_setup_done` and navigates to `/setup`.

First-install frequency is "once per treasury operator", but re-entry frequency is "whenever the operator wants to retune policy through a guided flow" — which today is friction-heavy because the wizard resets inputs to hardcoded defaults.

## Non-goals (explicitly out of scope)

- No backend changes. All four API calls (`getNode`, `setFeePolicy`, `getCapitalPolicy`, `setCapitalPolicy`) keep their existing signatures and call order.
- No change to `useAppStatus` routing, `bitcorn_setup_done` localStorage gating, or `treasury_setup` status logic.
- No changes to validation ranges, commit semantics, or the Confirm-screen's two-call sequence.
- No member-side onboarding work — there isn't one, and this PR doesn't add one.
- No changes to any do-not-touch path in `docs/UI_CONVENTIONS.md` — `AutoBuy.tsx`, `components/autoBuy/*`, `ValuationInput.tsx`, `cloudflare-worker/src/valuation/*`, `bitcorn-lightning-node/*` manifest lifecycle, `app/api/src/autoBuy/*`.
- No new routes, no new API client methods, no new components outside the wizard file.

## Flow: 5 steps → 4

### Today's flow

| # | Label | Purpose |
|---|---|---|
| 1 | Node | LND connection check, detects `pubkey` |
| 2 | Identity | Read-only display of detected pubkey + paragraph reminding user to set `TREASURY_PUBKEY` env var in Umbrel |
| 3 | Base Fee | Sets `feeRatePpm` |
| 4 | Policy | Sets three capital guardrails |
| 5 | Confirm | Static review list + single commit button |

### Polished flow

| # | Label | Purpose |
|---|---|---|
| 1 | **Detect Node** | LND connection check + inline `TREASURY_PUBKEY` env-var reminder (absorbs old Step 2) |
| 2 | **Base Fee Rate** | Sets `feeRatePpm` (unchanged data model) |
| 3 | **Capital Guardrails** | Three policy fields (unchanged data model) |
| 4 | **Review & Launch** | Policy-card read-state review + commit button |

Screen 2 disappears because its only job was surfacing information, not collecting input. Its content (detected-pubkey confirmation card + `TREASURY_PUBKEY` env-var reminder alert) moves inside the new Step 1 as a bordered info block below the node-detection status.

## Re-entry pre-population (new)

On mount, the wizard fetches `api.getFeePolicy()` and `api.getCapitalPolicy()` in parallel. Initial state becomes:

- `feeRatePpm` = fetched `fee_rate_ppm` if non-zero, else the existing default `500`.
- `minOnchainReserveSats` = fetched `min_onchain_reserve_sats` if non-zero, else `100000`.
- `maxDeployRatioPct` = fetched `max_deploy_ratio_ppm / 10000` if set, else `80`.
- `maxDailyLossSats` = fetched `max_daily_loss_sats` if > 0, else `5000`.

Fallback rule: use fetched value when the response is present AND looks "set" (not zero / not missing); otherwise use the current hardcoded default. On first-install the API calls will typically succeed but return zeros for fee rate and empty/default policy — fallbacks kick in naturally. API failure is non-fatal: the wizard falls back to defaults silently.

## `WizardData` shape cleanup

Drop the `treasuryPubkey` field from the `WizardData` type. It was populated by `patch({ detectedPubkey: pk, treasuryPubkey: pk })` in Screen 1 and only referenced by Screen 2's display — always equal to `detectedPubkey` because the pubkey is an env var, not user input. All remaining references to `data.treasuryPubkey` resolve to `data.detectedPubkey`.

Audit before committing: grep `treasuryPubkey` inside `Wizard.tsx`, verify all call sites are reachable from the 4 new screens, replace with `detectedPubkey`.

## Visual chrome

### Wizard card

- **Border-top**: `2px solid var(--amber)` — mirrors `.panel.ops` from Settings.
- **Border-radius / max-width / body padding**: unchanged (`12px` / `560px` / `28px 32px`).
- **Header background**: `color-mix(in srgb, var(--amber) 6%, var(--bg-2))` — same wash as `.panel.ops .panel-header`, supplants today's transparent background.
- **Border-bottom between header and body**: kept (`1px solid var(--border)`).

### Brand line

Stays `⚡ BITCORN LIGHTNING` with existing mono/amber styling. The `SETUP` badge changes from a `.topbar-tag` pill to a trailing amber-dim mono fragment reading `· first-run setup` (letter-spacing 0.04em, text-transform none). Matches the `· editing` badge language from Settings.

### Step rail (replaces horizontal dots)

Vertical list in the header, four rows:

```
01  ●  Detect node
02  ●  Base fee rate
03  ●  Capital guardrails
04  ●  Review & launch
```

- Each row: fixed-width mono number (18px column), dot (6px), label.
- **Done rows**: number `var(--amber-dim)`, dot solid `var(--amber-dim)`, label `var(--text-3)` with a faint strikethrough.
- **Active row**: number `var(--amber)`, dot solid `var(--amber)` with `box-shadow: 0 0 0 3px var(--amber-glow)` ring, label `var(--text)` semibold.
- **Future rows**: number + label both `var(--text-3)`, dot `var(--border)`.
- New CSS classes: `.wizard-step-rail`, `.wizard-rail-item`, `.wizard-rail-item.done`, `.wizard-rail-item.active`, `.wizard-rail-item.future`.

Removes the "Step X of N — Label" caption underneath (redundant with the rail).

### Retire horizontal-dot CSS

The existing `.wizard-step-line`, `.wizard-step-dot` (`.done`, `.active`), `.wizard-step-connector`, `.wizard-step-label` rules in `styles.css` become unused after the `StepLine` rewrite. Grep `.wizard-step-` across `app/web/` before deletion; if only `Wizard.tsx` used them, delete. This keeps the stylesheet aligned with shipped code.

### Body typography

`.wizard-title` (`1.25rem`, semibold), `.wizard-subtitle` (`0.875rem`, `var(--text-2)`), `.wizard-body { padding: 28px 32px }` all unchanged. Field labels use `.form-label`/`.form-input`/`.form-helper` as today.

### Step 4 "Review & Launch" — policy-card styling

Replace the current static list-with-dividers inside `Screen5` with `.policy-card` read-state markup (CSS-only reuse — no import of `PolicyCard` from `App.tsx`). Four cards, same order as today:

| Label | Meta | Value | Unit |
|---|---|---|---|
| Base Fee Rate | Routing fee (ppm) | `feeRatePpm.toLocaleString()` | ppm |
| Min On-Chain Reserve | Floor for automated opens | `minOnchainReserveSats.toLocaleString()` | sats |
| Max Deploy Ratio | Share of funds deployable | `maxDeployRatioPct` | % |
| Max Daily Loss Cap | Pauses automation if exceeded | `maxDailyLossSats.toLocaleString()` | sats |

Cards rendered non-interactive on the Review screen (no click-to-edit, no caret). Use the CSS classes `.policy-card`, `.policy-card-label`, `.policy-card-meta`, `.policy-card-value`, `.policy-card-value .unit`. Drop the trailing `›` caret markup for this screen.

The "Hub Pubkey (reference)" row the current Confirm shows becomes a single smaller card above the policy cards, in the same style but with a truncated mono pubkey as the value — no unit.

### Screen 1 — TREASURY_PUBKEY info block

Under the detected-pubkey card, add the info block that used to live on Screen 2:

```tsx
<div className="alert info" style={{ marginTop: 4 }}>
  <span className="alert-icon">ℹ</span>
  <div className="alert-body">
    <div className="alert-msg">
      <code style={{ fontFamily: "var(--mono)" }}>TREASURY_PUBKEY</code> is an
      environment variable managed by Umbrel — it cannot be changed from the UI.
      Set it to this pubkey in your Umbrel app settings before proceeding.
    </div>
  </div>
</div>
```

The alert-info styling already exists. No new CSS required for this block.

### Buttons

`.btn-ghost` / `.btn-primary` / `.btn-primary.btn-lg` unchanged. Footer layout (`.wizard-footer`) unchanged. Confirm-screen `Confirm & Launch ⚡` button keeps `.btn-lg` treatment.

## Accessibility

- Step-rail items: active row carries `aria-current="step"`. Done rows carry `aria-label="{label} — complete"`. Future rows use plain text (no ARIA).
- No focus-trap on the wizard (it's a full-page route, not a modal).
- Numeric inputs retain existing `<label className="form-label">` wrapping. No change.
- Existing `.btn:focus-visible` styles in `styles.css` continue to handle keyboard focus rings — no wizard-specific overrides.

## Theme compatibility

All new and modified styles resolve through CSS vars. Tokens used:

- Backgrounds: `--bg`, `--bg-1`, `--bg-2`
- Borders: `--border`, `--border-hi`
- Text: `--text`, `--text-2`, `--text-3`
- Amber: `--amber`, `--amber-dim`, `--amber-glow`
- Type families: `--mono`, `--sans`

Both dark and light mode must be screenshotted in the PR description per the polish brief. Specifically verify:

- Amber border-top reads correctly against both `--bg-1` (card base) values.
- Header's `color-mix` wash doesn't blow out contrast in light mode.
- Step-rail active-dot ring remains visible in both themes.
- Policy-card review values maintain readability in light mode.

## Risks

1. **Dropped `treasuryPubkey` field.** A type-narrowing change. Other files do not import `WizardData`, but any future reader of old memory or code may expect the field. Mitigation: the field was only ever a mirror of `detectedPubkey`; the audit grep catches all call sites.
2. **Vertical step-rail header is taller** than today's horizontal dots. Body area shrinks. Acceptable per mockup at 560px card width; might revisit if additional steps are ever added.
3. **Re-entry pre-population assumes the policy endpoints return the currently-live values.** They do (confirmed by `useAppStatus` gating on the same `getFeePolicy` call). If the backend contract ever changes such that these return stale data, the wizard's defaults-fallback will trigger incorrectly.

## Implementation surface

Files modified:

- `app/web/src/pages/Wizard.tsx` — restructure 5 screens to 4, absorb old Screen 2 into Screen 1, rewrite `StepLine` as a vertical rail, rewrite `Screen5` review block to use policy-card markup, add pre-population `useEffect`, drop `treasuryPubkey` from `WizardData`.
- `app/web/src/styles.css` — add `.wizard-step-rail` + `.wizard-rail-item` rules; modify `.wizard-card` (amber border-top) and `.wizard-header` (tinted background) rules; remove the unused `.wizard-step-line` / `.wizard-step-dot` / `.wizard-step-connector` / `.wizard-step-label` rules after confirming they are only referenced by the old `StepLine`.

Files **not** touched:

- `app/web/src/App.tsx` — `useAppStatus` logic, `SettingsPage`, and all other routes unchanged.
- `app/web/src/api/client.ts` — API unchanged.
- `bitcorn-lightning-node/*` — manifests bumped in the same PR once code is ready.

## Release notes line

> **v1.12.2** — Wizard polish: 5 → 4 steps (TREASURY_PUBKEY reminder merges into step 1), vertical step rail showing all step names, Briefing Room chrome consistent with the Settings page. Re-running setup from Settings now pre-populates from your current live policy.

## PR checklist (per polish brief)

- [ ] Before + after screenshots attached.
- [ ] Dark + light theme both tested + attached.
- [ ] `cd app/web && npm run build` clean.
- [ ] Re-entry via Settings → Re-run Setup Wizard tested: verify inputs pre-populate from live policy.
- [ ] First-run path tested: verify fallbacks kick in when API returns empty / zero values.
- [ ] Version bumped in both `bitcorn-lightning-node/umbrel-app.yml` and `bitcorn-lightning-node/docker-compose.yml` — land the bump in the same push as the final code changes to avoid the race condition that required a follow-up PR last release.
- [ ] Release-notes paragraph added to `umbrel-app.yml`.
