# Wizard Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Guided Ledger" Wizard polish on `feature/ui-wizard`: compress 5 → 4 steps, replace horizontal-dot step indicator with a vertical rail, carry Briefing Room chrome forward from Settings, and make Settings → Re-run Setup Wizard pre-populate from the current live policy.

**Architecture:** All changes happen in two existing files — `app/web/src/pages/Wizard.tsx` (structure + interaction) and `app/web/src/styles.css` (new rail CSS + tweaks to existing `.wizard-card` / `.wizard-header` rules). No new files, no new routes, no backend changes. The Review screen reuses `.policy-card` CSS classes from Settings — markup only, no component import. Version bump to v1.12.2 lands in the same PR as the final code commit.

**Tech Stack:** React 18 + TypeScript + Vite, CSS custom properties (light/dark theming already wired), IBM Plex Sans/Mono. Uses existing API client methods `api.getNode`, `api.getFeePolicy`, `api.getCapitalPolicy`, `api.setFeePolicy`, `api.setCapitalPolicy`.

**Spec:** `docs/superpowers/specs/2026-04-22-wizard-polish-design.md` for rationale, visual language, and risks.

---

## Preflight notes for the engineer

- **No automated test suite.** Verification per task = `npm run build` clean + visual check in `npm run dev` when relevant. Treat TDD-style steps as "build-verify + visual-verify" instead of "write test → fail → implement → pass".
- **Branch `feature/ui-wizard`**, off `main` (currently at `5d5ed2a`). Do not switch branches during implementation.
- **CSS tokens already in `:root`** (use these, don't invent new): `--bg`, `--bg-1`, `--bg-2`, `--bg-3`, `--border`, `--border-hi`, `--text`, `--text-2`, `--text-3`, `--amber`, `--amber-dim`, `--amber-glow`, `--amber-glow2`, `--mono`, `--sans`, `--radius-lg`.
- **Classes already in styles.css from Settings work** (reusable): `.policy-card`, `.policy-card-label`, `.policy-card-meta`, `.policy-card-value`, `.policy-card-value .unit`.
- **Do NOT touch**: `useAppStatus`, `App.tsx`, `api/client.ts`, anything under `app/api/`, anything in `components/autoBuy/`, `AutoBuy.tsx`, `ValuationInput.tsx`.
- **Always include the version bump in the same final push as code changes** — the Settings release required a follow-up PR because a late version bump raced with the PR merge. Don't repeat that.

---

## File Structure

### Files modified

- `app/web/src/pages/Wizard.tsx` — `WizardData` type (drop `treasuryPubkey`), `StepLine` (rewrite as vertical rail), `Screen1` (absorbs old Screen 2's info block), `Screen2` (deleted), renumbering `Screen3/4/5` → `Screen2/3/4`, `Screen5.rows` (rewritten as `.policy-card` markup), outer `Wizard` component (brand line, screens array, pre-population `useEffect`).
- `app/web/src/styles.css` — new rules `.wizard-step-rail`, `.wizard-rail-item`, `.wizard-rail-item.done`, `.wizard-rail-item.active`, `.wizard-rail-item.future`. Modify existing `.wizard-card` (add amber border-top) and `.wizard-header` (add amber-tinted background). Remove unused `.wizard-step-line`, `.wizard-step-dot` (+ `.done`, `.active`), `.wizard-step-connector`, `.wizard-step-label` rules after confirming no external references.
- `bitcorn-lightning-node/umbrel-app.yml` — bump `version` from `1.12.1` to `1.12.2`; prepend v1.12.2 release-notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — bump `api:1.12.1` and `web:1.12.1` image tags to `1.12.2`.

### Files NOT modified

- Anything outside `app/web/src/pages/Wizard.tsx`, `app/web/src/styles.css`, and the two Umbrel manifests.

### New components (no new files)

- None. `StepLine` rewrite stays in `Wizard.tsx`. No `PolicyCard` import — Review uses CSS classes only.

---

### Task 1: Add vertical step-rail CSS

**Files:**
- Modify: `app/web/src/styles.css` — append inside the `/* ─── Wizard ───────── */` section, after the existing `.wizard-step-label` rule (around line 945 post-Settings-commits). Do NOT delete the old rules yet; Task 10 handles that.

- [ ] **Step 1: Add the new rules**

```css
/* Vertical step rail (replaces horizontal dots in Guided Ledger polish) */
.wizard-step-rail {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wizard-rail-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--sans);
  font-size: 0.75rem;
  padding: 5px 0;
}
.wizard-rail-item .num {
  font-family: var(--mono);
  font-size: 0.6875rem;
  font-weight: 700;
  width: 18px;
  text-align: right;
  color: var(--text-3);
}
.wizard-rail-item .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border);
  flex-shrink: 0;
}
.wizard-rail-item .lbl {
  color: var(--text-3);
}
.wizard-rail-item.done .num { color: var(--amber-dim); }
.wizard-rail-item.done .dot { background: var(--amber-dim); }
.wizard-rail-item.done .lbl {
  color: var(--text-3);
  text-decoration: line-through;
  text-decoration-color: var(--text-3);
}
.wizard-rail-item.active .num { color: var(--amber); }
.wizard-rail-item.active .dot {
  background: var(--amber);
  box-shadow: 0 0 0 3px var(--amber-glow);
}
.wizard-rail-item.active .lbl {
  color: var(--text);
  font-weight: 600;
}
```

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: exit 0, clean build, no new warnings.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/wizard): add vertical step-rail CSS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Modify `.wizard-card` + `.wizard-header` for Briefing Room chrome

**Files:**
- Modify: `app/web/src/styles.css` — the existing `.wizard-card` and `.wizard-header` rules (lines ~885 and ~894 post-Settings-commits).

- [ ] **Step 1: Edit `.wizard-card` — add amber border-top**

Find the existing rule:
```css
.wizard-card {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 12px;
  width: 100%;
  max-width: 560px;
  position: relative;
}
```

Replace with:
```css
.wizard-card {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-top: 2px solid var(--amber);
  border-radius: 12px;
  width: 100%;
  max-width: 560px;
  position: relative;
}
```

- [ ] **Step 2: Edit `.wizard-header` — add amber-tinted background**

Find:
```css
.wizard-header {
  padding: 28px 32px 24px;
  border-bottom: 1px solid var(--border);
}
```

Replace with:
```css
.wizard-header {
  padding: 28px 32px 24px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--amber) 6%, var(--bg-2));
}
```

- [ ] **Step 3: Build**

Run: `cd app/web && npm run build`
Expected: exit 0 clean.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/wizard): apply Briefing Room chrome to wizard card

Amber border-top + amber-tinted header background (same treatment as
.panel.ops in Settings).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Drop `treasuryPubkey` from `WizardData`

This field was only ever a mirror of `detectedPubkey` (the treasury pubkey is an env var, never independently editable). Removing it simplifies state and the Review screen.

**Files:**
- Modify: `app/web/src/pages/Wizard.tsx`

- [ ] **Step 1: Inspect current references**

Run: `grep -n "treasuryPubkey" app/web/src/pages/Wizard.tsx`

Expected: 3 matches
- Type definition inside `WizardData` type (if declared in Wizard.tsx)
- Population site in `Screen1` (`patch({ detectedPubkey: pk, treasuryPubkey: pk })`)
- Read site in `Screen5`'s `rows` array (`truncPubkey(data.treasuryPubkey)` or similar — though the current `Screen5` uses `data.detectedPubkey` already; check by reading the current code)

If `WizardData` is imported from elsewhere, open that file. Otherwise edit inline.

- [ ] **Step 2: Remove the field from the type**

Find the type definition (search for `type WizardData` or `interface WizardData` in Wizard.tsx). Remove the `treasuryPubkey: string;` line.

- [ ] **Step 3: Remove the population in Screen 1**

Find the `patch({ detectedPubkey: pk, treasuryPubkey: pk })` call inside Screen 1's `useEffect`. Replace with:

```tsx
patch({ detectedPubkey: pk });
```

(Or `onNodeDetected(n.pubkey ?? "")` call site if the wrapper callback is the one updating both — check the current Screen 1 code and adjust so only `detectedPubkey` is set.)

- [ ] **Step 4: Remove the initializer default**

Find the `useState<WizardData>({...})` initial value. Remove the `treasuryPubkey: "",` line.

- [ ] **Step 5: Fix any remaining readers**

Run: `grep -n "treasuryPubkey" app/web/src/pages/Wizard.tsx`

Expected: 0 matches.

If any remain, they should be replaced with `detectedPubkey` (that was always their effective value).

- [ ] **Step 6: Build**

Run: `cd app/web && npm run build`
Expected: exit 0, zero TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add app/web/src/pages/Wizard.tsx
git commit -m "refactor(web/wizard): drop unused treasuryPubkey from WizardData

Field was only ever a mirror of detectedPubkey — treasury pubkey is an
env var, never independently editable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Rewrite `StepLine` as vertical rail + drop step count 5 → 4

**Files:**
- Modify: `app/web/src/pages/Wizard.tsx` — the `StepLine` function (currently around lines 19–36).

- [ ] **Step 1: Replace the StepLine function**

Find:
```tsx
function StepLine({ current, total }: { current: number; total: number }) {
  const labels = ["Node", "Identity", "Base Fee", "Policy", "Confirm"];
  return (
    <div>
      <div className="wizard-step-line">
        {Array.from({ length: total }).map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", flex: i < total - 1 ? 1 : 0 }}>
            <div
              className={`wizard-step-dot ${i < current ? "done" : i === current ? "active" : ""}`}
            />
            {i < total - 1 && <div className="wizard-step-connector" />}
          </div>
        ))}
      </div>
      <div className="wizard-step-label">{`Step ${current + 1} of ${total} — ${labels[current]}`}</div>
    </div>
  );
}
```

Replace with:
```tsx
function StepLine({ current, total }: { current: number; total: number }) {
  const labels = ["Detect node", "Base fee rate", "Capital guardrails", "Review & launch"];
  return (
    <div className="wizard-step-rail" role="list">
      {labels.slice(0, total).map((label, i) => {
        const state = i < current ? "done" : i === current ? "active" : "future";
        const num = String(i + 1).padStart(2, "0");
        return (
          <div
            key={label}
            className={`wizard-rail-item ${state}`}
            role="listitem"
            aria-current={state === "active" ? "step" : undefined}
            aria-label={state === "done" ? `${label} — complete` : undefined}
          >
            <span className="num">{num}</span>
            <span className="dot" />
            <span className="lbl">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Update the `StepLine` call site (step total)**

Find the call to `<StepLine current={step} total={5} />` inside the outer `Wizard` component's header (around line 549). Change `total={5}` to `total={4}`.

- [ ] **Step 3: Build**

Run: `cd app/web && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/pages/Wizard.tsx
git commit -m "feat(web/wizard): vertical step rail, 5 → 4 step count

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Merge Screen 2 info block into Screen 1

Absorbs the old Screen 2's `TREASURY_PUBKEY` env-var reminder alert into Screen 1, so Screen 2 can be removed in Task 6 without losing information.

**Files:**
- Modify: `app/web/src/pages/Wizard.tsx` — the `Screen1` function (currently around lines 40–145, ends around its own `return ... </div>);`).

- [ ] **Step 1: Add the info block inside Screen 1's JSX**

Open Screen 1. It currently shows node-detection status + detected pubkey card + Next button. At the END of Screen 1's content (below whatever it currently renders for the successful detection path, but BEFORE the `wizard-footer` with the Next button), insert the following info block (the same one that's in the current Screen 2):

```tsx
      <div className="alert info" style={{ marginTop: 12 }}>
        <span className="alert-icon">ℹ</span>
        <div className="alert-body">
          <div className="alert-msg">
            <code style={{ fontFamily: "var(--mono)" }}>TREASURY_PUBKEY</code> is an environment variable managed by Umbrel — it cannot be changed from the UI. Set it to the pubkey above in your Umbrel app settings before proceeding.
          </div>
        </div>
      </div>
```

Placement note: Screen 1's current structure is roughly:
```tsx
<div className="wizard-screen fade-in">
  <div className="wizard-title">Detect your node</div>
  <div className="wizard-subtitle">…</div>

  {/* existing node-info card(s) */}

  {/* === INSERT THE INFO BLOCK HERE, before the footer === */}

  <div className="wizard-footer" …>
    <button className="btn btn-primary" onClick={onNext}>Next →</button>
  </div>
</div>
```

The existing Screen 1 renders different content depending on loading / error / success state. Place the info block in the success path only (after the node-detected card, before the footer), not in the loading / error branches.

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: clean. No TypeScript errors.

- [ ] **Step 3: Visual sanity check (optional)**

`cd app/web && npm run dev` → navigate to `/setup` (trigger by clearing `localStorage.bitcorn_setup_done` if already set).
Confirm: Screen 1 shows detected pubkey AND the TREASURY_PUBKEY info block.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/pages/Wizard.tsx
git commit -m "feat(web/wizard): merge Screen 2 info block into Screen 1

Moves the TREASURY_PUBKEY env-var reminder inline so Screen 2 can be
removed entirely in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Delete Screen 2 and renumber Screens 3/4/5 → 2/3/4

Removes the now-redundant Screen 2 function and shifts all the downstream screens up by one index.

**Files:**
- Modify: `app/web/src/pages/Wizard.tsx`

- [ ] **Step 1: Delete the Screen 2 function entirely**

Find `function Screen2({ ... }) { ... }` (currently lines ~147–216). Delete the entire function including the section comment header above it (e.g. `// ─── Screen 2: … ─────` if present).

- [ ] **Step 2: Rename Screen 3 → Screen 2**

Find `function Screen3({ ... }) { ... }`. Rename to `function Screen2`. Update the section-comment header above it (e.g. from `// ─── Screen 3: Base Fee ─────` to `// ─── Screen 2: Base Fee ─────`).

- [ ] **Step 3: Rename Screen 4 → Screen 3**

Find `function Screen4({ ... }) { ... }`. Rename to `function Screen3`. Update comment header similarly.

- [ ] **Step 4: Rename Screen 5 → Screen 4**

Find `function Screen5({ ... }) { ... }`. Rename to `function Screen4`. Update comment header similarly.

- [ ] **Step 5: Update the `screens` array inside the outer `Wizard` component**

Find the `screens = [...]` array (currently around lines 523–538). It will be referencing Screen1 through Screen5 with 5 step indices. Replace with:

```tsx
  const screens = [
    <Screen1
      onNext={() => setStep(1)}
      onNodeDetected={(pk) => patch({ detectedPubkey: pk })}
    />,
    <Screen2 data={data} onChange={patch} onNext={() => setStep(2)} onBack={() => setStep(0)} />,
    <Screen3 data={data} onChange={patch} onNext={() => setStep(3)} onBack={() => setStep(1)} />,
    <Screen4
      data={data}
      onBack={() => setStep(2)}
      onConfirm={handleConfirm}
      saving={saving}
      error={saveError}
    />,
  ];
```

Note: the `onNodeDetected` callback sets only `detectedPubkey` — `treasuryPubkey` was already dropped in Task 3.

- [ ] **Step 6: Build**

Run: `cd app/web && npm run build`
Expected: clean. No TypeScript errors, no "Screen5 is not defined" or similar.

- [ ] **Step 7: Commit**

```bash
git add app/web/src/pages/Wizard.tsx
git commit -m "refactor(web/wizard): delete Screen 2, renumber Screens 3–5 → 2–4

Screen 2 was pure info (TREASURY_PUBKEY reminder); its content moved
into Screen 1 in the previous commit. Flow is now 4 steps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Add re-entry pre-population from live policy

Today the wizard always starts with hardcoded defaults. After this task, re-entry via Settings → Re-run Setup Wizard pre-populates from the current live fee + capital policies.

**Files:**
- Modify: `app/web/src/pages/Wizard.tsx` — the outer `Wizard` component's initial-state logic (around lines 483–497).

- [ ] **Step 1: Replace the `useState<WizardData>` initializer + add population useEffect**

Find:
```tsx
  const [data, setData] = useState<WizardData>({
    detectedPubkey: "",
    feeRatePpm: 500,
    minOnchainReserveSats: 100000,
    maxDeployRatioPct: 80,
    maxDailyLossSats: 5000,
  });

  const patch = (v: Partial<WizardData>) => setData((d) => ({ ...d, ...v }));
```

(Note: `treasuryPubkey: ""` was already removed in Task 3.)

Replace with:
```tsx
  const [data, setData] = useState<WizardData>({
    detectedPubkey: "",
    feeRatePpm: 500,
    minOnchainReserveSats: 100000,
    maxDeployRatioPct: 80,
    maxDailyLossSats: 5000,
  });

  const patch = (v: Partial<WizardData>) => setData((d) => ({ ...d, ...v }));

  // On mount, if a prior policy exists (re-entry via Settings → Re-run
  // Setup Wizard), pre-populate inputs from it. On first install the
  // API may return zeros/defaults, in which case we fall back to the
  // hardcoded defaults above.
  useEffect(() => {
    Promise.all([
      api.getFeePolicy().catch(() => null),
      api.getCapitalPolicy().catch(() => null),
    ]).then(([fee, capital]) => {
      const patch_: Partial<WizardData> = {};
      if (fee && fee.fee_rate_ppm > 0) {
        patch_.feeRatePpm = fee.fee_rate_ppm;
      }
      if (capital) {
        const c = capital as unknown as Record<string, number>;
        if (c.min_onchain_reserve_sats > 0) {
          patch_.minOnchainReserveSats = c.min_onchain_reserve_sats;
        }
        if (c.max_deploy_ratio_ppm > 0) {
          patch_.maxDeployRatioPct = Math.round(c.max_deploy_ratio_ppm / 10000);
        }
        if (c.max_daily_loss_sats > 0) {
          patch_.maxDailyLossSats = c.max_daily_loss_sats;
        }
      }
      if (Object.keys(patch_).length > 0) {
        setData((d) => ({ ...d, ...patch_ }));
      }
    });
  }, []);
```

- [ ] **Step 2: Confirm imports**

Run: `grep -nE "^import" app/web/src/pages/Wizard.tsx | head -10`

Expected: `useEffect` and `useState` imported from `"react"`. `api` imported. If `useEffect` is missing, add it.

- [ ] **Step 3: Build**

Run: `cd app/web && npm run build`
Expected: clean.

- [ ] **Step 4: Visual check (optional, requires prior policy)**

If you have a prior policy set: open `/settings` → click "Re-run Setup Wizard" → verify Step 2 (Base Fee Rate) shows your current rate, and Step 3 (Capital Guardrails) shows your current three limits. For fresh installs with no policy, defaults should appear.

- [ ] **Step 5: Commit**

```bash
git add app/web/src/pages/Wizard.tsx
git commit -m "feat(web/wizard): pre-populate inputs from live policy on re-entry

Re-running setup from Settings now fetches getFeePolicy +
getCapitalPolicy and seeds WizardData from the results, falling back
to hardcoded defaults when values are zero/missing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Rewrite Screen 4 (Review) with `.policy-card` markup

Replace the static list-with-dividers in the Confirm/Review screen with `.policy-card` read-state markup, matching the Settings page.

**Files:**
- Modify: `app/web/src/pages/Wizard.tsx` — `Screen4` function (was `Screen5`; post-rename this is the Review screen).

- [ ] **Step 1: Replace Screen4's return JSX**

Find the entire `Screen4` function. Its current shape (post-rename from Screen5) is roughly:

```tsx
function Screen4({ data, onBack, onConfirm, saving, error }: {
  data: WizardData;
  onBack: () => void;
  onConfirm: () => void;
  saving: boolean;
  error: string | null;
}) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Hub Pubkey (reference)", value: truncPubkey(data.detectedPubkey) },
    { label: "Base Fee Rate", value: `${data.feeRatePpm} ppm` },
    { label: "Min On-Chain Reserve", value: `${data.minOnchainReserveSats.toLocaleString()} sats` },
    { label: "Max Deploy Ratio", value: `${data.maxDeployRatioPct}%` },
    { label: "Max Daily Loss Cap", value: `${data.maxDailyLossSats.toLocaleString()} sats` },
  ];

  return (
    <div className="wizard-screen fade-in">
      <div className="wizard-title">Confirm & Launch</div>
      <div className="wizard-subtitle">Review the configuration before writing it to the node.</div>

      <div style={{ background: "var(--bg-2)", … }}>
        {rows.map(...)}
      </div>

      {error && (<div className="alert critical">…</div>)}

      <div className="wizard-footer" …>
        <button className="btn btn-ghost" onClick={onBack} disabled={saving}>← Back</button>
        <button className="btn btn-primary btn-lg" onClick={onConfirm} disabled={saving}>
          {saving ? "Saving…" : "Confirm & Launch ⚡"}
        </button>
      </div>
    </div>
  );
}
```

Replace it in full with:

```tsx
function Screen4({ data, onBack, onConfirm, saving, error }: {
  data: WizardData;
  onBack: () => void;
  onConfirm: () => void;
  saving: boolean;
  error: string | null;
}) {
  // Hub pubkey is displayed as a single smaller reference card above
  // the policy cards (no unit, truncated mono value).
  const policyCards: Array<{ label: string; meta: string; value: string; unit: string }> = [
    {
      label: "Base Fee Rate",
      meta: "Routing fee (ppm)",
      value: data.feeRatePpm.toLocaleString(),
      unit: "ppm",
    },
    {
      label: "Min On-Chain Reserve",
      meta: "Floor for automated opens",
      value: data.minOnchainReserveSats.toLocaleString(),
      unit: "sats",
    },
    {
      label: "Max Deploy Ratio",
      meta: "Share of funds deployable",
      value: String(data.maxDeployRatioPct),
      unit: "%",
    },
    {
      label: "Max Daily Loss Cap",
      meta: "Pauses automation if exceeded",
      value: data.maxDailyLossSats.toLocaleString(),
      unit: "sats",
    },
  ];

  return (
    <div className="wizard-screen fade-in">
      <div className="wizard-title">Review &amp; Launch</div>
      <div className="wizard-subtitle">
        Review the configuration before writing it to the node. All values are editable later under Settings.
      </div>

      <div className="policy-card" style={{ cursor: "default", marginBottom: 8 }}>
        <div>
          <div className="policy-card-label">Hub Pubkey</div>
          <div className="policy-card-meta">Reference — set via <code style={{ fontFamily: "var(--mono)" }}>TREASURY_PUBKEY</code> env var</div>
        </div>
        <div className="policy-card-value">
          {truncPubkey(data.detectedPubkey)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {policyCards.map((card) => (
          <div key={card.label} className="policy-card" style={{ cursor: "default" }}>
            <div>
              <div className="policy-card-label">{card.label}</div>
              <div className="policy-card-meta">{card.meta}</div>
            </div>
            <div className="policy-card-value">
              {card.value}
              <span className="unit">{card.unit}</span>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="alert critical" style={{ marginTop: 12 }}>
          <span className="alert-icon">✕</span>
          <div className="alert-body">
            <div className="alert-msg">{error}</div>
          </div>
        </div>
      )}

      <div className="wizard-footer" style={{ borderRadius: "0 0 12px 12px" }}>
        <button className="btn btn-ghost" onClick={onBack} disabled={saving}>← Back</button>
        <button
          className="btn btn-primary btn-lg"
          onClick={onConfirm}
          disabled={saving}
        >
          {saving ? "Saving…" : "Confirm & Launch ⚡"}
        </button>
      </div>
    </div>
  );
}
```

The `cursor: "default"` override disables the interactive pointer that `.policy-card` defaults to (from Settings, where cards are clickable). Review cards here are purely read-only.

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: clean.

- [ ] **Step 3: Visual check**

Navigate to `/setup`, advance through Steps 1–3, reach Review. Verify:
- Hub Pubkey card at top (with truncated mono value).
- 4 policy cards below with big mono values + unit subscripts.
- Confirm & Launch button at the bottom.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/pages/Wizard.tsx
git commit -m "feat(web/wizard): rewrite Review screen with .policy-card markup

Consistent with Settings — operators learn the card vocabulary during
setup that they'll see again on Settings → Capital Guardrails afterward.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Update brand line — replace SETUP badge with "· first-run setup" fragment

**Files:**
- Modify: `app/web/src/pages/Wizard.tsx` — the outer `Wizard` component's brand line inside the header (around line 544).

- [ ] **Step 1: Edit the brand line**

Find:
```tsx
          <div className="wizard-brand">
            <span style={{ fontSize: "1.25rem" }}>⚡</span>
            <span className="wizard-brand-mark">BITCORN LIGHTNING</span>
            <span className="topbar-tag">SETUP</span>
          </div>
```

Replace with:
```tsx
          <div className="wizard-brand">
            <span style={{ fontSize: "1.25rem" }}>⚡</span>
            <span className="wizard-brand-mark">BITCORN LIGHTNING</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--amber-dim)", letterSpacing: "0.04em" }}>
              · first-run setup
            </span>
          </div>
```

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/pages/Wizard.tsx
git commit -m "feat(web/wizard): replace SETUP pill with lowercase trailing badge

Matches the '· editing' badge language used on .panel.ops in Settings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Remove unused horizontal-dot CSS

After the StepLine rewrite, the old `.wizard-step-*` rules are no longer referenced. Remove them to keep the stylesheet clean.

**Files:**
- Modify: `app/web/src/styles.css`

- [ ] **Step 1: Confirm no remaining references**

Run each:
```bash
grep -n "wizard-step-line" app/web/src/
grep -n "wizard-step-dot" app/web/src/
grep -n "wizard-step-connector" app/web/src/
grep -n "wizard-step-label" app/web/src/
```

Expected: each returns only matches inside `app/web/src/styles.css` (the rule definitions themselves). If any match in a `.tsx` or `.ts` file, STOP — the class is still referenced somewhere, and it should not be deleted. Report as DONE_WITH_CONCERNS instead of deleting.

- [ ] **Step 2: Delete the four rule blocks**

In `app/web/src/styles.css`, find and delete these four rules (in order):

```css
.wizard-step-line {
  display: flex;
  align-items: center;
  gap: 0;
}

.wizard-step-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border-hi);
  transition: all 0.2s;
  flex-shrink: 0;
}

.wizard-step-dot.done    { background: var(--amber-dim); }
.wizard-step-dot.active  { background: var(--amber); box-shadow: 0 0 0 3px var(--amber-glow); }

.wizard-step-connector {
  flex: 1;
  height: 1px;
  background: var(--border);
}

.wizard-step-label {
  font-family: var(--mono);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-top: 8px;
}
```

Leave surrounding rules intact (e.g. `.wizard-body`, `.wizard-title`).

- [ ] **Step 3: Build**

Run: `cd app/web && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/styles.css
git commit -m "chore(web/wizard): remove unused horizontal-dot step CSS

No remaining references after the vertical step rail landed in Task 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Version bump to v1.12.2 + release notes

Include the bump in the same push as the final code commits — last release required a follow-up PR because a late bump raced with merge.

**Files:**
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

- [ ] **Step 1: Bump version in umbrel-app.yml**

Find:
```yaml
version: "1.12.1"
```
Replace with:
```yaml
version: "1.12.2"
```

- [ ] **Step 2: Prepend v1.12.2 release-notes paragraph**

Find the `releaseNotes:` block. The first paragraph is currently `v1.12.1: …`. Insert above it:

```yaml
  v1.12.2: Wizard polish. Trims first-run setup from 5 steps to 4 by
  folding the TREASURY_PUBKEY env-var reminder inline into the Node
  Detection step. New vertical step rail shows all step names at once.
  Applies the same amber border-top chrome used on the Settings page's
  operational panels, and renders the Review screen as read-state
  policy cards. Re-running setup from Settings now pre-populates from
  your current live policy instead of resetting to defaults.

  v1.12.1: Settings page polish. …
```

(Leave the existing `v1.12.1: …` paragraph below it unchanged.)

- [ ] **Step 3: Bump both image tags in docker-compose.yml**

Find:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/api:1.12.1
```
Replace with:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/api:1.12.2
```

Find:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/web:1.12.1
```
Replace with:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/web:1.12.2
```

- [ ] **Step 4: Verify version consistency**

Run:
```bash
grep -n "1.12." bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml | head -10
```

Expected output includes `version: "1.12.2"`, the new v1.12.2 release note line, `api:1.12.2`, `web:1.12.2`. The old `1.12.1` references should only persist in the prior release-notes paragraph.

- [ ] **Step 5: Commit**

```bash
git add bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
git commit -m "chore: bump to v1.12.2 for Wizard page polish

Umbrel manifest + compose image tags bumped together. Release notes
for v1.12.2 prepended.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Cross-theme + cross-role visual check (human)

No code changes expected. This is the polish-brief verification step.

- [ ] **Step 1: Build from clean one more time**

```bash
cd app/web && npm run build
```

Expected: exit 0. No TypeScript warnings about unused imports/variables.

- [ ] **Step 2: Dev server + manual verification**

```bash
cd app/web && npm run dev
```

As treasury role:

1. First-run path: clear `localStorage.bitcorn_setup_done` in devtools. Reload. Verify the wizard mounts with hardcoded defaults in Steps 2 and 3.
2. Re-entry path: navigate to `/settings`, click "Re-run Setup Wizard". Verify Steps 2 and 3 pre-populate with your current live policy.
3. For both paths, advance through all 4 steps. Screenshot each step in:
   - Dark theme
   - Light theme
4. Confirm the "Confirm & Launch" button is reachable (the wizard footer is styled correctly) in both themes.

Save screenshots for the PR description (suggested names: `wizard-step1-dark.png`, `wizard-step2-light.png`, etc.). Do NOT commit them.

- [ ] **Step 3: If any visual issue surfaces, fix and commit**

Small polish fixes commit as `fix(web/wizard): <what>`. If none, skip to Task 13.

---

### Task 13: Push branch + open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feature/ui-wizard
```

- [ ] **Step 2: Open PR with before/after screenshots**

```bash
gh pr create --base main --title "feat(web/wizard): Guided Ledger polish (v1.12.2)" --body "$(cat <<'EOF'
## Summary

Wizard polish, the second page from the UI polish brief after Settings.

- 5 → 4 steps. Old Screen 2 "Identity" was pure information (it displayed a read-only pubkey and reminded the operator to set TREASURY_PUBKEY as an env var). Its reminder is now inline on Step 1 ("Detect Node"), reducing ceremony.
- **Vertical step rail** in the header replaces the horizontal dots. Shows all 4 step names at once with done / active / future state, so operators can see where they are and what's ahead.
- **Briefing Room chrome** carries forward from Settings: 2px amber border-top on the wizard card, amber-tinted header background. Visual continuity between first-run setup and the pages the operator will use afterward.
- **Review screen uses `.policy-card` markup** — the same read-state cards operators will see on Settings → Capital Guardrails. Learning the vocabulary once.
- **Re-entry pre-populates from live policy.** Clicking "Re-run Setup Wizard" from Settings used to reset inputs to hardcoded defaults. Now it fetches `getFeePolicy` + `getCapitalPolicy` on mount and pre-fills the fields. First-install path is unchanged (defaults apply when values are missing/zero).
- Version bump to v1.12.2 is in the same PR this time (v1.12.1 required a follow-up PR because a late bump raced with the merge).

Spec: `docs/superpowers/specs/2026-04-22-wizard-polish-design.md`

## Test plan

- [x] `cd app/web && npm run build` clean
- [x] Dark + light theme both screenshot-verified
- [x] First-run path: hardcoded defaults apply
- [x] Re-entry via Settings: fields pre-populate from live policy
- [x] All 4 steps reachable, Back / Next work in both directions
- [x] Confirm commit calls the same two API endpoints in the same order (fee policy, capital policy) — unchanged backend contract

## Screenshots

(attach: treasury role, dark + light, all four steps)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL**

The output of `gh pr create` includes the PR URL. Report it back.

---

## Post-merge checklist (reference, not steps)

- Wait for `Build and publish Docker images` workflow to go ✅ (~5 min).
- On the Umbrel host: `cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0 && git pull` to refresh the community store cache.
- Hard-refresh the Umbrel browser UI — the Update button should appear on the BitCorn Lightning tile.

---

## Self-review notes

- Every `1.12.1` / `1.12.2` reference is spelled out in Task 11 to avoid version drift.
- Esc-to-cancel from Settings isn't reused here — the wizard has no edit mode that needs cancellation. Back button + onBack handlers cover the same concern.
- The `useEffect` in Task 7 has empty dep array `[]` — intentional, runs once on mount.
- `as unknown as Record<string, number>` cast in Task 7 matches the same pattern in `CapitalPolicyPanel` — the backend type is a typed interface, not a record, but the code treats it as one for simple field access. Acceptable pre-existing technical debt.
- Task 10 could leave the dead CSS in place if a grep finds stray references (report as DONE_WITH_CONCERNS) — favoring safety over tidiness.
- `aria-current="step"` on the active rail item matches the spec. `aria-label="{label} — complete"` on done items too. Future items get no ARIA (plain text; screen readers announce them naturally).
