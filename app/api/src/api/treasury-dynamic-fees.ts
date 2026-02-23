import { db } from "../db";
import { getLiquidityHealth, HealthClassification } from "./treasury-liquidity-health";
import { getTreasuryFeePolicy } from "./treasury-fee-policy";

export type ChannelFeeAdjustment = {
  channel_id: string;
  peer_pubkey: string;
  health_classification: HealthClassification;
  imbalance_ratio: number;
  base_fee_rate_ppm: number;
  target_fee_rate_ppm: number;
  /** Multiplier applied to base rate. */
  adjustment_factor: number;
};

/**
 * Fee multipliers by liquidity health classification.
 *
 * Liquidity pricing model: price high when outbound is scarce, price low when
 * outbound is abundant. This encourages traffic to naturally rebalance channels:
 * - outbound_starved: expensive → rations remaining capacity
 * - critical: cheap → attracts outbound routing to drain excess local balance
 */
const FEE_MULTIPLIERS: Record<HealthClassification, number> = {
  outbound_starved: 4.0,
  weak:             2.0,
  healthy:          1.0,
  inbound_heavy:    0.6,
  critical:         0.25,
};

const MIN_FEE_PPM = 1;
const MAX_FEE_PPM = 10_000;

/**
 * Computes target fee rates for all active channels based on liquidity health.
 * Uses the global treasury fee policy as the base rate.
 *
 * Requires fee_rate_ppm > 0 in the treasury fee policy — throws if not configured.
 */
export function computeDynamicFeeAdjustments(): ChannelFeeAdjustment[] {
  const policy = getTreasuryFeePolicy();

  if (policy.fee_rate_ppm <= 0) {
    throw new Error(
      "Base fee_rate_ppm is not configured. Set a fee policy via POST /api/treasury/fee-policy before applying dynamic fees."
    );
  }

  const basePpm = policy.fee_rate_ppm;
  const health = getLiquidityHealth();

  return health
    .filter(c => c.is_active)
    .map(c => {
      const multiplier = FEE_MULTIPLIERS[c.health_classification];
      const raw = Math.round(basePpm * multiplier);
      const target = Math.min(MAX_FEE_PPM, Math.max(MIN_FEE_PPM, raw));

      return {
        channel_id: c.channel_id,
        peer_pubkey: c.peer_pubkey,
        health_classification: c.health_classification,
        imbalance_ratio: c.imbalance_ratio,
        base_fee_rate_ppm: basePpm,
        target_fee_rate_ppm: target,
        adjustment_factor: multiplier,
      };
    });
}

/**
 * Writes applied fee adjustments to the audit log.
 */
export function logChannelFeeAdjustments(adjustments: ChannelFeeAdjustment[]): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO treasury_channel_fee_log
    (channel_id, peer_pubkey, health_classification, imbalance_ratio,
     base_fee_rate_ppm, target_fee_rate_ppm, adjustment_factor, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const adj of adjustments) {
    stmt.run(
      adj.channel_id,
      adj.peer_pubkey,
      adj.health_classification,
      adj.imbalance_ratio,
      adj.base_fee_rate_ppm,
      adj.target_fee_rate_ppm,
      adj.adjustment_factor,
      now
    );
  }
}
