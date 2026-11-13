// The minimum connection size — ONE formula for both roles and both
// strategies (drive-mode P3; R16(6), R17(1)–(3), R19(6), R21; R40(2)).
//
//   min(role, strategy) = ceil( (F + S_min + K + Q + H + C) / (1 − 2r) )
//
//   F      the strategy's floor, R16(2) dollars at the cached rate (round to
//          the nearest sat). No rate ("none") → no figure.
//   S_min  Loop's effective minimum for the role's direction: Loop Out for a
//          farmer, Loop In for a merchant (effectiveLimits: env or loopd's,
//          whichever is stricter).
//   K      the Loop Out swap buffer (env swapMemberRoutingBufferSat, 50,000)
//          for a farmer; 0 for a merchant.
//   Q      a farmer's Loop Out fee allowance — execute needs amount + fee ≤
//          room − K — taken as the member's own fee-limit rail, R40(2): the
//          one dollar figure (R48; the percent is removed, R59(1)) at the
//          cached rate. 0 for a merchant.
//   H      the funder's fee headroom (capacity.ts funderHeadroomSats; members
//          open their own channels, so they are the funder).
//   C      the commitment fee plus the two 330-sat anchor outputs on anchor
//          and taproot channels (lnd's commit_fee excludes them).
//   r      the 1% channel reserve, per side.
//
// Where it comes from: a farmer's smallest transfer must leave room to receive
// at the floor; a merchant's room to send at the floor must leave room to
// receive Loop In's minimum. Both reduce to the same inequality, with
// proportional reserves on both sides giving the (1 − 2r) divisor.
//
// R40(2): the FORMULA is the ruling. Sizes are computed live — there are no
// separate number rulings — so they move with the BTC price.
//
// Anything but "open" computes as "save". Manual only is dropped (R59(4)); a
// row that stored it reads as "save" before it reaches here (transferSettings
// strategyOf), as it always computed (R21(1)).

import { ENV } from "../config/env";
import { funderHeadroomSats } from "../lightning/capacity";
import { STRATEGY_FLOORS_USD_CENTS, type TransferStrategy } from "./transferSettings";

export const RESERVE_FRACTION = 0.01;
export const ANCHOR_OUTPUTS_SAT = 2 * 330;
const ANCHOR_TYPES = ["anchor", "anchor_with_lease_constraint", "simplified_taproot"];

export type MemberRole = "farmer" | "merchant";

export type MinimumInputs = {
  role: MemberRole;
  strategy: TransferStrategy;
  /** The cached BTC/USD rate, null when its state is "none". */
  usdPerBtc: number | null;
  /** Loop's effective minimum for the role's direction. */
  loopMinSats: number;
  /** The hub channel's commitment fee (lnd_channels.commit_fee_sat). */
  commitFeeSats: number | null;
  commitmentType: string | null;
  /** The member's fee-limit rail (effective settings), for Q. */
  feeLimitUsdCents: number;
};

export type MinimumBreakdown = {
  sats: number;
  F: number; S_min: number; K: number; Q: number; H: number; C: number; r: number;
};

export function usdCentsToSats(cents: number, usdPerBtc: number): number {
  return Math.round((cents / 100 / usdPerBtc) * 100_000_000);
}

/** The minimum for one role and strategy, with its terms; null when a term
 *  has no value (no rate, or no synced commitment fee). */
export function minimumConnection(i: MinimumInputs): MinimumBreakdown | null {
  if (i.usdPerBtc == null || !(i.usdPerBtc > 0) || i.commitFeeSats == null) return null;
  const strategy = i.strategy === "open" ? "open" : "save";
  const F = usdCentsToSats(STRATEGY_FLOORS_USD_CENTS[i.role][strategy], i.usdPerBtc);
  const S_min = i.loopMinSats;
  const farmer = i.role === "farmer";
  const K = farmer ? ENV.swapMemberRoutingBufferSat : 0;
  const Q = farmer ? usdCentsToSats(i.feeLimitUsdCents, i.usdPerBtc) : 0;
  const H = funderHeadroomSats(i.commitFeeSats, i.commitmentType);
  const anchors = i.commitmentType == null || ANCHOR_TYPES.includes(i.commitmentType) ? ANCHOR_OUTPUTS_SAT : 0;
  const C = i.commitFeeSats + anchors;
  const r = RESERVE_FRACTION;
  const sats = Math.ceil((F + S_min + K + Q + H + C) / (1 - 2 * r));
  return { sats, F, S_min, K, Q, H, C, r };
}

/** Both strategies' sizes for a role: Save on fees (also Manual only's
 *  advice) and Keep room open (R17(1): the larger). */
export function minimumsForRole(base: Omit<MinimumInputs, "strategy">): { save: MinimumBreakdown | null; open: MinimumBreakdown | null } {
  return {
    save: minimumConnection({ ...base, strategy: "save" }),
    open: minimumConnection({ ...base, strategy: "open" }),
  };
}
