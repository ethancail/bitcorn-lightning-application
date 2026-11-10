// The absolute member-side cap on the subscription price, and the integer
// check (bitcorn-research specs/2026-11-10-treasury-price-trust-spec.md §5;
// decision D3: "a signature doesn't stop a compromised treasury; a cap does").
//
// ONE source constant, shipped pinned with each release as TREASURY_PUBKEY is.
// Not an environment variable (an unset path and a mis-parse path per node),
// not a value from the treasury or the Worker (the trust root it bounds), and
// not the local subscription_policy row (ruling 3: never synced, a stale seed).
// Ruling 1: whatever the value, it ships as a default in code or the compose
// file, never as a per-member .env step.
//
// Callers pass the constant into checkSubscriptionPrice explicitly, so the cap
// is an injectable parameter of one pure check and tests can supply their own.
//
// Neither refusal can be acknowledged: price_acknowledged does not lift the
// cap (C6b), and the acknowledge route refuses above it.

// ⚠ OWED — the value is Ethan's (pricing policy, spec §13 item 1). It is
// deliberately UNSET, so this build FAILS CLOSED: with no cap, no price is
// within the cap and no subscription payment proceeds. priceCap.test.ts stays
// red until a value lands on the line below. Do not put a placeholder here.
export const SUBSCRIPTION_PRICE_CAP_SATS: number | undefined = undefined;

export type PriceRefusalCode = "price_not_integer" | "price_above_cap";

export type PriceCheck =
  | { ok: true }
  | { ok: false; code: PriceRefusalCode; detail: string };

/** True for a cap that can bound anything: a positive safe integer. */
export function isUsableCap(cap: unknown): cap is number {
  return typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0;
}

/**
 * The one check, used everywhere a price is about to be paid, quoted or
 * recorded (E1–E4): a positive safe integer, at or below the cap.
 */
export function checkSubscriptionPrice(price: unknown, cap: number | undefined): PriceCheck {
  if (typeof price !== "number" || !Number.isSafeInteger(price) || price <= 0) {
    return { ok: false, code: "price_not_integer", detail: `price ${String(price)} is not a positive whole number of sats` };
  }
  if (!isUsableCap(cap)) {
    return {
      ok: false,
      code: "price_above_cap",
      detail: "SUBSCRIPTION_PRICE_CAP_SATS is not set in this build; no price is within the cap",
    };
  }
  if (price > cap) {
    return { ok: false, code: "price_above_cap", detail: `price ${price} sats is above the cap of ${cap} sats` };
  }
  return { ok: true };
}
