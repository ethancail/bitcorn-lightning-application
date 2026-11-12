// Polls GET /api/subscription/pay-from-node/pending (drive-mode R45, ruling 1)
// while `enabled`: the Settings panel with its 15 s status poll, the dashboard
// banner only while a tier banner shows. Fail-silent: a failed read keeps the
// last answer (the waiting state must not flicker off and invite a second
// send). Disabled returns null and fetches nothing, so a healthy member's
// dashboard makes no extra request.

import { useEffect, useState } from "react";
import { api, type PendingPayment } from "../api/client";

export function usePendingPayment(enabled: boolean, pollMs: number): PendingPayment | null {
  const [pending, setPending] = useState<PendingPayment | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      api
        .getPayFromNodePending()
        .then((r) => { if (!cancelled) setPending(r?.pending ?? null); })
        .catch(() => { /* keep the last answer */ });
    void load();
    const id = setInterval(() => void load(), pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, pollMs]);
  return enabled ? pending : null;
}
