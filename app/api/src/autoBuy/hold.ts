// The post-fill withdrawal hold, per provider: how long after a buy fills
// before its BTC may be swept (kraken-autobuy spec §3 P2, ruling S2, E1).
//
// The one source for the hold. The scheduler's sweep cutoff reads it, and the
// API reports each run's hold end from it, so the web never mirrors a constant.
// E1 allows no per-farm setting: the hold depends on the provider alone.

export type AutobuyProvider = "coinbase" | "kraken";

const HOLD_SECONDS: Record<AutobuyProvider, number> = {
  coinbase: 72 * 3600,  // Coinbase: 72 hours
  kraken: 7 * 86400,    // Kraken: 7 days (E1)
};

/** The hold, in seconds, for a provider. Throws on anything else: the DB CHECK admits only these two. */
export function holdSecondsFor(provider: string): number {
  if (provider === "coinbase" || provider === "kraken") return HOLD_SECONDS[provider];
  throw new Error(`unknown_autobuy_provider: ${provider}`);
}

/** When a run's hold ends: filled_at plus the provider's hold, or null when the run has not filled. */
export function holdEndsAt(provider: string, filledAt: number | null | undefined): number | null {
  return filledAt == null ? null : filledAt + holdSecondsFor(provider);
}
