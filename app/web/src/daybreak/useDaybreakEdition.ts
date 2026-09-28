// The Daybreak read, polled. The ../components/useSubscriptionStatus.ts mold —
// immediate load → setInterval → cleanup — with one addition the rest of the
// app does not have: it PAUSES while the tab is hidden and fetches at once when
// it is shown again (Ruling 3, decisions/2026-09-25-daybreak-member-screen-
// seven-rulings.md, which partially supersedes the read-path record's plain
// "every 5 minutes"). A tab that mounts hidden fetches nothing until shown.
//
// ⚠ A PLAIN HOOK, NOT React Query. React Query's provider (RailScope) wraps
// only the member shell (App.tsx), so a query hook would break the moment the
// treasury shell mounted this screen for a preview.
//
// Failure handling keeps the last good read, like useSubscriptionStatus: a
// failed poll after a success leaves the edition on screen. Before any
// success, the failure is kept as CODES ONLY — the proxy's `error` and its
// nested `reason` — and only when they are strings. The copy module decides
// whether a code is recognised; a message or status text never leaves here.

import { useEffect, useState } from "react";
import { api } from "../api/client";
import { INITIAL_FRESHNESS, recordFailure, recordSuccess, type FreshnessState } from "../components/freshness";
import { parseDaybreakRead, type DaybreakRead } from "./daybreakView";

export const DAYBREAK_POLL_INTERVAL_MS = 5 * 60_000;

// ⚠ STALE MUST NOT READ AS CURRENT. Held-over is decided by the Worker at read
// time, so a kept edition cannot learn that it has since become held over:
// with reads failing from 5 AM, yesterday's edition would still say "current"
// past the 6 AM due time. Every poll outcome is therefore recorded with
// ../components/freshness.ts (the balance poll's helper, MemberDashboard.tsx),
// and the page marks the kept read once freshnessStatus says "stale".
//
// THRESHOLD: ONE failed poll — not freshness.ts's default of three. That
// default exists so a single blip on a 15–60s poll does not flash a warning;
// at this 5-minute cadence three failures is 15 minutes of an unmarked claim,
// and after a hidden tab returns, its one immediate fetch may be the only read
// before the member looks. The marker states a fact ("couldn't refresh") rather
// than an alarm, so a blip costs one calm line for five minutes.
export const DAYBREAK_STALE_THRESHOLD = 1;

export type DaybreakFailure = { code?: string; reason?: string };

export type DaybreakState =
  | { status: "loading" }
  | { status: "ready"; read: DaybreakRead }
  | { status: "failed"; failure: DaybreakFailure };

function failureOf(err: unknown): DaybreakFailure {
  const e = err as { code?: unknown; body?: { reason?: unknown } } | null;
  const out: DaybreakFailure = {};
  if (typeof e?.code === "string") out.code = e.code;
  if (typeof e?.body?.reason === "string") out.reason = e.body.reason;
  return out;
}

export function useDaybreakEdition(): { view: DaybreakState; freshness: FreshnessState } {
  const [state, setState] = useState<DaybreakState>({ status: "loading" });
  const [freshness, setFreshness] = useState<FreshnessState>(INITIAL_FRESHNESS);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = () =>
      api
        .getDaybreakEdition()
        .then((raw) => {
          if (cancelled) return;
          const read = parseDaybreakRead(raw);
          if (read) {
            setState({ status: "ready", read });
            setFreshness((f) => recordSuccess(f, Date.now()));
          } else {
            setState((s) => (s.status === "ready" ? s : { status: "failed", failure: {} }));
            setFreshness(recordFailure);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setState((s) => (s.status === "ready" ? s : { status: "failed", failure: failureOf(err) }));
          setFreshness(recordFailure);
        });

    const start = () => {
      if (timer === null) timer = setInterval(load, DAYBREAK_POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        stop();
        void load();
        start();
      }
    };

    if (document.visibilityState !== "hidden") {
      void load();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { view: state, freshness };
}
