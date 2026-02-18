import { db } from "../db";

export type TreasuryCapitalPolicy = {
  id: 1;
  min_onchain_reserve_sats: number;
  max_deploy_ratio_ppm: number;
  max_pending_opens: number;
  max_peer_capacity_sats: number;
  peer_cooldown_minutes: number;
  max_expansions_per_day: number;
  max_daily_deploy_sats: number;
  /** Maximum rebalance fees that can be spent in a 24h window before automation halts. */
  max_daily_loss_sats: number;
  updated_at: number;
  last_applied_at: number | null;
};

export function getCapitalPolicy(): TreasuryCapitalPolicy {
  const row = db
    .prepare(
      `SELECT id, min_onchain_reserve_sats, max_deploy_ratio_ppm, max_pending_opens,
              max_peer_capacity_sats, peer_cooldown_minutes, max_expansions_per_day,
              max_daily_deploy_sats, max_daily_loss_sats, updated_at, last_applied_at
       FROM treasury_capital_policy
       WHERE id = 1`
    )
    .get();

  if (!row) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO treasury_capital_policy (
         id, min_onchain_reserve_sats, max_deploy_ratio_ppm, max_pending_opens,
         max_peer_capacity_sats, peer_cooldown_minutes, max_expansions_per_day,
         max_daily_deploy_sats, max_daily_loss_sats, updated_at, last_applied_at
       ) VALUES (1, 300000, 600000, 1, 300000, 720, 3, 400000, 5000, ?, NULL)`
    ).run(now);

    return {
      id: 1,
      min_onchain_reserve_sats: 300000,
      max_deploy_ratio_ppm: 600000,
      max_pending_opens: 1,
      max_peer_capacity_sats: 300000,
      peer_cooldown_minutes: 720,
      max_expansions_per_day: 3,
      max_daily_deploy_sats: 400000,
      max_daily_loss_sats: 5000,
      updated_at: now,
      last_applied_at: null,
    };
  }

  return row as TreasuryCapitalPolicy;
}

export function setCapitalPolicy(policy: {
  min_onchain_reserve_sats?: number;
  max_deploy_ratio_ppm?: number;
  max_pending_opens?: number;
  max_peer_capacity_sats?: number;
  peer_cooldown_minutes?: number;
  max_expansions_per_day?: number;
  max_daily_deploy_sats?: number;
  max_daily_loss_sats?: number;
}): TreasuryCapitalPolicy {
  const now = Date.now();
  const current = getCapitalPolicy();

  db.prepare(
    `UPDATE treasury_capital_policy SET
       min_onchain_reserve_sats = ?,
       max_deploy_ratio_ppm = ?,
       max_pending_opens = ?,
       max_peer_capacity_sats = ?,
       peer_cooldown_minutes = ?,
       max_expansions_per_day = ?,
       max_daily_deploy_sats = ?,
       max_daily_loss_sats = ?,
       updated_at = ?
     WHERE id = 1`
  ).run(
    policy.min_onchain_reserve_sats ?? current.min_onchain_reserve_sats,
    policy.max_deploy_ratio_ppm ?? current.max_deploy_ratio_ppm,
    policy.max_pending_opens ?? current.max_pending_opens,
    policy.max_peer_capacity_sats ?? current.max_peer_capacity_sats,
    policy.peer_cooldown_minutes ?? current.peer_cooldown_minutes,
    policy.max_expansions_per_day ?? current.max_expansions_per_day,
    policy.max_daily_deploy_sats ?? current.max_daily_deploy_sats,
    policy.max_daily_loss_sats ?? current.max_daily_loss_sats,
    now
  );

  return getCapitalPolicy();
}

export function markCapitalPolicyApplied(): TreasuryCapitalPolicy {
  const now = Date.now();
  db.prepare(
    `UPDATE treasury_capital_policy SET last_applied_at = ? WHERE id = 1`
  ).run(now);
  return getCapitalPolicy();
}
