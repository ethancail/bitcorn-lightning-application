// Refusals before initiation on the member/admin swap path (sites A, B, D).
//
// loop-fee-ceilings spec §4: "Each refusal is a distinct error code and
// happens before initiation." A SwapRefusalError is thrown only BEFORE any
// money-moving loopd call, so the swap request is left as it was (not marked
// failed) and the caller can requote. The route handlers turn it into a 409
// carrying `error: <code>`.

export type SwapRefusalCode =
  /** The stored quote predates the quote-component columns (spec §5, D8). */
  | "requote_required";

export class SwapRefusalError extends Error {
  readonly code: SwapRefusalCode;
  constructor(code: SwapRefusalCode, message: string) {
    super(message);
    this.name = "SwapRefusalError";
    this.code = code;
  }
}
