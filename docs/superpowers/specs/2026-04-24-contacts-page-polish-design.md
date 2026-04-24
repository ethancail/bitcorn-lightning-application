# Contacts Page Polish — "Edit-State Chrome" Design

- **Date:** 2026-04-24
- **Branch:** `feature/ui-contacts` (off `main` at v1.13.4).
- **Target version:** **v1.13.5** patch — no PR collision this time (Settings, Wizard, Member Dashboard, Treasury Dashboard, Channels all merged).
- **Scope:** `app/web/src/pages/Contacts.tsx` only + two Umbrel manifest files for the version bump. No new CSS.

## Mission

Fix the brief's flagged pain point — "inline editing needs visual separation from display rows" — by giving edit-mode contact cards and the Add Contact form the Briefing Room amber chrome (`.panel.ops`) that signals "you're entering data here." Display-mode contact cards stay plain, matching the mental model that the page is primarily a passive browse surface.

## Context

`Contacts.tsx` is a 638-line single-file page shared by both treasury and member shells. Already card-based (not table-based, despite the brief's wording). Today:

- Display-mode card (`ContactCard` line 472–583): plain `.panel fade-in` with header row (name + pubkey + action buttons), notes, tags, collapsible channels.
- Edit-mode card (`ContactCard` line 437–470, guarded by `if (isEditing)`): plain `.panel fade-in`, just a `.panel-body` with form inputs + Save/Cancel. No `.panel-header`.
- Add Contact form (line 297–340, conditional on `showAddForm`): plain `.panel fade-in` with a header bar ("New Contact") and form body.

When an operator clicks "edit" on a card, the chrome doesn't change — the card subtly morphs from display markup into form fields, with no strong visual signal that editing is active. This PR addresses that gap.

This is the sixth page in the polish brief's attack order, after Settings (v1.12.1), Wizard (v1.13.1), Member Dashboard (v1.13.2), Treasury Dashboard (v1.13.3), and Channels (v1.13.4).

## Non-goals (explicitly out of scope)

- **No changes to display-mode `ContactCard`** — stays plain `.panel fade-in`. That's the point of the direction: amber chrome means "editing."
- **No changes to the action bar** (Sync Channel Peers + Add Contact buttons), the sync-result alert, or the search input. Today's layout stays.
- **No changes to `TagEditor`** (line 8–128) or `ChannelRow` (line 588+) — sub-components untouched.
- **No changes to the delete confirmation** (inline inside display card when `isDeleting`) — keeps today's inline styling.
- **No changes to API calls** — `getContacts`, `createContact`, `updateContact`, `deleteContact`, `syncPeers` unchanged.
- **No new CSS.** Reuses `.panel`, `.panel.ops`, `.panel-header`, `.panel-title`, `.icon` classes already landed in the Settings polish PR.
- **No changes to other pages** or to anything on `docs/UI_CONVENTIONS.md`'s do-not-touch list.

## Change 1: Add Contact form panel

Today at `app/web/src/pages/Contacts.tsx:297–340`:

```tsx
{showAddForm && (
  <div className="panel fade-in" style={{ marginBottom: 16 }}>
    <div className="panel-header">
      <span className="panel-title">New Contact</span>
    </div>
    <div className="panel-body">…form fields…</div>
  </div>
)}
```

Change:

```tsx
{showAddForm && (
  <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
    <div className="panel-header">
      <span className="panel-title"><span className="icon">◈</span>New Contact</span>
    </div>
    <div className="panel-body">…form fields…</div>
  </div>
)}
```

Two edits:
- Outer className `"panel fade-in"` → `"panel ops fade-in"` — adds amber border-top + amber-tinted header via the existing `.panel.ops` + `.panel.ops .panel-header` CSS rules.
- `panel-title` gets a leading `◈` icon wrapped in `<span className="icon">` — matches the icon pattern from other operational panel titles (Settings, Wizard, Channels).

Panel-body content (form fields, TagEditor, Save/Cancel buttons) is unchanged.

## Change 2: Edit-mode `ContactCard`

Today at `app/web/src/pages/Contacts.tsx:437–470`:

```tsx
if (isEditing) {
  return (
    <div className="panel fade-in">
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-3)" }}>
          {c.pubkey}
        </div>
        <input ... />       {/* name */}
        <textarea ... />    {/* notes */}
        <TagEditor ... />
        <div style={{ display: "flex", gap: 8 }}>
          <button ... >Save</button>
          <button ... >Cancel</button>
        </div>
      </div>
    </div>
  );
}
```

Change:

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
        <input ... />
        <textarea ... />
        <TagEditor ... />
        <div style={{ display: "flex", gap: 8 }}>
          <button ... >Save</button>
          <button ... >Cancel</button>
        </div>
      </div>
    </div>
  );
}
```

Three edits:
- Outer className `"panel fade-in"` → `"panel ops fade-in"`.
- New `<div className="panel-header">` inserted above the existing `.panel-body`. Contains `<span className="panel-title"><span className="icon">◈</span>Editing</span>`.
- `.panel-body` content is unchanged — same pubkey display, name input, notes textarea, TagEditor, Save/Cancel button row.

The new header bar is necessary because without it, the `.panel.ops` amber border-top sits directly above the form fields with no transitional header element — visually incoherent.

## No changes to display-mode `ContactCard`

The display branch (`return (...)` after the `if (isEditing)` block, line 472+) keeps its plain `.panel fade-in` className. No chrome, no new header, no markup change. The header row (name + pubkey + edit/delete buttons), notes, tags, delete confirmation, and collapsible channels all stay as today.

## Accessibility

The new `◈ Editing` panel-header is visible text. Screen readers announce it naturally as the operator tabs into the card or clicks "edit." No ARIA additions required.

The existing Save / Cancel buttons keep native focus rings — no changes.

## Theme compatibility

All chrome resolves through existing CSS vars (`--amber`, `--amber-dim`, `--amber-glow2`, `--bg-2`, `--border`, `--mono`). Both dark and light mode auto-adapt, identical to how `.panel.ops` already renders on Settings / Wizard / Dashboards / Channels.

Screenshots in both themes required in the PR body.

## Risks

1. **Only one card in edit mode at a time** — the existing `editingPubkey` state allows only one card to be in edit mode simultaneously. So there's never confusion about which card has chrome. No concurrency risk.
2. **Add Contact form + an edit-mode card together** — user could theoretically have both visible if they click "+ Add Contact" then scroll and click "edit" on an existing card. Both would show amber chrome. Not a bug; both are operational data-entry surfaces. The amber signals both as "editing" correctly.
3. **Display cards look different from edit cards even more than before** — that IS the intent. Operators who like today's quiet symmetry might prefer direction B (all cards chromed), but the brief's specific complaint was lack of distinction, so A is right.

## Implementation surface

Files modified:

- `app/web/src/pages/Contacts.tsx` — 2 change regions:
  - Line ~298 + ~300: Add Contact form panel className + title icon addition.
  - Line ~437–439: Edit-mode `ContactCard` className + new panel-header markup.
- `bitcorn-lightning-node/umbrel-app.yml` — version bump + prepend release notes paragraph.
- `bitcorn-lightning-node/docker-compose.yml` — bump `api:` and `web:` image tags.

Files NOT touched:

- Everything else. No other `app/web/src/*` files, no `styles.css`, no `api/client.ts`, no other pages.

## Release notes line

> **v1.13.5** — Contacts page polish. Edit-mode contact cards and the Add Contact form now use Briefing Room chrome (amber border-top + tinted header); display cards stay plain. Clear visual signal: amber means "you're editing this." No backend changes.

## PR checklist

- [ ] Before + after screenshots attached.
- [ ] Dark + light theme both tested + attached.
- [ ] `cd app/web && npm run build` clean.
- [ ] Visual verification: open `/contacts`, click "edit" on a contact → amber chrome appears on that card only; click Cancel → chrome gone. Click "+ Add Contact" → amber chrome on the form; click Cancel → form disappears.
- [ ] Display-mode cards unchanged.
- [ ] Version bumped in both `bitcorn-lightning-node/umbrel-app.yml` and `bitcorn-lightning-node/docker-compose.yml` in the same push.
- [ ] Release-notes paragraph added to `umbrel-app.yml`.
