// The member Lightning payment fee limit (drive-mode spec P1 item 4; R15(7),
// R18(7); confirmed by R20).
//
//   max_fee_mtokens = base_sat × 1000 + floor(amount_msat × ppm / 1,000,000)
//
// With the defaults (10 sats, 10,000 ppm) that is 10,000 + amount_msat / 100,
// exact for any whole-sat amount. Members only: the treasury's own payments
// carry no limit. Shown to the member rounded UP to whole sats, a true upper
// bound.

import { ENV } from "../config/env";
import { getNodeInfo } from "../api/read";

/** True unless this node is the treasury (R18(7)). A node whose role is not
 *  yet known is treated as a member: the limit errs on the side of applying. */
export function payFeeLimitApplies(): boolean {
  return getNodeInfo()?.node_role !== "treasury";
}

/** The limit in millisats for an amount in millisats, as ln-service takes it. */
export function maxFeeMtokensFor(amountMtokens: string | number): string {
  const amount = BigInt(String(amountMtokens || "0"));
  const base = BigInt(Math.round(ENV.memberPayMaxFeeBaseSat * 1000));
  const ppm = BigInt(Math.round(ENV.memberPayMaxFeePpm));
  return (base + (amount * ppm) / 1_000_000n).toString();
}

/** Millisats → whole sats, rounded up. */
export function mtokensToSatsCeil(mtokens: string): number {
  return Number((BigInt(mtokens) + 999n) / 1000n);
}

/** The member's limit for a decoded invoice, or null on the treasury. */
export function memberMaxFeeMtokens(amountMtokens: string | number): string | null {
  return payFeeLimitApplies() ? maxFeeMtokensFor(amountMtokens) : null;
}
