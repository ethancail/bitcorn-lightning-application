// BitcornNamePanel — the member's Bitcorn-level name (NOT the LND alias).
//
// Source: bitcorn-research/specs/2026-09-23-member-name-prompt-spec.md §7.4,
// §8 (D6 §3). Member view only (mounted with !isTreasury), in Settings
// "Personal" directly above ProfilePanel (the public alias). This is where
// the dashboard's member-name prompt sends the farmer — via
// /settings?focus=name, which SettingsPage turns into focusOnMount.
//
// Stored on this node and, since D5 part 2 (D8), sent to the treasury with
// every token refresh under its own signature. The "who can see it" line must
// stay TRUE AT SHIP, so it now says the name is shared with BitCorn. ⚠ RELEASE
// PRECONDITION (D8 §10): the treasury must run the part-2 code before any
// member sees this line — against a treasury that drops the fields unread, it
// would be false.
//
// Saving triggers one token refresh server-side (D8 call 9), so the treasury
// hears the name in seconds; this panel then re-reads once after a delay so a
// "rejected" verdict can appear in the same visit. The rejected message is
// GENERIC and never says why (D8 call 8), and shows only for the CURRENT name
// (the API compares name_sent — spec §6.3).
//
// Overwrite only: no clear action (accepted, spec §6). A thin renderer over
// bitcornNameInputState (client hints) + the API (authoritative; errors are
// specific, so the server's `detail` is shown as-is).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BitcornName } from "../api/client";
import { bitcornNameInputState, BITCORN_NAME_MAX_CHARS } from "./bitcornNameInputState";

// ACCEPTED — Ethan's exact wording, 2026-09-23.
export const BITCORN_NAME_FIELD_LABEL = "Your name for BitCorn";
// ACCEPTED — Ethan, 2026-09-28 (D8 spec §10, as proposed). Replaced the
// 2026-09-23 "Saved on this node only — …", whose "only" became false the day
// the name started travelling. Changed in the same release as the dashboard
// prompt body, which carried the same coupling. ⚠ RELEASE PRECONDITION: true
// only once the treasury runs part 2 (see header).
export const BITCORN_NAME_VISIBILITY_LINE =
  "Shared with BitCorn — never published to the Lightning network. Your public alias, below, is published.";
// ACCEPTED — Ethan, 2026-09-28, with ONE change from the spec's proposal: the
// "Try a different one." sentence §10 offered is added. Meaning per D8 call
// 8: generic, never says why.
export const BITCORN_NAME_REJECTED_MESSAGE = "BitCorn couldn't accept this name. Try a different one.";

// ACCEPTED — Ethan, 2026-09-29 (settings-name-clarity, as built). The button
// names what it saves: this panel and ProfilePanel below both read a bare
// "Save" before.
export const BITCORN_NAME_SAVE_LABEL = "Save name";
// ACCEPTED — Ethan, 2026-09-29. Shown in the status slot when the read
// succeeded and no name is stored — never while loading or after a failed
// read (unknown is not unset).
export const BITCORN_NAME_UNSET_LINE = "Not set yet";
// ACCEPTED — Ethan, 2026-09-29. Must NOT duplicate ProfilePanel's
// `e.g. "Lazy Acres Farm"` — the two fields hold different things. The
// example must itself pass bitcornNameInputState (pinned).
export const BITCORN_NAME_PLACEHOLDER = 'e.g. "Cedar Creek Grain"';

// The one delayed re-read after a save (spec §9.2; 5s ACCEPTED — Ethan,
// 2026-09-28) — long enough for the save's token refresh to round-trip.
export const NAME_STATUS_RECHECK_MS = 5_000;

// How long the deep link keeps re-landing the field while the page above it
// is still loading (see the landing effect). Generous because the panels
// above wait on the treasury's Worker round-trip on a real node. The
// re-landing and this 10s window: ACCEPTED as in scope — Ethan, 2026-09-29.
export const NAME_FIELD_LANDING_WINDOW_MS = 10_000;
// Anything the member does themselves ends the re-landing.
const MEMBER_INPUT_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

export default function BitcornNamePanel({ focusOnMount = false }: { focusOnMount?: boolean }) {
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

  // The one pending delayed re-read; cleared on unmount and on a newer save.
  const recheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (recheck.current) clearTimeout(recheck.current);
  }, []);

  // The dashboard prompt's deep link: bring the field into view and focus it,
  // once. Waits for the name read so the "Loading…" line above the field has
  // already collapsed and cannot move it afterwards. scrollIntoView, as in
  // Liquidity.tsx's row select, scrolls whichever ancestor actually scrolls —
  // .main-content, which the router does not reset between routes — by the
  // field's CURRENT offset, so whatever scrollTop the previous page left
  // behind doesn't matter. Instant, not smooth: this is a page landing.
  // "center", not the precedent's "nearest": nearest leaves the field on the
  // bottom edge, where any growth above pushes it straight off screen.
  //
  // One scroll is not enough. The panels above (subscription, auto-pay) load
  // on their own reads; measured in a browser at 500×700, when they finished
  // after the name read they grew ~970px and left the focused field far below
  // the fold. So re-land whenever the page holding this panel changes size,
  // until the member does anything themselves (never fight them) or the
  // window closes. The teardown lives in a ref, not this effect's cleanup:
  // the effect re-runs on every `current`, and focusedOnce would stop it
  // re-arming.
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusedOnce = useRef(false);
  const stopLanding = useRef<(() => void) | null>(null);
  useEffect(() => () => stopLanding.current?.(), []);
  useEffect(() => {
    if (!focusOnMount || focusedOnce.current || !current) return;
    focusedOnce.current = true;
    const field = inputRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    const land = () => field.scrollIntoView({ block: "center" });
    land();

    const page = panelRef.current?.parentElement;
    if (!page || typeof ResizeObserver === "undefined") return; // jsdom has none
    const watch = new ResizeObserver(land);
    watch.observe(page);
    const stop = () => {
      watch.disconnect();
      clearTimeout(timer);
      for (const t of MEMBER_INPUT_EVENTS) window.removeEventListener(t, stop, true);
      stopLanding.current = null;
    };
    const timer = setTimeout(stop, NAME_FIELD_LANDING_WINDOW_MS);
    for (const t of MEMBER_INPUT_EVENTS) window.addEventListener(t, stop, { capture: true, passive: true });
    stopLanding.current = stop;
  }, [focusOnMount, current]);

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
      // The member top bar re-reads the name on this event (App.tsx).
      window.dispatchEvent(new CustomEvent("bitcorn:name-changed"));
      await load();
      setStatus({ kind: "idle" });
      if (recheck.current) clearTimeout(recheck.current);
      recheck.current = setTimeout(() => {
        recheck.current = null;
        void load();
      }, NAME_STATUS_RECHECK_MS);
    } catch (e: any) {
      setStatus({ kind: "error", message: e?.detail ?? "Could not save your name — please try again." });
    }
  }

  // marginBottom: .panel carries no margin, and ProfilePanel sits directly
  // below — without it the two would be flush (the 0px gap the
  // Appearance panel's comment in App.tsx records fixing).
  return (
    <div ref={panelRef} className="panel" style={{ marginBottom: 16 }}>
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
        ) : !current.bitcorn_name ? (
          <p style={{ color: "var(--text-3)", fontSize: "0.8125rem", margin: 0 }}>{BITCORN_NAME_UNSET_LINE}</p>
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
            ref={inputRef}
            type="text"
            value={input}
            placeholder={BITCORN_NAME_PLACEHOLDER}
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
          {current?.treasury_name_status === "rejected" && (
            <p style={{ color: "var(--red, #ef4444)", fontSize: "0.75rem", margin: "4px 0 0" }}>
              {BITCORN_NAME_REJECTED_MESSAGE}
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
            {inFlight ? "Saving…" : BITCORN_NAME_SAVE_LABEL}
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
