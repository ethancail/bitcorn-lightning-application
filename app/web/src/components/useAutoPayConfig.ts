// Shared auto-pay config hook for the ambient surfaces (dashboard banner +
// Settings nav badge). The useSubscriptionStatus mold: immediate load →
// setInterval(60s) → cleanup, plus a reload() the banner calls after a
// dismiss/acknowledge so the surfaces update without waiting for the next poll.
//
// One GET /api/profile/auto-pay feeds the price-change-pending flag, the active
// alerts, and the badge summary (spec §8C). Member-shell only — the treasury
// has no subscription of its own and the endpoint 403s there. Fail-silent: a
// failed poll keeps the last payload; the hook stays null until first success.

import { useCallback, useEffect, useState } from "react";
import { api, type AutoPayConfig } from "../api/client";

const POLL_INTERVAL_MS = 60_000;

export function useAutoPayConfig(): { cfg: AutoPayConfig | null; reload: () => void } {
  const [cfg, setCfg] = useState<AutoPayConfig | null>(null);
  const reload = useCallback(() => {
    api.getAutoPayConfig().then(setCfg).catch(() => {});
  }, []);
  useEffect(() => {
    reload();
    const id = setInterval(reload, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reload]);
  return { cfg, reload };
}
