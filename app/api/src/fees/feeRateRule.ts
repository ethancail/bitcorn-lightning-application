// fee-estimates — the route-level fee_rate rule (spec §9, O5, P16; F1, F4, D1, D4).
//
// The confirmation gate (utils/action-confirmation.ts) runs first and refuses
// what it can: on a route where fee_rate is REQUIRED in the table (member open)
// it refuses absent and null; on every route it refuses non-numeric values
// ("abc"), because its Number() is not finite. It lets through anything
// Number() accepts — 0, -1, 1.5, true, "5", 201 — so this rule refuses those.
// Where the table marks fee_rate OPTIONAL (expansion, D4; close, D1) absent and
// null also reach the route, and this rule refuses them unless the request is
// a dry_run preview (which sends nothing to LND) or, on close, a force close.

import { FEE_RATE_CEILING_SAT_PER_VBYTE } from "./feeEstimates";

/** required: must be present. optional: validated if present. forbidden: must be absent. */
export type FeeRateRequirement = "required" | "optional" | "forbidden";

export type FeeRateCheck =
  | { ok: true; rate: number | undefined }
  | { ok: false; error: string; detail: string };

export function checkFeeRate(raw: unknown, requirement: FeeRateRequirement): FeeRateCheck {
  const absent = raw === undefined || raw === null;

  if (requirement === "forbidden") {
    return absent
      ? { ok: true, rate: undefined }
      : {
          ok: false,
          error: "fee_rate_not_allowed",
          detail: "A force close uses the fee already set in the commitment transaction; send no fee_rate.",
        };
  }

  if (absent) {
    return requirement === "required"
      ? { ok: false, error: "fee_rate_required", detail: "fee_rate (sat/vB) is required." }
      : { ok: true, rate: undefined };
  }

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return {
      ok: false,
      error: "invalid_fee_rate",
      detail: "fee_rate must be a positive whole number of sat/vB, sent as a JSON number.",
    };
  }

  if (raw > FEE_RATE_CEILING_SAT_PER_VBYTE) {
    return {
      ok: false,
      error: "fee_rate_above_ceiling",
      detail: `fee_rate ${raw} sat/vB is above the ${FEE_RATE_CEILING_SAT_PER_VBYTE} sat/vB ceiling.`,
    };
  }

  return { ok: true, rate: raw };
}
