// fee-estimates — the ONE estimate hook the three fee cards share (spec §4, §10).
//
//   · Fetches GET /api/fee-estimates when the card is shown (`enabled`), and
//     every 5 min while it stays shown (P2, P18).
//   · Records when the CARD fetched (fetchedAtMs): P18's 10-min bound is
//     measured from there, at confirm time (see isStaleAtConfirm).
//   · A failed read is "unavailable", exactly like the API's own unavailable
//     answer: no figure, submit blocked (O7).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type FeeEstimates } from "../../api/client";
import { CONFIRM_STALE_AFTER_MS, REFRESH_INTERVAL_MS } from "./feeEstimatesDescriptor";

export type FeeEstimatesStatus = "loading" | "ready" | "unavailable";

export interface FeeEstimatesHandle {
  status: FeeEstimatesStatus;
  /** The last answer; null while loading, after a failed read, or when unavailable. */
  estimates: FeeEstimates | null;
  /** When the card fetched `estimates` (Date.now()), or null before the first answer. */
  fetchedAtMs: number | null;
  /** Fetch now; resolves to the new answer (null if unavailable) and its fetch time. */
  refresh: () => Promise<{ estimates: FeeEstimates | null; fetchedAtMs: number }>;
}

/** P18 (a): a shown estimate is stale at confirm when the card fetched it over 10 min ago. */
export function isStaleAtConfirm(fetchedAtMs: number | null, nowMs: number): boolean {
  return fetchedAtMs == null || nowMs - fetchedAtMs > CONFIRM_STALE_AFTER_MS;
}

export function useFeeEstimates({ enabled }: { enabled: boolean }): FeeEstimatesHandle {
  const [estimates, setEstimates] = useState<FeeEstimates | null>(null);
  const [fetchedAtMs, setFetchedAtMs] = useState<number | null>(null);
  const [status, setStatus] = useState<FeeEstimatesStatus>("loading");
  const live = useRef(true);

  const refresh = useCallback(async () => {
    let next: FeeEstimates | null = null;
    try {
      const answer = await api.getFeeEstimates();
      next = answer && answer.source !== "unavailable" && answer.options ? answer : null;
    } catch {
      next = null;
    }
    const at = Date.now();
    if (live.current) {
      setEstimates(next);
      setFetchedAtMs(at);
      setStatus(next ? "ready" : "unavailable");
    }
    return { estimates: next, fetchedAtMs: at };
  }, []);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const id = setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, refresh]);

  return { status, estimates, fetchedAtMs, refresh };
}
