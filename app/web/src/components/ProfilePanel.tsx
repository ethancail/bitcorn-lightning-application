// ProfilePanel — member-facing public Lightning alias control.
//
// Source: bitcorn-research/specs/2026-06-12-member-naming-and-identity-
// implementation.md §6 / decision §6. Member view only (mounted with
// !isTreasury). Lets a member opt into a public alias gossiped via their own
// node; the default state is pseudonymous (the pubkey-derived hex label).
//
// "Findable but not in-your-face": this lives in Settings, no banner/badge/
// wizard step. A member can ignore it forever and nothing breaks.
//
// The component is a thin renderer over the pure aliasInputState function
// (client-side specific format hints) + the API (authoritative, generic
// rejection). Error copy is mapped from the thrown error's `code` (== the
// API's {error} field), not by string-matching messages.

import { useCallback, useEffect, useState } from "react";
import { api, truncPubkey, type ProfileAlias } from "../api/client";
import { aliasInputState, ALIAS_MAX_BYTES } from "./aliasInputState";
import AutoPaySection from "./AutoPaySection";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

export default function ProfilePanel() {
  const [profile, setProfile] = useState<ProfileAlias | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const load = useCallback(async () => {
    try {
      const p = await api.getProfileAlias();
      setProfile(p);
      setInput(p.alias ?? "");
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const inFlight = status.kind === "saving";
  const inputState = aliasInputState(input);
  const dirty = profile ? inputState.normalized !== (profile.alias ?? "") : true;
  const hasAlias = !!profile?.alias;
  // Applied vs pending derives from the timestamp divergence (§6): a stored
  // alias whose last successful LND apply is at/after the last set is "applied";
  // otherwise the apply is still pending (or last failed).
  const applied =
    hasAlias &&
    profile!.alias_applied_at != null &&
    profile!.alias_set_at != null &&
    profile!.alias_applied_at >= profile!.alias_set_at;

  async function onSave() {
    if (!inputState.valid || inFlight) return;
    setStatus({ kind: "saving" });
    try {
      await api.setProfileAlias(inputState.normalized);
      await load();
      setStatus({ kind: "idle" });
    } catch (e: any) {
      setStatus({ kind: "error", message: saveErrorCopy(e?.code, e?.message) });
    }
  }

  async function onClear() {
    if (inFlight) return;
    setStatus({ kind: "saving" });
    try {
      await api.clearProfileAlias();
      await load();
      setInput("");
      setStatus({ kind: "idle" });
    } catch (e: any) {
      setStatus({ kind: "error", message: clearErrorCopy(e?.code, e?.message) });
    }
  }

  const counterOver = inputState.byteCount > ALIAS_MAX_BYTES;
  const showFormatError = input.trim().length > 0 && !inputState.valid;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title"><span className="icon">◉</span>Profile</span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Current state */}
        {loadFailed ? (
          <p style={{ color: "var(--text-3)", fontSize: "0.8125rem", margin: 0 }}>
            Couldn't load your profile. It will retry when you reload.
          </p>
        ) : !profile ? (
          <p style={{ color: "var(--text-3)", fontSize: "0.8125rem", margin: 0 }}>Loading…</p>
        ) : hasAlias ? (
          <div style={{ fontSize: "0.875rem" }}>
            Your public alias: <strong style={{ fontFamily: "var(--mono)" }}>{profile.alias}</strong>{" "}
            <span
              style={{
                fontSize: "0.6875rem",
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 6,
                marginLeft: 4,
                color: applied ? "var(--green, #22c55e)" : "var(--amber)",
                border: `1px solid ${applied ? "var(--green, #22c55e)" : "var(--amber)"}`,
              }}
            >
              {applied ? "applied" : "pending"}
            </span>
          </div>
        ) : (
          <p style={{ fontSize: "0.875rem", margin: 0 }}>
            Your node is currently visible as{" "}
            <strong style={{ fontFamily: "var(--mono)" }}>{truncPubkey(profile.pubkey)}</strong>. Set an
            optional public alias to be identified on the Lightning network.
          </p>
        )}

        {/* Input + byte counter */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Public alias</span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: "0.6875rem",
                color: counterOver ? "var(--red, #ef4444)" : "var(--text-3)",
              }}
            >
              {inputState.byteCount} / {ALIAS_MAX_BYTES} bytes
            </span>
          </div>
          <input
            type="text"
            value={input}
            placeholder={`e.g. "Ethan's Farm"`}
            disabled={inFlight}
            onChange={(e) => setInput(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 8,
              background: "var(--bg-2)",
              color: "var(--text)",
              fontFamily: "var(--sans)",
              fontSize: "0.875rem",
              border: `2px solid ${showFormatError ? "var(--red, #ef4444)" : "var(--border)"}`,
            }}
          />
          {showFormatError && (
            <p style={{ color: "var(--red, #ef4444)", fontSize: "0.75rem", margin: "4px 0 0" }}>
              {inputState.error}
            </p>
          )}
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onSave}
            disabled={inFlight || !inputState.valid || !dirty}
            style={btnStyle(inputState.valid && dirty && !inFlight, "var(--amber)")}
          >
            {inFlight ? "Saving…" : "Save"}
          </button>
          {hasAlias && (
            <button
              onClick={onClear}
              disabled={inFlight}
              style={btnStyle(!inFlight, "var(--border)", "var(--text-3)")}
            >
              Clear alias
            </button>
          )}
        </div>

        {status.kind === "error" && (
          <p style={{ color: "var(--red, #ef4444)", fontSize: "0.8125rem", margin: 0 }}>{status.message}</p>
        )}

        {/* Explanatory copy (decision §6) */}
        <div style={{ fontSize: "0.75rem", color: "var(--text-3)", lineHeight: 1.5, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <p style={{ margin: "0 0 6px" }}>
            Setting an alias makes your node identifiable on the public Lightning network. The alias
            propagates via gossip and may take up to 24&nbsp;hours to be visible on tools like
            mempool.space.
          </p>
          <p style={{ margin: "0 0 6px" }}>
            Your alias doesn't affect channel operation, routing, or any aspect of how BitCorn works
            for you.
          </p>
          <p style={{ margin: 0 }}>
            You can change or clear your alias at any time. Clearing stops your node from
            re-asserting it, but a previously-published alias may persist in network history and
            explorer archives.
          </p>
        </div>

        {/* Auto-renew subscription (auto-pay opt-in) */}
        <AutoPaySection />
      </div>
    </div>
  );
}

function btnStyle(active: boolean, border: string, color = "var(--amber)"): React.CSSProperties {
  return {
    padding: "8px 16px",
    borderRadius: 8,
    cursor: active ? "pointer" : "not-allowed",
    opacity: active ? 1 : 0.5,
    border: `2px solid ${border}`,
    background: "var(--bg-2)",
    color,
    fontSize: "0.8125rem",
    fontWeight: 600,
    fontFamily: "var(--sans)",
  };
}

function saveErrorCopy(code: string | undefined, fallback: string | undefined): string {
  if (code === "alias_not_available") return "This alias is not available, please choose another.";
  if (code === "alias_lnd_failed")
    return "Could not update the alias on your Lightning node — please try again.";
  return fallback ?? "Could not save your alias — please try again.";
}

function clearErrorCopy(code: string | undefined, fallback: string | undefined): string {
  if (code === "alias_lnd_failed")
    return "Local alias cleared, but updating your Lightning node failed — the network announcement may lag.";
  return fallback ?? "Could not clear your alias — please try again.";
}
