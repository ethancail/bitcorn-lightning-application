// Loop Out checks that run BEFORE any loopd call that moves money
// (loop-fee-ceilings spec §4 A and B, and C1–C3). Shared by the member/admin
// path (swaps/swapService.ts) and the treasury rebalance path
// (rebalance-loop.ts), which map the outcomes to their own errors.
//
// 1. The route probe (F2; B13 as amended by item B):
//      a. probe the quote's swap_payment_dest, for the swap amount and for
//         the prepay;
//      b. if that finds no route, probe the configured Loop server pubkeys
//         (ENV.loopServerPubkeys), public nodes in the graph, with the same
//         amounts, and apply the cap to that route's fee;
//      c. if neither routes, the caller refuses before initiation.
//    A route that exists but costs more than the cap is refused at once; it
//    is not "no route", so it does not fall through to (b).
//    ⚠ WHAT THE FALLBACK DOES NOT COVER: on branch (b) the capped fee is the
//    route to the Loop server only. The final hop, Loop server → destination,
//    is Loop's own channel, priced by Loop, and stays unprobed.
//
// 2. The fee-rate check (F3): a fresh quote's miner fee, at the same amount
//    and conf target, against the stored quoted miner fee plus the margin.
//    loopd's quote is the estimate at the sweep conf target, so the two
//    compare like with like (sats for this swap's sweep).

import { ENV } from "../config/env";
import { probeLoopOutPaymentRoute } from "./lnd";
import { routingFeeCeilingSat } from "./loop";

export type LoopOutRouteBranch = "direct" | "fallback";

export type LoopOutRouteCheck =
  | {
      ok: true;
      branch: LoopOutRouteBranch;
      target: string;
      swapRouteFeeSat: number;
      prepayRouteFeeSat: number;
    }
  | {
      ok: false;
      reason: "over_cap";
      branch: LoopOutRouteBranch;
      target: string;
      swapRouteFeeSat: number;
      prepayRouteFeeSat: number;
      swapCapSat: number;
      prepayCapSat: number;
    }
  | { ok: false; reason: "no_route"; checked: string[] };

export async function checkLoopOutRoutes(params: {
  swapPaymentDest: string;
  amountSat: number;
  prepaySat: number;
  outgoingChannel?: string;
}): Promise<LoopOutRouteCheck> {
  const swapCapSat = routingFeeCeilingSat(params.amountSat);
  const prepayCapSat = routingFeeCeilingSat(params.prepaySat);

  const targets: Array<{ branch: LoopOutRouteBranch; pubkey: string }> = [];
  if (params.swapPaymentDest) targets.push({ branch: "direct", pubkey: params.swapPaymentDest });
  for (const pubkey of ENV.loopServerPubkeys) {
    if (pubkey !== params.swapPaymentDest) targets.push({ branch: "fallback", pubkey });
  }

  for (const { branch, pubkey } of targets) {
    const swap = await probeLoopOutPaymentRoute(pubkey, params.amountSat, params.outgoingChannel);
    if (!swap.routable) continue;
    const prepay = await probeLoopOutPaymentRoute(pubkey, params.prepaySat, params.outgoingChannel);
    if (!prepay.routable) continue;

    const fees = { branch, target: pubkey, swapRouteFeeSat: swap.feeSat, prepayRouteFeeSat: prepay.feeSat };
    if (swap.feeSat > swapCapSat || prepay.feeSat > prepayCapSat) {
      return { ok: false, reason: "over_cap", ...fees, swapCapSat, prepayCapSat };
    }
    return { ok: true, ...fees };
  }

  return { ok: false, reason: "no_route", checked: targets.map((t) => t.pubkey) };
}

/** True when a fresh miner-fee estimate exceeds the quoted one plus the
 *  margin (ENV.loopMinerFeeMarginPct, default 50%). Integer arithmetic: the
 *  boundary (exactly quote + margin) passes. */
export function minerFeeExceedsMargin(freshSat: number, quotedSat: number): boolean {
  return freshSat * 100 > quotedSat * (100 + ENV.loopMinerFeeMarginPct);
}
