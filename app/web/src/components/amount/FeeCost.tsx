// A fee-speed card's cost (Ethan's ruling "fix the five", 2026-11-16): the
// member Connect card, the treasury's open panel and its close dialog.
//
//   A figure → an estimate in the amount's form: "about $0.59" over "~770
//     sats"; with no price, "~770 sats" alone (item 5). Each line never splits.
//   null (Economy, which sends no fee rate) → the words "Fee set by your node",
//     with no figure; worded, so it may wrap, balanced (items 1 and 2).
//
// Display only: what each picker sends is its own rate, unchanged.

import type { ExchangeRate } from "../../api/client";
import { Amount } from "./Amount";

/** Economy's cost: the node sets its fee, so there is no figure (ruling "a"). */
export const FEE_SET_BY_NODE = "Fee set by your node";

export function FeeCost({ sats, rate }: { sats: number | null; rate: ExchangeRate | null | undefined }) {
  if (sats == null) return <span className="fee-cost-words">{FEE_SET_BY_NODE}</span>;
  return <Amount sats={sats} rate={rate} approx />;
}
