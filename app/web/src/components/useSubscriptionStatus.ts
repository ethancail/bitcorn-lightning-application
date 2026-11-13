// Shared subscription-status hook for the ambient discoverability
// surfaces (dashboard banner + Settings nav badge).
//
// Source of truth: specs/2026-06-11-subscription-discoverability-implementation.md §2
//
// This is the `useAutoBuyBadge` mold (App.tsx) verbatim: useEffect →
// immediate load() → setInterval(load, 60_000) → cleanup. 60s matches
// useAutoBuyBadge exactly — `/api/subscription/status` is a treasury-
// proxied call and ambient surfaces must not multiply cross-node
// traffic (the Settings panel keeps its own richer 15s poll; this hook
// is new code for the new surfaces only).
//
// Consumer model: per-consumer instantiation (MemberSidebar badge,
// MemberDashboard banner), not a context provider — at most two cached
// reads per 60s, matching the useAutoBuyBadge precedent. Member-shell
// only: the treasury has no subscription row and cannot subscribe to
// itself, so this must never be mounted in TreasurySidebar.
//
// Error handling is fail-silent: a failed poll retains the last
// successful payload (no flicker), and the hook stays null until the
// first success. When the status is unknowable the banner and badge
// simply don't render — absence over noise. The Settings panel remains
// the surface that *explains* status-fetch failures.

//
// drive-mode R45 Polar follow-up (Ethan, "recs", 2026-11-12, item 1): the
// dashboard passes STATUS_POLL_WAITING_MS while its banner shows "Payment
// sent, waiting for confirmation", so the credit clears the strip within one
// 15 s poll (the Settings panel's cadence), not up to 60 s later. A change of
// interval restarts the poll with an immediate read.

import { useEffect, useState } from "react";
import { api, type SubscriptionStatus } from "../api/client";

export const STATUS_POLL_MS = 60_000;
export const STATUS_POLL_WAITING_MS = 15_000;

export function useSubscriptionStatus(pollMs: number = STATUS_POLL_MS): SubscriptionStatus | null {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  useEffect(() => {
    const load = () =>
      api.getSubscriptionStatus().then(setStatus).catch(() => {});
    load();
    const id = setInterval(load, pollMs);
    return () => clearInterval(id);
  }, [pollMs]);
  return status;
}
