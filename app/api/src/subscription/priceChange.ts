// Subscription auto-pay price-change detection — pure logic.
//
// Implements specs/2026-06-12-subscription-auto-pay-implementation.md §6.
// Because the auto-pay amount is server-derived at each fire, a price change
// propagates automatically; to keep the standing authorization honest, an
// opted-in member sees a NON-dismissible banner until they acknowledge the
// new price or opt out. These pure helpers compute the "is the banner due"
// flag and its copy — no DB, no network (A1 posture, §9).

const SATS = new Intl.NumberFormat("en-US");

export interface PriceChangeInput {
  /** From the proxied subscription status: applicable === true. */
  applicable: boolean;
  /** The member's stored opt-in flag. */
  autoPayEnabled: boolean;
  /** Live price from the proxied status (sats). */
  currentPriceSats: number;
  /** member_profile.last_acknowledged_price (sats), or null if never set. */
  lastAcknowledgedPrice: number | null;
}

/**
 * The price-change banner is pending iff the status is applicable, auto-pay is
 * enabled, and the live price is ABOVE the last acknowledged price — the only
 * case in which auto-pay refuses (the price ceiling, pay-from-node D3). A fall
 * shows no banner (ruled 2026-11-05, ruling M): the acknowledge route never
 * lowers the stored price, so a banner shown for a fall could never be cleared.
 * A null acknowledged price while enabled still counts as pending, unchanged —
 * though opt-in seeds it, so that path is unusual. Gating on `autoPayEnabled`
 * means opting out immediately clears the banner.
 */
export function priceChangePending(input: PriceChangeInput): boolean {
  if (!input.applicable) return false;
  if (!input.autoPayEnabled) return false;
  if (input.lastAcknowledgedPrice == null) return true;
  return input.currentPriceSats > input.lastAcknowledgedPrice;
}

export interface PriceChangeContent {
  headline: string;
  body: string;
  currentPrice: number;
  previousPrice: number | null;
}

/** Banner copy for a pending price change (spec §6 suggested copy). */
export function priceChangeContent(
  currentPrice: number,
  lastAck: number | null,
): PriceChangeContent {
  const prev = lastAck != null ? `${SATS.format(lastAck)} sats` : "a different amount";
  return {
    headline: "Subscription price has changed",
    body: `Your auto-pay will now charge ${SATS.format(currentPrice)} sats. Previously: ${prev}.`,
    currentPrice,
    previousPrice: lastAck,
  };
}
