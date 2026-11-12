// The member's own minimum connection sizes, gathered live for the Automatic
// transfers page (drive-mode P3; R19(6), R21). The formula is
// minimumConnection.ts's; this only reads its inputs:
//   role        member_liquidity_advisor_config.channel_role (032)
//   capacity    the hub channel, the largest inactive one for display when
//               none is active (R18(2)) — the page's "yours is …"
//   commit fee  that channel's commit_fee_sat and commitment_type
//   rate        the cached BTC/USD rate; "none" → no figure
//   S_min       effectiveLimits for the role's direction, with loopd's live
//               terms when it answers, the env limits when not
//   rails       the member's effective fee limit (for Q)
// Read-only: one loopd terms call, no quote, no row written.

import { getHubChannelForDisplay } from "../lightning/hubChannel";
import { getLoopInTerms, getLoopOutTerms } from "../lightning/loop";
import { getBtcUsd } from "../price/btcUsdCache";
import { effectiveLimits, type LoopTermsLike } from "../swaps/effectiveLimits";
import { minimumsForRole, type MemberRole, type MinimumBreakdown } from "./minimumConnection";
import { effectiveTransferSettings, memberRole } from "./transferSettings";

// memberRole() lives in transferSettings.ts (the per-transfer default follows
// it, R59(3)); re-exported here for this module's existing importers.
export { memberRole };

export type MemberMinimums = {
  role: MemberRole | "unknown";
  capacity_sats: number | null;
  hub_active: boolean | null;
  save: MinimumBreakdown | null;
  open: MinimumBreakdown | null;
};

export async function memberMinimumConnections(): Promise<MemberMinimums> {
  const role = memberRole();
  const hub = getHubChannelForDisplay();
  const base = { role, capacity_sats: hub?.capacity_sat ?? null, hub_active: hub ? hub.active === 1 : null };
  if (role === "unknown") return { ...base, save: null, open: null };
  const direction = role === "farmer" ? "loop_out" : "loop_in";
  let terms: LoopTermsLike | null = null;
  try {
    terms = await (direction === "loop_out" ? getLoopOutTerms() : getLoopInTerms());
  } catch {
    terms = null; // the env limits apply
  }
  const rails = effectiveTransferSettings();
  const m = minimumsForRole({
    role,
    usdPerBtc: getBtcUsd().usd,
    loopMinSats: effectiveLimits(direction, terms).min_sats,
    commitFeeSats: hub?.commit_fee_sat ?? null,
    commitmentType: hub?.commitment_type ?? null,
    feeLimitUsdCents: rails.fee_limit_usd_cents,
  });
  return { ...base, ...m };
}
