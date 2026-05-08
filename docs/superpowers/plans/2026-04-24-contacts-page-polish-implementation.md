# Contacts Page Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Edit-State Chrome" Contacts page polish on `feature/ui-contacts`: apply `.panel.ops` chrome to the Add Contact form and edit-mode `ContactCard`, leaving display-mode cards plain. Adds a new `◈ Editing` panel-header to the edit-mode card so the amber chrome has a coherent header bar to rest against.

**Architecture:** Two change regions in `app/web/src/pages/Contacts.tsx`. No new CSS (reuses `.panel.ops` rules already in `styles.css` from the Settings polish PR). No backend changes. Version bump lands in the same PR.

**Tech Stack:** React 18 + TypeScript + Vite, CSS custom properties (already wired). Uses existing API methods (`getContacts`, `createContact`, `updateContact`, `deleteContact`, `syncPeers`) unchanged.

**Spec:** `docs/superpowers/specs/2026-04-24-contacts-page-polish-design.md`.

---

## Preflight notes for the engineer

- **No automated test suite.** Verification = `cd app/web && npm run build` clean + visual check in `npm run dev`.
- **Branch `feature/ui-contacts`** off `main` (at v1.13.4, commit `1f64a1b`). Do not switch branches.
- **Classes already in `styles.css`** (reusable, no new CSS needed): `.panel`, `.panel ops`, `.panel-header`, `.panel-title`, `.panel-title .icon`, `.panel-body`, plus buttons / alerts / tag-pill / form-input.
- **Do NOT touch**: display-mode `ContactCard` (line 472+), `TagEditor` component (line 8–128), `ChannelRow` component (line 588+), action bar, search input, sync-result alert, delete confirmation markup, `api/client.ts`, any other page, anything on `docs/UI_CONVENTIONS.md`'s do-not-touch list.
- **Version bump goes in the same final push** — per the v1.12.1 lesson.
- Main is at **v1.13.4** (Channels PR #122 merged). This PR bumps cleanly to **v1.13.5** — no PR collision.

---

## File Structure

### Files modified

- `app/web/src/pages/Contacts.tsx` — 2 change regions (Add Contact form panel + edit-mode `ContactCard`).
- `bitcorn-lightning-node/umbrel-app.yml` — patch version bump + prepend release-notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — bump both image tags.

### Files NOT modified

- Everything else. Single React file is the only TSX change.

### No new files

All edits in place.

---

### Task 1: Add Contact form → `.panel.ops` chrome

**Files:**
- Modify: `app/web/src/pages/Contacts.tsx` (the Add Contact form conditional, around lines 297–301)

- [ ] **Step 1: Edit the outer panel className**

Find the current Add Contact form markup around line 297–301:

```tsx
      {showAddForm && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title">New Contact</span>
          </div>
```

Replace with:

```tsx
      {showAddForm && (
        <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title"><span className="icon">◈</span>New Contact</span>
          </div>
```

Two small edits in the same block:
- Outer `<div>` className: `"panel fade-in"` → `"panel ops fade-in"`.
- `<span className="panel-title">`: wrap the text in a leading `<span className="icon">◈</span>` for visual consistency with operational panel titles elsewhere in the app.

The `.panel-body` below (with the pubkey input, name input, notes textarea, TagEditor, error message, Save/Cancel buttons) stays unchanged.

- [ ] **Step 2: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0, no TypeScript or CSS errors.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/pages/Contacts.tsx
git commit -m "feat(web/contacts): Add Contact form gets .panel.ops chrome

Outer panel className swap + leading ◈ icon on panel-title for
visual consistency with operational panel titles across the app.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Edit-mode `ContactCard` → `.panel.ops` + new panel-header

**Files:**
- Modify: `app/web/src/pages/Contacts.tsx` (the `if (isEditing)` branch in `ContactCard`, around lines 437–470)

- [ ] **Step 1: Rewrite the edit-mode return block**

Find the current edit-mode block (starts with `if (isEditing) { return (`):

```tsx
  if (isEditing) {
    return (
      <div className="panel fade-in">
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-3)" }}>
            {c.pubkey}
          </div>
          <input
            className="form-input"
            placeholder="Name"
            value={editName}
            onChange={(e) => onEditNameChange(e.target.value)}
          />
          <textarea
            className="form-input"
            placeholder="Notes"
            value={editNotes}
            onChange={(e) => onEditNotesChange(e.target.value.slice(0, 280))}
            rows={2}
            style={{ resize: "vertical" }}
          />
          <TagEditor tags={editTags} onChange={onEditTagsChange} isTreasury={isTreasury} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={onSaveEdit} disabled={editSaving}>
              {editSaving ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-outline" onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }
```

Replace with:

```tsx
  if (isEditing) {
    return (
      <div className="panel ops fade-in">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">◈</span>Editing</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-3)" }}>
            {c.pubkey}
          </div>
          <input
            className="form-input"
            placeholder="Name"
            value={editName}
            onChange={(e) => onEditNameChange(e.target.value)}
          />
          <textarea
            className="form-input"
            placeholder="Notes"
            value={editNotes}
            onChange={(e) => onEditNotesChange(e.target.value.slice(0, 280))}
            rows={2}
            style={{ resize: "vertical" }}
          />
          <TagEditor tags={editTags} onChange={onEditTagsChange} isTreasury={isTreasury} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={onSaveEdit} disabled={editSaving}>
              {editSaving ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-outline" onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }
```

Two changes:
- Outer `<div>` className: `"panel fade-in"` → `"panel ops fade-in"`.
- **New** `<div className="panel-header">` inserted above the existing `<div className="panel-body">`. Contains `<span className="panel-title"><span className="icon">◈</span>Editing</span>`.

All `.panel-body` content (pubkey display, name input, notes textarea, `<TagEditor>`, Save/Cancel buttons) is unchanged.

- [ ] **Step 2: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0, no TypeScript or CSS errors.

- [ ] **Step 3: Visual spot-check (optional)**

If you can run the dev server:
```bash
cd app/web && npm run dev
```

Navigate to `/contacts` (either role). Click "edit" on any existing contact. The card should:
- Gain amber border-top
- Show the `◈ Editing` header with amber-dim text
- Keep all the form fields below

Click Cancel to revert. Display-mode cards should remain plain.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/pages/Contacts.tsx
git commit -m "feat(web/contacts): edit-mode ContactCard gets .panel.ops + Editing header

Outer panel className swap + new panel-header containing '◈ Editing'
title. The amber chrome now has a coherent header bar above the form
fields instead of sitting directly above the .panel-body edge.

Display-mode ContactCard is unchanged — amber signals 'editing'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Version bump

**Files:**
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

- [ ] **Step 1: Check current version**

```bash
grep -nE "^version:" bitcorn-lightning-node/umbrel-app.yml
```

Expected: `version: "1.13.4"` (main at v1.13.4 post-Channels PR #122 merge).

If the version is something other than `1.13.4`, STOP and report as NEEDS_CONTEXT — main has advanced unexpectedly.

Target: **1.13.5**.

- [ ] **Step 2: Bump version in umbrel-app.yml**

Find:
```yaml
version: "1.13.4"
```

Replace with:
```yaml
version: "1.13.5"
```

- [ ] **Step 3: Prepend release-notes paragraph**

Find the `releaseNotes: >` block. The first paragraph currently starts with `v1.13.4: …`. Insert ABOVE it (preserving 2-space YAML indentation, do NOT delete the v1.13.4 paragraph):

```yaml
  v1.13.5: Contacts page polish. Edit-mode contact cards and the Add
  Contact form now use Briefing Room chrome (amber border-top +
  tinted header); display cards stay plain. Clear visual signal:
  amber means "you're editing this." No backend changes.
```

- [ ] **Step 4: Bump both image tags in docker-compose.yml**

Find:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/api:1.13.4
```
Replace with:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/api:1.13.5
```

Find:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/web:1.13.4
```
Replace with:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/web:1.13.5
```

- [ ] **Step 5: Verify consistency**

```bash
grep -nE "^version:|v1\.13\.5|api:1\.13\.5|web:1\.13\.5|api:1\.13\.4|web:1\.13\.4" bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml | head -12
```

Expected:
- `version: "1.13.5"` in umbrel-app.yml
- New `v1.13.5: Contacts page polish…` release-notes line
- `api:1.13.5` and `web:1.13.5` in docker-compose.yml
- NO `api:1.13.4` or `web:1.13.4` image tags remaining in docker-compose.yml (the v1.13.4 text should persist only in the preserved release-notes paragraph below the new v1.13.5 one).

- [ ] **Step 6: Commit**

```bash
git add bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
git commit -m "chore: bump to v1.13.5 for Contacts page polish

Umbrel manifest + compose image tags bumped together. Release notes
for v1.13.5 prepended above the v1.13.4 Channels paragraph.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

## Report format for Task 3

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- Verification grep output (verbatim)
- Commit SHA

---

### Task 4: Visual verification (human)

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

As either role (page renders identically for treasury and member), open `/contacts`. Check:

- Click "+ Add Contact" — the form panel appears with amber border-top + amber-tinted header reading "◈ NEW CONTACT". Click Cancel — form disappears.
- Click "edit" on any existing contact — the card gains amber border-top + new "◈ EDITING" header bar above the form fields. Click Cancel — card reverts to display mode, chrome gone.
- Other contacts in the list (display mode) stay plain — no amber chrome.
- Dark + light theme both renders correctly (toggle via Settings or DevTools).

Save screenshots for the PR body.

- [ ] **Step 3: Fix any visual issues**

If something looks off (spacing, contrast, header overlapping), fix inline. Commit as `fix(web/contacts): <what>`. If all good, skip to Task 5.

---

### Task 5: Push + open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/ui-contacts
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --title "feat(web/contacts): edit-state chrome polish (v1.13.5)" --body "$(cat <<'EOF'
## Summary

Contacts page polish — the sixth page from the UI polish brief, after Settings (v1.12.1), Wizard (v1.13.1), Member Dashboard (v1.13.2), Treasury Dashboard (v1.13.3), and Channels (v1.13.4).

- **Edit-mode contact cards** now use \`.panel.ops\` (amber border-top + tinted header) with a new \`◈ Editing\` panel-header bar above the form fields.
- **Add Contact form** also gets \`.panel.ops\` chrome + leading \`◈\` icon on the title.
- **Display-mode contact cards are unchanged** — amber signals "you're editing this", plain chrome signals "browsing."
- Smallest polish PR yet — no new CSS, no logic changes, just 2 className swaps + 1 new panel-header markup + version bump.

Spec: \`docs/superpowers/specs/2026-04-24-contacts-page-polish-design.md\`
Plan: \`docs/superpowers/plans/2026-04-24-contacts-page-polish-implementation.md\`

## Version

**v1.13.5** on top of v1.13.4 (Channels). Clean bump — no PR collision.

## Do-not-touch discipline

No changes to display-mode \`ContactCard\`, \`TagEditor\`, \`ChannelRow\`, action bar, search input, delete confirmation, \`api/client.ts\`, or any other page.

## Test plan

- [x] \`cd app/web && npm run build\` clean after every commit
- [x] Visual verification: edit a contact, amber chrome appears; cancel, chrome gone; "+ Add Contact" form has amber chrome; display cards unchanged
- [x] Dark + light theme both rendered correctly

## Screenshots

(attach: display + edit cards side-by-side, dark + light themes)

## Post-merge

1. Wait for \`Build and publish Docker images\` workflow (~5 min).
2. On Umbrel: \`cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0 && git pull\`
3. Hard-refresh Umbrel browser UI — v1.13.5 update prompt appears.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

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
- Hard-refresh the Umbrel browser UI — the Update button appears on the BitCorn Lightning tile.

---

## Self-review notes

- Both TSX edits are in `Contacts.tsx` only. No shared component modifications. No CSS file changes.
- `◈ Editing` and `◈ New Contact` use the same icon character used by other operational panel titles (Channels, Member Dashboard). Consistent lookup on CSS font rendering.
- Display-mode `ContactCard` is explicitly unchanged — this is a feature, not an oversight. Direction A from the brainstorm locked that in.
- Version cascade is uninterrupted: Settings (1.12.1) → Wizard (1.13.1) → Member (1.13.2) → Treasury Dashboard (1.13.3) → Channels (1.13.4) → Contacts (1.13.5). No PR collision this time.
