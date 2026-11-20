// Test-only: a GET /api/fee-estimates answer built from three rates, so each
// card's expected text is derived from the stub, never typed as a literal
// (fee-estimates spec §13, H1). Sizes and times are the API's ruled ones
// (P14: 155 / 192 vB; P12: the rounded ranges).

import type { FeeEstimates, FeeOptionKey } from "../../api/client";

export const SIZES = { open: 155, close: 192 } as const;
const TIMES: Record<FeeOptionKey, { min: number; max: number }> = {
  priority: { min: 1, max: 25 },
  normal: { min: 10, max: 55 },
  economy: { min: 30, max: 95 },
};
const BLOCK: Record<FeeOptionKey, number> = { priority: 1, normal: 3, economy: 6 };
const TARGET: Record<FeeOptionKey, number> = { priority: 2, normal: 3, economy: 6 };

export function feeEstimatesStub(
  rates: Record<FeeOptionKey, number>,
  opts: { source?: "worker" | "lnd"; dataAgeSeconds?: number } = {},
): FeeEstimates {
  const source = opts.source ?? "worker";
  const option = (key: FeeOptionKey) => ({
    key,
    rate: rates[key],
    block: source === "worker" ? BLOCK[key] : null,
    target: source === "lnd" ? TARGET[key] : null,
    time_minutes: TIMES[key],
    estimate: source === "lnd",
    cost_sats: { open: rates[key] * SIZES.open, close: rates[key] * SIZES.close },
  });
  return {
    source,
    worker_source: source === "worker" ? "cache" : null,
    data_fetched_at: "2026-11-18T12:00:00.000Z",
    data_age_seconds: opts.dataAgeSeconds ?? 60,
    unavailable_reason: null,
    ceiling_sat_per_vbyte: 200,
    sizes_vb: SIZES,
    options: { economy: option("economy"), normal: option("normal"), priority: option("priority") },
  };
}

export const UNAVAILABLE: FeeEstimates = {
  source: "unavailable",
  worker_source: "none",
  data_fetched_at: null,
  data_age_seconds: null,
  unavailable_reason: "lnd_flat_25",
  ceiling_sat_per_vbyte: 200,
  sizes_vb: SIZES,
  options: null,
};
