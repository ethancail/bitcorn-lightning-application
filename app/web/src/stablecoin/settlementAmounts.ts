// Which figure a settlement row means TO THE MEMBER LOOKING AT IT, and at
// what precision.
//
// Pure + dependency-light so it unit-tests without a DOM or a React
// renderer — same pattern as pendingStore.ts / revertClassifier.ts (and
// app/web/vitest.config.ts only collects `*.test.ts`, not `.tsx`).
//
// ─── THE ASYMMETRY (the whole point of this module) ────────────────────
//
// SettlementRouter.settle() debits the SENDER the gross and credits the
// RECIPIENT the net, in two transfers that sum to the gross:
//
//   SettlementRouter.sol:247  fee           = amount * feeBps / 10_000
//   SettlementRouter.sol:267  netToRecipient = amount - fee
//   SettlementRouter.sol:268  transferFrom(sender, recipient, netToRecipient)
//   SettlementRouter.sol:270  transferFrom(sender, feeRecipient, fee)
//
// So the recipient bears the fee, and the two directions want DIFFERENT
// numbers from the same row:
//
//   SENT     (merchant) → GROSS. Debited exactly `amount`. Correct as-is.
//   RECEIVED (farmer)   → NET.   Credited `amount - fee`.
//
// This is deliberately NOT a blanket subtraction. Subtracting the fee from
// a sent row would understate what the merchant actually paid out.
//
// ─── PRECISION ────────────────────────────────────────────────────────
//
// USDC has 6 decimals; the API's `*_human` fields are TRUNCATED to 2. A
// truncated triple does not reconcile: at 25bps on 45001.00 USDC the three
// figures render 45001.00 / 112.50 / 44888.49, and the displayed
// subtraction gives 44888.50 — a cent off the net row. Fractional-cent
// fees are the common case, not an edge case.
//
// So: headline at 2dp (scannability, one number, nothing to cross-check),
// detail pane at full 6dp (the reconciliation surface, where the three
// figures must actually add up against BaseScan).

import { USDC_DECIMALS, formatUsdc } from "./contract";
import type { SettlementRow } from "./client";

/**
 * Full 6-decimal rendering — no truncation, trailing zeros kept so a
 * column of these stays aligned. Use on surfaces where gross, fee and net
 * appear together and must reconcile.
 */
export function formatUsdcFull(units: bigint): string {
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = units / divisor;
  const frac = units % divisor;
  return `${whole.toString()}.${frac.toString().padStart(USDC_DECIMALS, "0")}`;
}

/**
 * Net credited to the recipient, in base units.
 *
 * Prefers the API-derived `net_units_raw` (the field of record). Falls
 * back to gross - fee for an API container that predates it — see the
 * field comment in client.ts for why that skew is reachable. The fallback
 * is exact, not an approximation: the contract computes the same integer.
 */
export function netUnits(row: SettlementRow): bigint {
  if (row.net_units_raw != null && row.net_units_raw !== "") {
    return BigInt(row.net_units_raw);
  }
  return BigInt(row.amount_units_raw) - BigInt(row.fee_units_raw);
}

/**
 * The row's headline amount, at 2dp: what this settlement meant for the
 * viewing member. Gross when they sent it, net when they received it.
 */
export function viewerHeadlineAmount(row: SettlementRow): string {
  return row.direction === "sent"
    ? row.amount_human
    : formatUsdc(netUnits(row));
}

/**
 * The detail pane's figures at full precision, so gross - fee = net holds
 * on screen. `net` is only meaningful for a received row; a sent row shows
 * gross + fee and no net (the sender paid the gross, of which the fee was
 * a part).
 */
export function viewerDetailAmounts(row: SettlementRow): {
  gross: string;
  fee: string;
  net: string;
} {
  return {
    gross: formatUsdcFull(BigInt(row.amount_units_raw)),
    fee: formatUsdcFull(BigInt(row.fee_units_raw)),
    net: formatUsdcFull(netUnits(row)),
  };
}
