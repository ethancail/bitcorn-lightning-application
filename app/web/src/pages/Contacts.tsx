import { useEffect, useState } from "react";
import { api, type Contact, truncPubkey, fmtSats } from "../api/client";

export default function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingPubkey, setEditingPubkey] = useState<string | null>(null);
  const [deletingPubkey, setDeletingPubkey] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{ added: number; skipped: number } | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Add form state
  const [addPubkey, setAddPubkey] = useState("");
  const [addName, setAddName] = useState("");
  const [addNotes, setAddNotes] = useState("");
  const [addTags, setAddTags] = useState("");
  const [addError, setAddError] = useState("");
  const [addSaving, setAddSaving] = useState(false);

  // Edit form state
  const [editName, setEditName] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const loadContacts = () => {
    api
      .getContacts()
      .then((data) => {
        setContacts(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    loadContacts();
  }, []);

  const handleSync = () => {
    setSyncing(true);
    setSyncResult(null);
    api
      .syncPeers()
      .then((res) => {
        setSyncResult({ added: res.added, skipped: res.skipped });
        loadContacts();
      })
      .catch(() => setSyncResult(null))
      .finally(() => setSyncing(false));
  };

  const handleAdd = () => {
    if (!addPubkey.trim() || !addName.trim()) return;
    setAddSaving(true);
    setAddError("");
    const tags = addTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    api
      .createContact({
        pubkey: addPubkey.trim(),
        name: addName.trim(),
        notes: addNotes.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
      })
      .then(() => {
        setShowAddForm(false);
        setAddPubkey("");
        setAddName("");
        setAddNotes("");
        setAddTags("");
        loadContacts();
      })
      .catch((err: { status?: number }) => {
        if (err.status === 409) {
          setAddError("A contact with this pubkey already exists.");
        } else {
          setAddError("Failed to create contact.");
        }
      })
      .finally(() => setAddSaving(false));
  };

  const startEdit = (c: Contact) => {
    setEditingPubkey(c.pubkey);
    setEditName(c.name);
    setEditNotes(c.notes || "");
    setEditTags(c.tags.join(", "));
  };

  const handleEdit = (pubkey: string) => {
    setEditSaving(true);
    const tags = editTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    api
      .updateContact(pubkey, {
        name: editName.trim(),
        notes: editNotes.trim() || undefined,
        tags,
      })
      .then(() => {
        setEditingPubkey(null);
        loadContacts();
      })
      .catch(() => {})
      .finally(() => setEditSaving(false));
  };

  const handleDelete = (pubkey: string) => {
    api
      .deleteContact(pubkey)
      .then(() => {
        setDeletingPubkey(null);
        loadContacts();
      })
      .catch(() => {});
  };

  const filtered = contacts.filter((c) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.pubkey.toLowerCase().includes(q) ||
      (c.notes && c.notes.toLowerCase().includes(q)) ||
      c.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Contacts</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Named address book for Lightning peers
        </p>
      </div>

      {/* Action bar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <button className="btn btn-outline" onClick={handleSync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync Channel Peers"}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            setShowAddForm((v) => !v);
            setAddError("");
          }}
        >
          {showAddForm ? "Cancel" : "+ Add Contact"}
        </button>
      </div>

      {/* Sync result */}
      {syncResult && (
        <div className="alert info" style={{ marginBottom: 16 }}>
          Sync complete: {syncResult.added} added, {syncResult.skipped} skipped.
        </div>
      )}

      {/* Search */}
      <input
        className="form-input"
        placeholder="Search by name, pubkey, notes, or tags…"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        style={{ marginBottom: 16, maxWidth: 480 }}
      />

      {/* Add Contact form */}
      {showAddForm && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title">New Contact</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              className="form-input"
              placeholder="Pubkey (66-char hex)"
              value={addPubkey}
              onChange={(e) => setAddPubkey(e.target.value)}
              style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem" }}
            />
            <input
              className="form-input"
              placeholder="Name"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
            />
            <textarea
              className="form-input"
              placeholder="Notes (optional, max 280 chars)"
              value={addNotes}
              onChange={(e) => setAddNotes(e.target.value.slice(0, 280))}
              rows={2}
              style={{ resize: "vertical" }}
            />
            <input
              className="form-input"
              placeholder="Tags (comma-separated, e.g. routing, friend)"
              value={addTags}
              onChange={(e) => setAddTags(e.target.value)}
            />
            {addError && (
              <div style={{ color: "var(--red)", fontSize: "0.8125rem", fontFamily: "var(--mono)" }}>
                {addError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={handleAdd} disabled={addSaving || !addPubkey.trim() || !addName.trim()}>
                {addSaving ? "Saving…" : "Save"}
              </button>
              <button className="btn btn-outline" onClick={() => setShowAddForm(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Contacts list */}
      {loading ? (
        <div className="panel">
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[100, 80, 90].map((w, i) => (
              <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
            ))}
          </div>
        </div>
      ) : filtered.length === 0 && contacts.length === 0 ? (
        <div className="panel">
          <div className="empty-state" style={{ padding: "60px 20px" }}>
            <div style={{ marginBottom: 12 }}>No contacts yet.</div>
            <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync Channel Peers"}
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="panel">
          <div className="empty-state" style={{ padding: "40px 20px" }}>
            No contacts match "{searchQuery}".
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filtered.map((c) => (
            <ContactCard
              key={c.pubkey}
              contact={c}
              isEditing={editingPubkey === c.pubkey}
              isDeleting={deletingPubkey === c.pubkey}
              editName={editName}
              editNotes={editNotes}
              editTags={editTags}
              editSaving={editSaving}
              onEditNameChange={setEditName}
              onEditNotesChange={setEditNotes}
              onEditTagsChange={setEditTags}
              onStartEdit={() => startEdit(c)}
              onSaveEdit={() => handleEdit(c.pubkey)}
              onCancelEdit={() => setEditingPubkey(null)}
              onStartDelete={() => setDeletingPubkey(c.pubkey)}
              onConfirmDelete={() => handleDelete(c.pubkey)}
              onCancelDelete={() => setDeletingPubkey(null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Contact Card ─────────────────────────────────────────────────────────

function ContactCard({
  contact: c,
  isEditing,
  isDeleting,
  editName,
  editNotes,
  editTags,
  editSaving,
  onEditNameChange,
  onEditNotesChange,
  onEditTagsChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  contact: Contact;
  isEditing: boolean;
  isDeleting: boolean;
  editName: string;
  editNotes: string;
  editTags: string;
  editSaving: boolean;
  onEditNameChange: (v: string) => void;
  onEditNotesChange: (v: string) => void;
  onEditTagsChange: (v: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const [showChannels, setShowChannels] = useState(false);

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
          <input
            className="form-input"
            placeholder="Tags (comma-separated)"
            value={editTags}
            onChange={(e) => onEditTagsChange(e.target.value)}
          />
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

  return (
    <div className="panel fade-in">
      <div className="panel-body" style={{ padding: "12px 16px" }}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <span style={{ color: "var(--amber)", fontWeight: 600 }}>{c.name}</span>
          <span className="td-mono" style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>
            {truncPubkey(c.pubkey)}
          </span>
          {c.source === "auto" && <span className="badge badge-muted">auto</span>}
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-ghost"
            onClick={onStartEdit}
            style={{ padding: "4px 8px", fontSize: "0.75rem" }}
          >
            edit
          </button>
          <button
            className="btn btn-ghost"
            onClick={onStartDelete}
            style={{ padding: "4px 8px", fontSize: "0.75rem", color: "var(--red)" }}
          >
            delete
          </button>
        </div>

        {/* Notes */}
        {c.notes && (
          <div style={{ color: "var(--text-3)", fontSize: "0.8125rem", marginBottom: 6 }}>
            {c.notes}
          </div>
        )}

        {/* Tags */}
        {c.tags.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            {c.tags.map((t) => (
              <span key={t} className="tag-pill">{t}</span>
            ))}
          </div>
        )}

        {/* Delete confirmation */}
        {isDeleting && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              padding: "8px 12px",
              background: "var(--bg-2)",
              borderRadius: "var(--radius)",
            }}
          >
            <span style={{ fontSize: "0.8125rem", color: "var(--red)" }}>Delete this contact?</span>
            <button className="btn btn-primary" onClick={onConfirmDelete} style={{ background: "var(--red)", padding: "4px 12px" }}>
              Confirm
            </button>
            <button className="btn btn-outline" onClick={onCancelDelete} style={{ padding: "4px 12px" }}>
              Cancel
            </button>
          </div>
        )}

        {/* Channels */}
        {c.channels.length > 0 ? (
          <div>
            <button
              onClick={() => setShowChannels((v) => !v)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                fontSize: "0.75rem",
                cursor: "pointer",
                padding: 0,
              }}
            >
              {showChannels ? "▾" : "▸"} {c.channels.length} channel{c.channels.length > 1 ? "s" : ""}
            </button>
            {showChannels && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {c.channels.map((ch) => (
                  <ChannelRow key={ch.channel_id} ch={ch} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: "var(--text-3)", fontSize: "0.75rem", fontFamily: "var(--mono)" }}>
            No active channels
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Channel Row with balance bar ─────────────────────────────────────────

function ChannelRow({
  ch,
}: {
  ch: { channel_id: string; capacity_sats: number; local_sats: number; remote_sats: number; is_active: boolean };
}) {
  const localPct = ch.capacity_sats > 0 ? (ch.local_sats / ch.capacity_sats) * 100 : 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: "0.75rem",
        fontFamily: "var(--mono)",
        flexWrap: "wrap",
      }}
    >
      <span style={{ color: "var(--text-3)", minWidth: 110 }}>
        {ch.channel_id.slice(0, 12)}…
      </span>
      <span className={ch.is_active ? "badge badge-green" : "badge badge-muted"}>
        {ch.is_active ? "active" : "inactive"}
      </span>
      <span style={{ color: "var(--text-2)" }}>{fmtSats(ch.capacity_sats)}</span>
      {/* Balance bar */}
      <div
        style={{
          flex: 1,
          minWidth: 80,
          height: 6,
          borderRadius: 3,
          background: "var(--bg-3)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${localPct}%`,
            height: "100%",
            borderRadius: 3,
            background: "var(--amber)",
          }}
        />
      </div>
      <span style={{ color: "var(--text-3)", fontSize: "0.625rem" }}>
        {fmtSats(ch.local_sats)} / {fmtSats(ch.remote_sats)}
      </span>
    </div>
  );
}
