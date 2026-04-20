export type Zone =
  | "extreme_buy"
  | "undervalued"
  | "fair_value"
  | "elevated"
  | "overvalued"
  | "extreme_sell";

export interface ZoneClassification {
  zone: Zone;
  multiplier: number;
}

// Boundaries lock the spec's §4.2 zone mapping.
// On boundaries (exact values): lower-side of the next zone wins per spec table:
//   Extreme Buy:   Z < -2
//   Undervalued:  -2 ≤ Z < -1
//   Fair Value:   -1 ≤ Z < 1
//   Elevated:      1 ≤ Z < 1.5
//   Overvalued:   1.5 ≤ Z < 2.5
//   Extreme Sell:  Z ≥ 2.5
export function classifyZone(z: number): ZoneClassification {
  if (!Number.isFinite(z)) return { zone: "extreme_sell", multiplier: 0 };
  if (z < -2.0)  return { zone: "extreme_buy",  multiplier: 3.0 };
  if (z < -1.0)  return { zone: "undervalued",  multiplier: 2.0 };
  if (z <  1.0)  return { zone: "fair_value",   multiplier: 1.0 };
  if (z <  1.5)  return { zone: "elevated",     multiplier: 0.5 };
  if (z <  2.5)  return { zone: "overvalued",   multiplier: 0.25 };
  return { zone: "extreme_sell", multiplier: 0 };
}
