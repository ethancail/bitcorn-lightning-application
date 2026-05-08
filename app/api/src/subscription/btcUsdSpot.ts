// Best-effort BTC/USD spot read for `amount_usd_cents_at_receipt`.
//
// Per spec §4: read direct from api.coinbase.com/v2/prices/BTC-USD/spot
// with a 2-second timeout, no retry. On any failure (timeout, non-200,
// parse error), return null and let the caller log a warning. The field
// is reporting metadata, not enforcement input — a missing value on
// rare occasions is acceptable and must not block the credit.

const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const TIMEOUT_MS = 2000;

/**
 * Returns BTC price in USD cents (integer) or null on any failure.
 * Caller is responsible for any logging — this function is silent.
 */
export async function fetchBtcUsdCents(): Promise<number | null> {
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
