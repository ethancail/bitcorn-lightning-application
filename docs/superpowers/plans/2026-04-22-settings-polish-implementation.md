# Settings Page Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Briefing Room" polish of the Settings page on `feature/ui-settings`: section hierarchy (Personal / Operations), operational panel chrome, and a read-then-edit interaction on Fee Policy + Capital Guardrails panels.

**Architecture:** All changes happen in two existing files — `app/web/src/styles.css` (new CSS classes) and `app/web/src/App.tsx` (`SettingsPage` + its panels). No new files, no new routes, no backend changes. A local `PolicyCard` component is defined inside `App.tsx` and consumed by `FeePolicyPanel` + `CapitalPolicyPanel` (DRY). The whole-policy single-POST save contract is preserved.

**Tech Stack:** React 18 + TypeScript + Vite, CSS custom properties (light/dark theming already wired), IBM Plex Sans/Mono.

**Spec:** See `docs/superpowers/specs/2026-04-22-settings-polish-design.md` for rationale, visual language, and risks.

---

## Preflight notes for the engineer

- **No automated test suite exists in this repo.** CLAUDE.md confirms this. Verification per task = `npm run build` clean + visual check in `npm run dev` (localhost:3200). Treat the TDD-style steps below as "build + visual-verify" instead of "write test → fail → implement → pass".
- **You're on branch `feature/ui-settings`**, off `main`. Do not switch branches during implementation. Commit early and often.
- **Existing tokens you will use** (these exist in `styles.css`; don't invent new ones):
  - Backgrounds: `--bg`, `--bg-1`, `--bg-2`, `--bg-3`
  - Borders: `--border`, `--border-hi`
  - Text: `--text`, `--text-2`, `--text-3`
  - Amber: `--amber`, `--amber-dim`, `--amber-glow` (12%), `--amber-glow2` (6%)
  - Type families: `--mono`, `--sans`
  - `--radius-lg` for panel rounding
- **Do NOT import anything from `components/autoBuy/*`** — they're page-specific. Do not touch `AutoBuy.tsx` or `ValuationInput.tsx`.
- **The theme chips in `SettingsPage` currently set `fontFamily: "var(--mono)"` inline** — that's what we're removing. Leave the slider + font grid alone.

---

## File Structure

### Files modified

- `app/web/src/styles.css` — new rules appended near the existing `.panel` section: `.settings-section-label` (+ `.ops` variant), `.panel.ops` (+ `.panel-header` + `.panel-title` overrides), `.policy-card` (+ `.editing`, `.focus`), `.policy-action-row`.
- `app/web/src/App.tsx` — `SettingsPage` render tree (section labels, Re-run Wizard row), `ChannelRolePanel` / `FeePolicyPanel` / `CapitalPolicyPanel` (`.panel.ops` class), theme-chip font fix, new `PolicyCard` local component, `FeePolicyPanel` + `CapitalPolicyPanel` converted to read/edit mode.

### Files NOT modified

- Any file outside `app/web/src/` — no backend, no Umbrel manifest, no API client.
- `app/web/src/pages/*` and `app/web/src/components/*` — no other page or component touched.

### New components (no new files)

- `PolicyCard` — local component defined inside `App.tsx`, near the existing panel functions. Props: `{ id, label, meta, value, unit, inputWidth, isEditing, isFocused, onEditRequest, onValueChange }`. Renders read-state card or edit-state input based on `isEditing`.

---

### Task 1: Add section-label CSS

**Files:**
- Modify: `app/web/src/styles.css` — append after the `.panel-body { padding: 20px; }` line (around line 212) OR at the end of the file; location only matters for readability.

- [ ] **Step 1: Add the CSS rules**

```css
/* ─── Settings page: section labels ───────────────────────────── */
.settings-section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 2px 6px;
  font-family: var(--sans);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
}
.settings-section-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
  opacity: 0.8;
}
.settings-section-label.ops {
  color: var(--amber-dim);
}
.settings-section-label.ops::after {
  background: linear-gradient(to right, var(--amber) 0%, var(--border) 100%);
  opacity: 0.6;
}
/* First label in the stack has less top margin */
.settings-section-label:first-child { margin-top: 8px; }
```

- [ ] **Step 2: Build to verify CSS parses**

Run: `cd app/web && npm run build`
Expected: build completes without CSS errors. Bundle size may increase slightly.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/settings): add section-label CSS (Personal / Operations)"
```

---

### Task 2: Add `.panel.ops` chrome CSS

**Files:**
- Modify: `app/web/src/styles.css` — append after the Task 1 rules.

- [ ] **Step 1: Add the CSS rules**

```css
/* ─── Settings page: operational panel variant ────────────────── */
.panel.ops {
  border-top: 2px solid var(--amber);
}
.panel.ops .panel-header {
  background: color-mix(in srgb, var(--amber) 6%, var(--bg-2));
}
.panel.ops .panel-title {
  color: var(--amber-dim);
}
.panel.ops .panel-title .icon {
  color: var(--amber);
}
```

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: build completes cleanly.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/settings): add .panel.ops chrome (amber border + tinted header)"
```

---

### Task 3: Add `.policy-card` read/edit CSS

**Files:**
- Modify: `app/web/src/styles.css` — append after the Task 2 rules.

- [ ] **Step 1: Add the CSS rules**

```css
/* ─── Settings page: policy cards (read + edit states) ───────── */
.policy-card {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 10px 14px;
  padding: 10px 12px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 5px;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
  text-align: left;
  font: inherit;
  color: inherit;
  width: 100%;
}
.policy-card:hover:not(.editing) {
  border-color: var(--amber);
  background: var(--amber-glow2);
}
.policy-card:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 2px;
}
.policy-card .policy-card-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text);
}
.policy-card .policy-card-meta {
  margin-top: 1px;
  font-size: 0.625rem;
  line-height: 1.3;
  color: var(--text-2);
}
.policy-card .policy-card-value {
  font-family: var(--mono);
  font-size: 1.0625rem;
  font-weight: 700;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  white-space: nowrap;
}
.policy-card .policy-card-value .unit {
  margin-left: 4px;
  font-size: 0.625rem;
  font-weight: 400;
  color: var(--text-3);
  letter-spacing: 0.04em;
}
.policy-card .policy-card-caret {
  margin-left: 6px;
  font-family: var(--mono);
  font-size: 0.625rem;
  letter-spacing: 0.06em;
  color: var(--text-3);
}

.policy-card.editing {
  background: var(--bg-1);
  border-color: var(--amber);
  cursor: default;
}
.policy-card.editing:hover { background: var(--bg-1); }
.policy-card.editing.focus {
  box-shadow: 0 0 0 2px var(--amber-glow);
}
.policy-card .policy-card-edit {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}
.policy-card .policy-card-edit input {
  font-family: var(--mono);
  font-size: 0.9375rem;
  font-weight: 700;
  text-align: right;
  font-variant-numeric: tabular-nums;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  color: var(--text);
}
.policy-card .policy-card-edit input:focus {
  outline: none;
  border-color: var(--amber-dim);
}
.policy-card .policy-card-edit .unit {
  font-family: var(--mono);
  font-size: 0.625rem;
  color: var(--text-3);
  min-width: 32px;
  font-weight: 400;
  letter-spacing: 0.04em;
}

.policy-action-row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 4px;
}
```

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/styles.css
git commit -m "feat(web/settings): add policy-card read/edit styles"
```

---

### Task 4: Restructure `SettingsPage` render tree with section labels

Rewrite the return statement of `SettingsPage` (currently at `app/web/src/App.tsx:588-687`) so panels are grouped under section labels. Move the Re-run Setup Wizard out of its panel wrapper into a plain row at the bottom.

**Files:**
- Modify: `app/web/src/App.tsx` — the `return (...)` block inside `SettingsPage`, roughly lines 588–687.

- [ ] **Step 1: Replace the `return` block**

Locate the `return` statement of `SettingsPage` (starts at line 588 with `return (`). Replace the entire return JSX with:

```tsx
return (
  <div className="fade-in" style={{ maxWidth: 720, margin: "0 auto" }}>
    <h1 style={{ marginBottom: 4 }}>Settings</h1>
    <p style={{ color: "var(--text-3)", fontSize: "0.875rem", marginBottom: 16 }}>
      Preferences for your BitCorn node
    </p>

    <div className="settings-section-label">Personal</div>

    <div className="panel">
      <div className="panel-header">
        <span className="panel-title"><span className="icon">◐</span>Appearance</span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Theme: horizontal chips */}
        <div style={{ display: "flex", gap: 6 }}>
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => changeTheme(opt.value)}
              style={{
                flex: 1, padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                border: `2px solid ${theme === opt.value ? "var(--amber)" : "var(--border)"}`,
                background: theme === opt.value ? "color-mix(in srgb, var(--amber) 10%, var(--bg-2))" : "var(--bg-2)",
                color: theme === opt.value ? "var(--amber)" : "var(--text-3)",
                textAlign: "center", fontSize: "0.8125rem", fontWeight: 600, fontFamily: "var(--sans)",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Text size: slider only, no presets */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Text Size</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>{Math.round(parseFloat(textScale) * 100)}%</span>
          </div>
          <input
            type="range" min="0.75" max="1.5" step="0.05" value={textScale}
            onChange={(e) => changeTextScale(e.target.value)}
            style={{ width: "100%", accentColor: "var(--amber)" }}
          />
        </div>

        {/* Font: compact 2x2 grid */}
        <div>
          <span style={{ fontSize: "0.8125rem", fontWeight: 500, marginBottom: 4, display: "block" }}>Font</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {FONT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => changeFont(preset.id)}
                style={{
                  padding: "8px 10px", borderRadius: 8, cursor: "pointer",
                  border: `2px solid ${fontId === preset.id ? "var(--amber)" : "var(--border)"}`,
                  background: fontId === preset.id ? "color-mix(in srgb, var(--amber) 10%, var(--bg-2))" : "var(--bg-2)",
                  textAlign: "center",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: "0.8125rem", color: fontId === preset.id ? "var(--amber)" : "var(--text)", fontFamily: preset.sans }}>
                  {preset.label}
                </div>
                <div style={{ fontSize: "0.6875rem", fontFamily: preset.mono, color: "var(--text-3)", marginTop: 2 }}>
                  0123456789
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>

    {/* Operations section — both roles have at least one operational panel,
        so the label is unconditional (member: Channel Role; treasury: Fee Policy + Capital Guardrails). */}
    <div className="settings-section-label ops">[ Operations ]</div>

    {!isTreasury && <ChannelRolePanel />}

    {isTreasury && <FeePolicyPanel />}
    {isTreasury && <CapitalPolicyPanel />}

    {isTreasury && (
      <div style={{ marginTop: 24, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
        <button
          className="btn btn-ghost"
          onClick={() => {
            localStorage.removeItem("bitcorn_setup_done");
            navigate("/setup");
          }}
          style={{ fontSize: "0.75rem" }}
        >
          Re-run Setup Wizard
        </button>
        <p style={{ fontSize: "0.6875rem", color: "var(--text-3)", margin: 0 }}>
          Resets the setup flag and walks through initial configuration again.
        </p>
      </div>
    )}
  </div>
);
```

- [ ] **Step 2: Verify the theme-chip `fontFamily` is sans**

Search the `SettingsPage` return block for `var(--mono)`:
```bash
grep -n 'var(--mono)' app/web/src/App.tsx | head -5
```
In the `SettingsPage` return block, `var(--mono)` should only appear in the Text Size percentage span (e.g. `{Math.round(parseFloat(textScale) * 100)}%`), which correctly uses mono for a number. The theme chip buttons should use `var(--sans)` (fixed in Step 1).

- [ ] **Step 3: Build**

Run: `cd app/web && npm run build`
Expected: clean build, no TypeScript errors.

- [ ] **Step 4: Visual check in dev server**

Run: `cd app/web && npm run dev`

In the browser at `http://localhost:3200/settings`:
- Confirm "Personal" and "[ Operations ]" labels render.
- Confirm Appearance panel is under Personal.
- Confirm Re-run Setup Wizard (treasury only) is a ghost-button row at the bottom with a muted help line, no panel wrapper.
- Confirm theme chip labels now render in sans-serif (not monospace code font).

Stop the dev server when verified.

- [ ] **Step 5: Commit**

```bash
git add app/web/src/App.tsx
git commit -m "feat(web/settings): split page into Personal / Operations, restyle wizard row"
```

---

### Task 5: Apply `.panel.ops` to `ChannelRolePanel`, `FeePolicyPanel`, `CapitalPolicyPanel`

Three panel components need their root `className="panel"` changed to `className="panel ops"`.

**Files:**
- Modify: `app/web/src/App.tsx`
  - `ChannelRolePanel` — around line 490
  - `FeePolicyPanel` — around line 747
  - `CapitalPolicyPanel` — around line 855

- [ ] **Step 1: `ChannelRolePanel`**

Find:
```tsx
<div className="panel" style={{ marginTop: 12 }}>
```
Replace with:
```tsx
<div className="panel ops" style={{ marginTop: 12 }}>
```

- [ ] **Step 2: `FeePolicyPanel`**

Find (at the top of its `return`):
```tsx
<div className="panel" style={{ marginTop: 12 }}>
```
Replace with:
```tsx
<div className="panel ops" style={{ marginTop: 12 }}>
```

- [ ] **Step 3: `CapitalPolicyPanel`**

Same edit — top of its `return`:
```tsx
<div className="panel" style={{ marginTop: 12 }}>
```
→
```tsx
<div className="panel ops" style={{ marginTop: 12 }}>
```

- [ ] **Step 4: Build**

Run: `cd app/web && npm run build`
Expected: clean.

- [ ] **Step 5: Visual check**

`npm run dev`, then check Settings as:
- Member role: ChannelRolePanel under Operations shows amber border-top + amber-dim title.
- Treasury role: FeePolicyPanel and CapitalPolicyPanel show the same treatment.

Toggle theme (light/dark) using the Appearance panel — verify amber chrome reads well in both.

- [ ] **Step 6: Commit**

```bash
git add app/web/src/App.tsx
git commit -m "feat(web/settings): apply .panel.ops chrome to operational panels"
```

---

### Task 6: Add `PolicyCard` local component

Define a dual-mode (read/edit) card component inside `App.tsx`, placed near the other panel-related helpers (e.g. just above `FeePolicyPanel`, around line 710).

**Files:**
- Modify: `app/web/src/App.tsx`

- [ ] **Step 1: Add the component**

Insert before `function FeePolicyPanel() {`:

```tsx
// ─── PolicyCard ─────────────────────────────────────────────────
// Dual-mode card used in FeePolicyPanel + CapitalPolicyPanel.
// Read mode: large mono value with unit + interactive caret.
// Edit mode: text input with inline-numeric comma formatting, matches
// the existing pattern in CapitalPolicyPanel.

type PolicyCardProps = {
  id: string;
  label: string;
  meta: string;
  value: number;
  unit: string;
  inputWidth?: number;
  isEditing: boolean;
  isFocused: boolean;
  onEditRequest: (id: string) => void;
  onValueChange: (id: string, next: number) => void;
};

function PolicyCard({
  id, label, meta, value, unit, inputWidth = 150,
  isEditing, isFocused, onEditRequest, onValueChange,
}: PolicyCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && isFocused && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing, isFocused]);

  if (isEditing) {
    return (
      <div className={`policy-card editing${isFocused ? " focus" : ""}`}>
        <div>
          <div className="policy-card-label">{label}</div>
          <div className="policy-card-meta">{meta}</div>
        </div>
        <div className="policy-card-edit">
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            value={value > 0 ? value.toLocaleString() : "0"}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^0-9]/g, "");
              onValueChange(id, raw === "" ? 0 : Number(raw));
            }}
            style={{ width: inputWidth }}
          />
          <span className="unit">{unit}</span>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="policy-card"
      onClick={() => onEditRequest(id)}
      aria-label={`Edit ${label}`}
    >
      <div>
        <div className="policy-card-label">{label}</div>
        <div className="policy-card-meta">{meta}</div>
      </div>
      <div className="policy-card-value">
        {value.toLocaleString()}
        <span className="unit">{unit}</span>
        <span className="policy-card-caret">›</span>
      </div>
    </button>
  );
}
```

- [ ] **Step 2: Confirm `useRef`, `useEffect` imports are already present in the file**

Run:
```bash
grep -n "^import" app/web/src/App.tsx | head -10
```

Expected: `useRef` and `useEffect` should already be in the `import { ... } from "react"` statement. If not, add them.

- [ ] **Step 3: Build**

Run: `cd app/web && npm run build`
Expected: clean (no usages yet, so no runtime impact).

- [ ] **Step 4: Commit**

```bash
git add app/web/src/App.tsx
git commit -m "feat(web/settings): add PolicyCard read/edit component"
```

---

### Task 7: Convert `FeePolicyPanel` to read/edit mode

Refactor `FeePolicyPanel` (currently at `app/web/src/App.tsx:712-813`) to use `PolicyCard` + panel-level edit mode. Keep the example-calculation box and the existing save semantics.

**Files:**
- Modify: `app/web/src/App.tsx` — `FeePolicyPanel` function body.

- [ ] **Step 1: Replace the entire `FeePolicyPanel` function**

Replace from `function FeePolicyPanel() {` through its closing `}` (line ~813) with:

```tsx
function FeePolicyPanel() {
  const [baseFee, setBaseFee] = useState(1000); // msat
  const [feeRate, setFeeRate] = useState(500); // ppm
  const [loadedBaseFee, setLoadedBaseFee] = useState(1000);
  const [loadedFeeRate, setLoadedFeeRate] = useState(500);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getFeePolicy()
      .then((p) => {
        setBaseFee(p.base_fee_msat); setFeeRate(p.fee_rate_ppm);
        setLoadedBaseFee(p.base_fee_msat); setLoadedFeeRate(p.fee_rate_ppm);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const dirtyCount =
    (baseFee !== loadedBaseFee ? 1 : 0) + (feeRate !== loadedFeeRate ? 1 : 0);

  function startEdit(fieldId: string | null) {
    setFocusedField(fieldId);
    setIsEditing(true);
    setSaved(false);
  }

  function cancelEdit() {
    setBaseFee(loadedBaseFee);
    setFeeRate(loadedFeeRate);
    setIsEditing(false);
    setFocusedField(null);
    setError(null);
  }

  async function handleSave() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const resp = await api.setFeePolicy(baseFee, feeRate) as any;
      const updated = resp?.policy ?? resp;
      const newBase = updated?.base_fee_msat ?? baseFee;
      const newRate = updated?.fee_rate_ppm ?? feeRate;
      setBaseFee(newBase); setFeeRate(newRate);
      setLoadedBaseFee(newBase); setLoadedFeeRate(newRate);
      setIsEditing(false); setFocusedField(null); setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) { setError(e.message ?? "Failed to save"); }
    finally { setSaving(false); }
  }

  // Esc-to-cancel while editing
  useEffect(() => {
    if (!isEditing) return;
    const el = panelRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  // Example fee for 100k payment
  const examplePayment = 100_000;
  const exampleFee = Math.round(baseFee / 1000) + Math.round(examplePayment * feeRate / 1_000_000);
  const pctDisplay = (feeRate / 10_000).toFixed(2);

  return (
    <div ref={panelRef} className="panel ops" style={{ marginTop: 12 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">↗</span>Routing Fee Policy
          {isEditing && (
            <span style={{ marginLeft: 8, fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--amber)", letterSpacing: "0.04em", textTransform: "none" }}>
              · editing
            </span>
          )}
        </span>
        {saved && <span style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--green)" }}>✓ Applied</span>}
        {!saved && isEditing && dirtyCount > 0 && (
          <span aria-live="polite" style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>
            {dirtyCount} unsaved
          </span>
        )}
        {!saved && !isEditing && !loading && (
          <button
            className="btn btn-sm btn-outline"
            aria-pressed={isEditing}
            onClick={() => startEdit(null)}
          >
            Edit
          </button>
        )}
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {loading ? (
          <div className="loading-shimmer" style={{ height: 60, borderRadius: 6 }} />
        ) : (
          <>
            <p className="text-dim" style={{ fontSize: "0.75rem", margin: 0 }}>
              Fee charged on every payment routed through your channels. Applied to all channels.
            </p>

            <PolicyCard
              id="base_fee_msat"
              label="Base Fee"
              meta="Flat fee per routed payment"
              value={baseFee}
              unit="msat"
              inputWidth={120}
              isEditing={isEditing}
              isFocused={focusedField === "base_fee_msat"}
              onEditRequest={startEdit}
              onValueChange={(_id, v) => setBaseFee(v)}
            />
            <PolicyCard
              id="fee_rate_ppm"
              label="Fee Rate"
              meta={`Proportional fee per routed sat (${pctDisplay}%)`}
              value={feeRate}
              unit="ppm"
              inputWidth={120}
              isEditing={isEditing}
              isFocused={focusedField === "fee_rate_ppm"}
              onEditRequest={startEdit}
              onValueChange={(_id, v) => setFeeRate(v)}
            />

            <div style={{ padding: "8px 12px", background: "var(--bg-3)", borderRadius: 6, fontSize: "0.75rem", color: "var(--text-2)" }}>
              Example: a {examplePayment.toLocaleString()} sat payment would cost the sender <strong>{exampleFee.toLocaleString()} sats</strong> in routing fees ({pctDisplay}% + {Math.round(baseFee / 1000)} sat base).
            </div>

            {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

            {isEditing && (
              <div className="policy-action-row">
                <button className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={saving}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                  {saving ? "Applying..." : "Save Changes"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: clean. If TypeScript complains about `useRef` import, add it: `import { useRef, useState, useEffect } from "react"` at the top of the file (already there in most codebases; verify).

- [ ] **Step 3: Visual check (treasury role)**

Sign in as treasury, go to `/settings`:
- Confirm Fee Policy shows 2 policy cards (Base Fee + Fee Rate) in read state.
- Confirm "Edit" button top-right of panel header.
- Click "Edit" → both cards flip to inputs, Cancel/Save appear, header shows "· editing" and "2 unsaved" counter (if nothing changed yet, 0 unsaved — adjust one field to see it).
- Click a specific card → enters edit mode, that card's input gets focus and text selected.
- Press Esc with focus in an input → reverts to read mode, no save.
- Edit a value → "N unsaved" counter updates → click Save → button spinner → "✓ Applied" flashes in header → back to read mode with new value.
- Toggle dark/light → amber chrome still reads correctly.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/App.tsx
git commit -m "feat(web/settings): read/edit mode for FeePolicyPanel"
```

---

### Task 8: Convert `CapitalPolicyPanel` to read/edit mode

Same pattern as Task 7, applied to 8 fields. Replace the entire `CapitalPolicyPanel` function.

**Files:**
- Modify: `app/web/src/App.tsx` — `CapitalPolicyPanel` function body (currently around line 815–917).

- [ ] **Step 1: Replace the entire `CapitalPolicyPanel` function**

Replace from `function CapitalPolicyPanel() {` through its closing `}` with:

```tsx
function CapitalPolicyPanel() {
  const [policy, setPolicy] = useState<Record<string, number> | null>(null);
  const [loadedPolicy, setLoadedPolicy] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getCapitalPolicy()
      .then((p) => {
        const rec = p as unknown as Record<string, number>;
        setPolicy(rec); setLoadedPolicy(rec);
        setLoading(false);
      })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, []);

  const dirtyCount = policy && loadedPolicy
    ? POLICY_FIELDS.reduce((n, f) => n + ((policy[f.key] ?? 0) !== (loadedPolicy[f.key] ?? 0) ? 1 : 0), 0)
    : 0;

  function startEdit(fieldId: string | null) {
    setFocusedField(fieldId);
    setIsEditing(true);
    setSaved(false);
  }

  function cancelEdit() {
    if (loadedPolicy) setPolicy(loadedPolicy);
    setIsEditing(false); setFocusedField(null); setError(null);
  }

  function handleChange(key: string, value: number) {
    if (!policy) return;
    setPolicy({ ...policy, [key]: value });
    setSaved(false);
  }

  async function handleSave() {
    if (!policy) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const updated = await api.setCapitalPolicy(policy as any);
      const rec = updated as unknown as Record<string, number>;
      setPolicy(rec); setLoadedPolicy(rec);
      setIsEditing(false); setFocusedField(null); setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      setError(e.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Esc-to-cancel
  useEffect(() => {
    if (!isEditing) return;
    const el = panelRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  return (
    <div ref={panelRef} className="panel ops" style={{ marginTop: 12 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">⊞</span>Capital Guardrails
          {isEditing && (
            <span style={{ marginLeft: 8, fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--amber)", letterSpacing: "0.04em", textTransform: "none" }}>
              · editing
            </span>
          )}
        </span>
        {saved && <span style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--green)" }}>✓ Saved</span>}
        {!saved && isEditing && dirtyCount > 0 && (
          <span aria-live="polite" style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>
            {dirtyCount} unsaved
          </span>
        )}
        {!saved && !isEditing && !loading && policy && (
          <button
            className="btn btn-sm btn-outline"
            aria-pressed={isEditing}
            onClick={() => startEdit(null)}
          >
            Edit
          </button>
        )}
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="loading-shimmer" style={{ height: 48, borderRadius: 6 }} />
            ))}
          </div>
        ) : error && !policy ? (
          <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>
        ) : policy ? (
          <>
            <p className="text-dim" style={{ fontSize: "0.75rem", lineHeight: 1.5, margin: 0, marginBottom: 2 }}>
              Enforced before every channel open.
            </p>

            {POLICY_FIELDS.map((f) => (
              <PolicyCard
                key={f.key}
                id={f.key}
                label={f.label}
                meta={f.help}
                value={policy[f.key] ?? 0}
                unit={f.unit === "ppm (parts per million)" ? "ppm" : f.unit}
                inputWidth={150}
                isEditing={isEditing}
                isFocused={focusedField === f.key}
                onEditRequest={startEdit}
                onValueChange={handleChange}
              />
            ))}

            {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

            {isEditing && (
              <div className="policy-action-row">
                <button className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={saving}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `cd app/web && npm run build`
Expected: clean.

- [ ] **Step 3: Visual check (treasury role)**

`/settings`:
- Capital Guardrails shows 8 policy cards in read state.
- Edit / click-a-card / Cancel / Save / Esc all behave as in Task 7.
- "N unsaved" counter reflects how many fields differ from loaded values.
- Error path: temporarily edit one field to a string that the backend rejects (e.g. negative interpretation) — verify the red error line renders above the action row and panel stays in edit mode.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/App.tsx
git commit -m "feat(web/settings): read/edit mode for CapitalPolicyPanel"
```

---

### Task 9: Final theme + role cross-check, capture screenshots

No code changes expected in this task unless cross-check surfaces an issue.

- [ ] **Step 1: Build once more from clean**

```bash
cd app/web && npm run build
```

Expected: clean. Confirm no TypeScript warnings about unused imports / variables.

- [ ] **Step 2: Run dev server and test four combinations**

```bash
cd app/web && npm run dev
```

Combinations:
- Treasury role + Dark theme
- Treasury role + Light theme
- Member role + Dark theme
- Member role + Light theme

For each: screenshot `/settings`, verify:
- Section labels render correctly.
- Operational panels (Channel Role on member, Fee Policy + Capital Guardrails on treasury) have the amber border-top + tinted header.
- Appearance theme chips render in sans-serif.
- Re-run Setup Wizard (treasury only) is a plain row, no panel wrapper.

Save screenshots (suggested names: `settings-treasury-dark.png`, `settings-treasury-light.png`, `settings-member-dark.png`, `settings-member-light.png`) — they go into the PR body, not the repo. These should NOT be committed.

- [ ] **Step 3: If anything needs polish, fix and commit**

If a visual issue is caught (spacing, contrast, focus ring clipping, etc.), fix inline. Small polish fixes should commit as `fix(web/settings): <what>`.

- [ ] **Step 4: No-op commit if nothing to fix**

Skip to Task 10.

---

### Task 10: Push branch and open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feature/ui-settings
```

- [ ] **Step 2: Open PR with before/after screenshots**

Use `gh pr create` with a body that includes:
- Summary of the change (refer to the spec).
- "Before" screenshot (the user has `settings-page.png` already captured pre-work — use it).
- "After" screenshots — all four combinations from Task 9.
- Build status: `npm run build` clean.
- Tailscale/HTTP test: N/A (Settings has no clipboard actions).
- Link to the spec: `docs/superpowers/specs/2026-04-22-settings-polish-design.md`.

Example command:

```bash
gh pr create --base main --title "feat(web/settings): Briefing Room polish" --body "$(cat <<'EOF'
## Summary

- Split the Settings page into Personal / Operations sections with a visual hierarchy.
- Added `.panel.ops` chrome (amber border-top + tinted header) for Channel Role, Fee Policy, and Capital Guardrails.
- Converted Fee Policy + Capital Guardrails to a read-then-edit "briefing room" interaction — big values in read mode, panel-level edit toggle with Save/Cancel (single-POST contract preserved). Esc cancels.
- Minor polish: theme chips switched from IBM Plex Mono to Sans. Re-run Setup Wizard promoted out of its panel into a quiet footer row.
- No backend or API changes.

Spec: `docs/superpowers/specs/2026-04-22-settings-polish-design.md`

## Test plan

- [x] `cd app/web && npm run build` clean
- [x] Dark + light theme both screenshot-verified
- [x] Treasury view: Fee Policy + Capital Guardrails edit mode works, Save persists
- [x] Member view: Channel Role picker unchanged behavior, Operations chrome applied
- [x] Esc-to-cancel works
- [x] "N unsaved" counter reflects dirty fields

## Screenshots

Before: ![Settings before](url-to-before.png)
After (treasury, dark): ![Settings treasury dark](url-to-after-treasury-dark.png)
After (treasury, light): ![Settings treasury light](url-to-after-treasury-light.png)
After (member, dark): ![Settings member dark](url-to-after-member-dark.png)
After (member, light): ![Settings member light](url-to-after-member-light.png)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Do NOT bump version until user approves merge**

Per the polish brief, version bump is part of landing — leave `bitcorn-lightning-node/umbrel-app.yml` and `bitcorn-lightning-node/docker-compose.yml` unchanged until the PR is approved. A follow-up commit bumps to `v1.12.1` with a release-notes paragraph, then merges.

---

## Post-merge checklist (reference, not steps)

- Bump `bitcorn-lightning-node/umbrel-app.yml` and `bitcorn-lightning-node/docker-compose.yml` image tags to `v1.12.1` together.
- Add a release-notes paragraph to `umbrel-app.yml`.
- Wait for ghcr.io image build to complete before any Umbrel sideload test.

---

## Self-review gotchas

- The spec promises ARIA: `aria-pressed={isEditing}` on Edit button ✓ (Tasks 7, 8), `aria-live="polite"` on unsaved counter ✓ (Tasks 7, 8), `role="button"` + keyboard on read cards → handled by using a native `<button>` element for the card (Task 6), which gives Enter/Space for free.
- The spec says "Edit button: aria-pressed" — note the button is only rendered when NOT editing, so `aria-pressed` is always `false` while visible. That's technically correct but useless. Consider dropping it or always rendering the button (greyed) during edit mode. Kept per spec; dropping is fine if noticed during review.
- Esc handler listens on the panel ref — only fires when focus is inside the panel. Global listener would be brittle if multiple panels are in edit mode simultaneously (they can't be, but defensive coding is cheap).
- `color-mix(in srgb, ...)` is CSS Colors Module L4. All modern browsers (Chrome 111+, Safari 16.2+, Firefox 113+) support it. The rest of the codebase already uses `color-mix` in `App.tsx:609`, so this is precedented.
