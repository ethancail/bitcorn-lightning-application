// The page's one "price isn't available" line (member-first-run-ui slice 1,
// ruled 2026-11-13): placed ONCE per page by the page, never per amount (amount
// spec §1 items 6 and 8). Its copy is amountDescriptor.ts's.
//
//   no rate (state "none", no usd, or unread: null) → the sentence.
//   loading (undefined) → nothing: the sentence never shows while the rate
//     loads (R31).
//   a usable rate → nothing.
// No aria-live (spec §1 item 5).

import type { ExchangeRate } from "../../api/client";
import { usableUsd } from "./Amount";
import { NO_RATE_NOTE } from "./amountDescriptor";

export function NoRateNote({ rate }: { rate: ExchangeRate | null | undefined }) {
  if (rate === undefined || usableUsd(rate) != null) return null;
  return <p className="amount-page-note">{NO_RATE_NOTE}</p>;
}
