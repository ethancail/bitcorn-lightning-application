// The ceilings a swap authorises, as the quote response shows them and the
// execute body echoes them (loop-fee-ceilings spec §6, F4). Pure: no db.
//
// They are exactly what initiateSwap sends loopd:
//   Loop Out (A, B): max_swap_fee = quoted swap fee; max_prepay_amt = quoted
//     prepay; max_miner_fee = quoted sweep fee; the two routing ceilings =
//     the routing cap on the swap amount and on the prepay (computed by the
//     same routingFeeCeilingSat executeLoopOutSwap uses).
//   Loop In (D): max_swap_fee = quoted swap fee alone; max_miner_fee = quoted
//     HTLC fee.
//
// ⚠ The routing ceilings depend on LOOP_ROUTING_FEE_CAP_PPM at the moment
// they are computed. If the setting changes between quote and execute, the
// echoed values no longer match and the swap is refused and requoted — fail
// closed, intended (spec §6).

import { routingFeeCeilingSat } from "../lightning/loop";
import type { SwapRequest } from "./swapService";

export const LOOP_OUT_CEILING_FIELDS = [
  "max_swap_fee_sat",
  "max_prepay_amt_sat",
  "max_miner_fee_sat",
  "max_swap_routing_fee_sat",
  "max_prepay_routing_fee_sat",
] as const;

export const LOOP_IN_CEILING_FIELDS = ["max_swap_fee_sat", "max_miner_fee_sat"] as const;

export type SwapCeilings = Partial<Record<(typeof LOOP_OUT_CEILING_FIELDS)[number], number>>;

type CeilingSource = Pick<
  SwapRequest,
  "swap_type" | "amount_sat" | "quoted_swap_fee_sat" | "quoted_prepay_sat" | "quoted_miner_fee_sat"
>;

/** The ceilings for a stored quote, or null when the row lacks its quote
 *  components (a pre-migration row, which execute refuses anyway). */
export function ceilingsFor(req: CeilingSource): SwapCeilings | null {
  if (req.quoted_swap_fee_sat == null || req.quoted_miner_fee_sat == null) return null;
  if (req.swap_type === "loop_in") {
    return { max_swap_fee_sat: req.quoted_swap_fee_sat, max_miner_fee_sat: req.quoted_miner_fee_sat };
  }
  if (req.quoted_prepay_sat == null) return null;
  return {
    max_swap_fee_sat: req.quoted_swap_fee_sat,
    max_prepay_amt_sat: req.quoted_prepay_sat,
    max_miner_fee_sat: req.quoted_miner_fee_sat,
    max_swap_routing_fee_sat: routingFeeCeilingSat(req.amount_sat),
    max_prepay_routing_fee_sat: routingFeeCeilingSat(req.quoted_prepay_sat),
  };
}

/** True when every expected ceiling is echoed with the same value. A missing
 *  or non-numeric echo is a mismatch. Extra keys are ignored. */
export function ceilingsMatch(expected: SwapCeilings, echoed: Record<string, unknown> | undefined): boolean {
  if (!echoed) return false;
  return Object.entries(expected).every(([k, v]) => {
    const raw = echoed[k];
    return raw !== undefined && raw !== null && raw !== "" && Number(raw) === v;
  });
}
