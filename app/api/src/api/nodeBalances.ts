// The Lightning side of GET /api/node/balances.
//
// `lightning_sats` is the local balance of ACTIVE channels only, as it always
// has been: the treasury dashboard reads `total_sats` from it, and that page is
// out of drive-mode's scope (spec §1.5), so it stays exactly as it was.
//
// Drive-mode P3 (BACKLOG §2 "Your Node's Total leaves out an inactive
// channel"): `lightning_inactive_sats` reports the local balance sitting in
// INACTIVE channels beside it. A member's money in a channel whose peer is
// offline is still the member's money; the member pages add it to their Total.

import { db } from "../db";

export type NodeLightningBalances = {
  lightning_sats: number;
  lightning_inactive_sats: number;
};

export function nodeLightningBalances(): NodeLightningBalances {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN active = 1 THEN local_balance_sat END), 0) AS active_total,
      COALESCE(SUM(CASE WHEN active = 1 THEN 0 ELSE local_balance_sat END), 0) AS inactive_total
    FROM lnd_channels
  `).get() as { active_total: number; inactive_total: number };
  return { lightning_sats: row.active_total, lightning_inactive_sats: row.inactive_total };
}
