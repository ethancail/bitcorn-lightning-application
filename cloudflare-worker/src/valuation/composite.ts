// Spec §4.1 weights — exactly as specified in the mockup (sum ≈ 1.01 due to rounding;
// composite() renormalises on every call).
export const INPUT_WEIGHTS: Record<string, number> = {
  mvrv:               0.18,
  puell:              0.10,
  sopr:               0.08,
  reserve_risk:       0.07,
  stock_to_flow:      0.12,
  ma_200w:            0.10,
  pi_cycle:           0.07,
  nvt:                0.08,
  hash_ribbons:       0.06,
  difficulty_ribbon:  0.05,
  miner_outflows:     0.04,
  hodl_waves:         0.06,
};

export function composite(
  readings: Record<string, number>,
  weights: Record<string, number> = INPUT_WEIGHTS,
): number {
  let weightSum = 0;
  let weightedZSum = 0;

  for (const [key, w] of Object.entries(weights)) {
    const z = readings[key];
    if (z === undefined || !Number.isFinite(z)) continue;
    weightSum += w;
    weightedZSum += w * z;
  }

  if (weightSum === 0) {
    throw new Error("composite: no inputs usable (weightSum=0)");
  }

  return weightedZSum / weightSum;
}
