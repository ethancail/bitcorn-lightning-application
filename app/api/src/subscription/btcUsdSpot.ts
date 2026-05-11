// Best-effort BTC/USD spot read for `amount_usd_cents_at_receipt`.
//
// Per spec §4: read direct from api.coinbase.com/v2/prices/BTC-USD/spot
// with a 2-second timeout, no retry. On any failure (timeout, non-200,
// parse error), return null and let the caller log a warning. The field
// is reporting metadata, not enforcement input — a missing value on
// rare occasions is acceptable and must not block the credit.

const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const TIMEOUT_MS = 2000;
const SATS_PER_BTC = 100_000_000;

/**
 * Returns the BTC/USD spot rate as integer cents-per-BTC, or null on
 * any failure. Example: $80,244.35/BTC → 8_024_435.
 *
 * Caller is responsible for any logging — this function is silent.
 * Use `satsToUsdCents(sats, spotCentsPerBtc)` to convert a sats amount
 * to its USD-cents value.
 */
export async function fetchBtcUsdSpotCents(): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(COINBASE_SPOT_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { amount?: string } };
    const amountStr = body?.data?.amount;
    if (typeof amountStr !== "string") return null;
    const usd = parseFloat(amountStr);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return Math.round(usd * 100);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Converts a sats amount to USD cents using a BTC/USD spot rate
 * expressed as cents-per-BTC. Returns null when the rate is null
 * (caller's spot fetch failed) so the column can stay NULL.
 *
 *     50,000 sats × 8,024,435 cents/BTC ÷ 100,000,000 sats/BTC
 *     = 4,012 cents = $40.12
 */
export function satsToUsdCents(
  sats: number,
  spotCentsPerBtc: number | null,
): number | null {
  if (spotCentsPerBtc == null) return null;
  if (!Number.isFinite(sats) || sats <= 0) return null;
  return Math.round((sats * spotCentsPerBtc) / SATS_PER_BTC);
}
