import { db } from "../db";

export type TreasuryFeePolicy = {
  id: 1;
  base_fee_msat: number;
  fee_rate_ppm: number;
  updated_at: number;
  last_applied_at: number | null;
};

export function getTreasuryFeePolicy(): TreasuryFeePolicy {
  const row = db
    .prepare(
      `SELECT id, base_fee_msat, fee_rate_ppm, updated_at, last_applied_at
       FROM treasury_fee_policy
       WHERE id = 1`
    )
    .get();

  if (!row) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO treasury_fee_policy (id, base_fee_msat, fee_rate_ppm, updated_at, last_applied_at)
       VALUES (1, 0, 0, ?, NULL)`
    ).run(now);

    return {
      id: 1,
      base_fee_msat: 0,
      fee_rate_ppm: 0,
      updated_at: now,
      last_applied_at: null,
    };
  }

  return row as TreasuryFeePolicy;
}

export function setTreasuryFeePolicy(
  base_fee_msat: number,
  fee_rate_ppm: number
): TreasuryFeePolicy {
  const now = Date.now();

  db.prepare(
    `UPDATE treasury_fee_policy
     SET base_fee_msat = ?, fee_rate_ppm = ?, updated_at = ?
     WHERE id = 1`
  ).run(base_fee_msat, fee_rate_ppm, now);

  return getTreasuryFeePolicy();
}

export function markTreasuryFeePolicyApplied(): TreasuryFeePolicy {
  const now = Date.now();
  db.prepare(
    `UPDATE treasury_fee_policy
     SET last_applied_at = ?
     WHERE id = 1`
  ).run(now);

  return getTreasuryFeePolicy();
}
