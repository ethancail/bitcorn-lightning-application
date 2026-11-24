// An amount inside a sentence (the amount rule, member-first-run-ui, ruled
// 2026-11-13): "$29.77 (49,619 sats)", or "49,619 sats" with no usable price.
// Moved here from withdraw/withdrawDescriptor.ts (slice 3) so Withdraw and the
// Membership panel (slice 4) share one; unchanged.

import { formatSats, formatUsd } from "./amountDescriptor";

/** `about` prefixes an estimate. */
export function inlineAmount(sats: number, usd: number | null, about = false): string {
  const lead = about ? "about " : "";
  return usd != null ? `${lead}${formatUsd(sats, usd).text} (${formatSats(sats)})` : `${lead}${formatSats(sats)}`;
}
