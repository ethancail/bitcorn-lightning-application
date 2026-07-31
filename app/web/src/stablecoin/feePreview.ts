// The settlement form's fee preview, as data.
//
// Pure + dependency-light so it unit-tests without a DOM or a React renderer —
// same pattern as settlementAmounts.ts / revertClassifier.ts (and
// app/web/vitest.config.ts only collects `*.test.ts`, not `.tsx`).
//
// ─── WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// The form used to compute its preview from `contractState?.current_fee_bps ?? 0`
// and hand the result straight to FeeDisplay, which rendered
// "Fee Preview: 0.00 USDC (0.0% current rate)".
//
// The bug is that 0 means two different things there:
//   - a genuine on-chain rate of 0 bps (what the contract shipped with), and
//   - "we have no contract state, so we don't know the rate"
// and the UI stated the second as confidently as the first. With the launch rate
// at 25 bps, that is the UI telling a member settlements are FREE at the exact
// moment it has no idea what they cost — the same class of defect as the
// gross/net settlement-row bug: a false statement about money on screen.
//
// The fix is representational, not cosmetic: `feePreviewUnits` returns `null` for
// unknown, so "unknown" cannot be confused with "zero" by any caller. A render
// gate alone would leave the ambiguity in the value and rely on every future
// caller remembering to check.

import type { ContractStateResponse } from "./client";
import { parseUsdcAmount } from "./contract";

/**
 * Whether a fee rate can be truthfully displayed at all.
 *
 * Keyed on the PRESENCE of contract state, never on the rate being nonzero — a
 * cached 0 bps is knowledge, and an absent cache is not.
 */
export function isFeeRateKnown(
  contractState: ContractStateResponse | null,
): boolean {
  return contractState != null;
}

/**
 * Fee in USDC base units for the previewed amount, or `null` when it cannot be
 * known.
 *
 * `null` is returned when the contract state is missing (rate unknown) OR the
 * amount doesn't parse (nothing to apply a rate to). Both are genuinely
 * "no number to show" — distinct from 0n, which is a real fee of zero and must
 * stay distinguishable.
 */
export function feePreviewUnits(
  contractState: ContractStateResponse | null,
  amountHuman: string,
): bigint | null {
  if (!isFeeRateKnown(contractState)) return null;
  const units = parseUsdcAmount(amountHuman);
  if (units === null) return null;
  const bps = contractState!.current_fee_bps;
  // Mirrors SettlementRouter.sol:247 `fee = amount * feeBps / 10_000`, in
  // integer base units so the preview matches what the contract will charge.
  return (units * BigInt(bps)) / 10_000n;
}
