// BitcornNamePanel — the member's Bitcorn-level name (NOT the LND alias).
//
// Source: bitcorn-research/specs/2026-09-23-member-name-prompt-spec.md §7.4,
// §8 (D6 §3). Member view only (mounted with !isTreasury), in Settings
// "Personal" directly above ProfilePanel, which is left untouched. This is
// where the dashboard's member-name prompt sends the farmer.
//
// Stored on this node only. The "who can see it" line must stay TRUE AT SHIP:
// until the transport (D5 part 2) exists the name reaches nobody, so the line
// says exactly that. ⚠ Part 2 MUST revise it in the same release the name
// starts travelling — a label that is true now becomes false that day.
//
// Overwrite only: no clear action (accepted, spec §6). A thin renderer over
// bitcornNameInputState (client hints) + the API (authoritative; errors are
// specific, so the server's `detail` is shown as-is).

import { useCallback, useEffect, useState } from "react";
import { api, type BitcornName } from "../api/client";
import { bitcornNameInputState, BITCORN_NAME_MAX_CHARS } from "./bitcornNameInputState";

// ⚠ COPY IS PROPOSED, NOT ACCEPTED (spec §8).
export const BITCORN_NAME_FIELD_LABEL = "BitCorn name";
export const BITCORN_NAME_VISIBILITY_LINE =
  "Stored on this node only. Not published to the Lightning network. (Your public alias, below, is.)";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

export default function BitcornNamePanel() {
  const [current, setCurrent] = useState<BitcornName | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const load = useCallback(async () => {
    try {
      const n = await api.getBitcornName();
      setCurrent(n);
      setInput(n.bitcorn_name ?? "");
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const inFlight = status.kind === "saving";
  const inputState = bitcornNameInputState(input);
  const dirty = current ? inputState.normalized !== (current.bitcorn_name ?? "") : true;
  const showFormatError = input.trim().length > 0 && !inputState.valid;
  const counterOver = inputState.charCount > BITCORN_NAME_MAX_CHARS;

  async function onSave() {
    if (!inputState.valid || inFlight) return;
    setStatus({ kind: "saving" });
    try {
      await api.setBitcornName(inputState.normalized);
      await load();
      setStatus({ kind: "idle" });
    } catch (e: any) {
      setStatus({ kind: "error", message: e?.detail ?? "Could not save your name — please try again." });
    }
  }

  // marginBottom: .panel carries no margin, and ProfilePanel (left unmodified)
  // sits directly below — without it the two would be flush (the 0px gap the
  // Appearance panel's comment in App.tsx records fixing).
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <span className="panel-title"><span className="icon">◉</span>{BITCORN_NAME_FIELD_LABEL}</span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {loadFailed ? (
          <p style={{ color: "var(--text-3)", fontSize: "0.8125rem", margin: 0 }}>
            Couldn't load your name. It will retry when you reload.
          </p>
        ) : !current ? (
          <p style={{ color: "var(--text-3)", fontSize: "0.8125rem", margin: 0 }}>Loading…</p>
        ) : null}

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: "0.8125rem", fontWeight: 500 }}>{BITCORN_NAME_FIELD_LABEL}</span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: "0.6875rem",
                color: counterOver ? "var(--red, #ef4444)" : "var(--text-3)",
              }}
            >
              {inputState.charCount} / {BITCORN_NAME_MAX_CHARS}
            </span>
          </div>
          <input
            type="text"
            value={input}
            disabled={inFlight || loadFailed}
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
          <p style={{ color: "var(--text-3)", fontSize: "0.75rem", margin: "6px 0 0" }}>
            {BITCORN_NAME_VISIBILITY_LINE}
          </p>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onSave}
            disabled={inFlight || loadFailed || !inputState.valid || !dirty}
            style={btnStyle(inputState.valid && dirty && !inFlight && !loadFailed)}
          >
            {inFlight ? "Saving…" : "Save"}
          </button>
        </div>

        {status.kind === "error" && (
          <p style={{ color: "var(--red, #ef4444)", fontSize: "0.8125rem", margin: 0 }}>{status.message}</p>
        )}
      </div>
    </div>
  );
}

function btnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "8px 16px",
    borderRadius: 8,
    cursor: active ? "pointer" : "not-allowed",
    opacity: active ? 1 : 0.5,
    border: "2px solid var(--amber)",
    background: "var(--bg-2)",
    color: "var(--amber)",
    fontSize: "0.8125rem",
    fontWeight: 600,
    fontFamily: "var(--sans)",
  };
}
