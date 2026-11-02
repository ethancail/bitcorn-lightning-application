// Refusals before initiation on the member/admin swap path (sites A, B, D).
//
// loop-fee-ceilings spec §4: "Each refusal is a distinct error code and
// happens before initiation." A SwapRefusalError is thrown only BEFORE any
// money-moving loopd call, so the swap request is left as it was (not marked
// failed) and the caller can requote. The route handlers turn it into a 409
// carrying `error: <code>`.

export type SwapRefusalCode =
  /** The stored quote predates the quote-component columns (spec §5, D8). */
  | "requote_required"
  /** A probed route for the swap or the prepay costs more than the routing
   *  cap (spec §4, F2, D2). */
  | "route_fee_over_cap"
  /** Neither the quote's swap_payment_dest nor any configured Loop server
   *  routes (spec §4, item B, D21). */
  | "route_not_found"
  /** A fresh miner-fee estimate exceeds the quoted one plus the margin
   *  (spec §4, F3, D3). */
  | "fee_rate_over_quote"
  /** Loop In: the HTLC-fee estimate failed or is zero, so the on-chain fee is
   *  unknown. Refused at quote and before initiation; 0 is never shown as the
   *  fee (spec §4 D, Ruling Z, D12). */
  | "miner_fee_unknown"
  /** The ceilings echoed in the execute body differ from the stored quote's
   *  (spec §6, F4). */
  | "ceiling_mismatch"
  /** Another execute of the same quote holds the claim (the row is
   *  'initiating'); this one never reaches loopd. */
  | "swap_in_progress"
  /** The quote is in any other non-executable status (initiated, expired,
   *  failed, completed, …): already used or ended (ruling g). */
  | "swap_not_executable";

export class SwapRefusalError extends Error {
  readonly code: SwapRefusalCode;
  constructor(code: SwapRefusalCode, message: string) {
    super(message);
    this.name = "SwapRefusalError";
    this.code = code;
  }
}
