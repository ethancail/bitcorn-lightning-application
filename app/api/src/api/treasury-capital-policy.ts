import { db } from "../db";

// ═══════════════════════════════════════════════════════════════════════════
// RANGE BOUNDS
//
// These eight numbers are the limits that bind assertCanExpand() and
// assertDailyLossCapNotExceeded() — the only two permit/refuse consumers of
// capital policy in the app. Writing them was previously unchecked, so a policy
// write could DISABLE the guardrails rather than configure them.
//
// ⚠ THE SAFE DIRECTION IS NOT THE SAME FOR EVERY FIELD. Seven of the eight
// loosen as they RISE: a bigger per-peer cap, a bigger daily budget, a longer
// ceiling all permit more. `min_onchain_reserve_sats` is inverted — it loosens
// as it FALLS, and a negative value removes the reserve floor entirely. So the
// bound that carries the safety weight is the CEILING on seven fields and the
// FLOOR on one. Both ends are enforced on all eight regardless, because the
// non-safety end is still a fat-finger guard.
//
// ⚠ ZERO IS DELIBERATELY LEGAL EVERYWHERE. On every field except the reserve, a
// zero HALTS the thing it governs — no pending opens, no expansions per day, no
// fee budget. That is a freeze, which is the safe direction, and it is a real
// operator choice. Rejecting it would be this validator inventing a policy
// nobody asked for, and would remove the only kill switch reachable from the UI.
//
// ⚠ ONLY ONE CEILING IS DERIVED RATHER THAN CHOSEN. max_deploy_ratio_ppm is
// parts-per-million, and assertCanExpand computes `totalCapital * ppm / 1e6`, so
// 1_000_000 IS 100% and nothing above it can bind — that ceiling is arithmetic,
// not judgement. The other seven are fat-finger guards set well clear of the
// shipped defaults, and they are OPEN TO REVISION: they are gathered here, named
// and exported, precisely so changing one is a single reviewable edit rather
// than a hunt through a validator body.
//
// The shipped defaults (see the INSERT in getCapitalPolicy below) sit inside
// every range. Two sit close to their FLOOR — max_pending_opens at 1 and
// max_expansions_per_day at 3, against a floor of 0 — which is benign because
// that floor is the freeze value rather than a dangerous one.
// ═══════════════════════════════════════════════════════════════════════════

export const CAPITAL_POLICY_BOUNDS = {
  /** Floor carries the safety weight here: negative removes the reserve. Ceiling = 1 BTC. */
  min_onchain_reserve_sats: { min: 0, max: 100_000_000 },
  /** DERIVED, not chosen: ppm, so 1_000_000 = 100%. Above it the ratio check cannot bind. */
  max_deploy_ratio_ppm: { min: 0, max: 1_000_000 },
  /** Concurrent funding transactions in flight. 100 is far past any real treasury. */
  max_pending_opens: { min: 0, max: 100 },
  /** A peer may hold several channels, so LND's per-channel max is not the bound. 1 BTC. */
  max_peer_capacity_sats: { min: 0, max: 100_000_000 },
  /** 30 days. Zero disables the cooldown, which assertCanExpand tests for explicitly. */
  peer_cooldown_minutes: { min: 0, max: 43_200 },
  /** Channel opens per rolling 24h. */
  max_expansions_per_day: { min: 0, max: 100 },
  /** Total capacity deployed per rolling 24h. 1 BTC. */
  max_daily_deploy_sats: { min: 0, max: 100_000_000 },
  /** REBALANCE FEES per rolling 24h — not capital, spend. 0.01 BTC is already far past sane. */
  max_daily_loss_sats: { min: 0, max: 1_000_000 },
} as const;

export type CapitalPolicyField = keyof typeof CAPITAL_POLICY_BOUNDS;

/**
 * Thrown when a capital policy write is out of range.
 *
 * Carries the field and both bounds as data rather than only in the message, so
 * the route can surface a structured 400 without parsing prose.
 */
export class CapitalPolicyValidationError extends Error {
  readonly field: CapitalPolicyField;
  readonly value: unknown;
  readonly min: number;
  readonly max: number;

  constructor(field: CapitalPolicyField, value: unknown, min: number, max: number) {
    super(
      `Invalid ${field}: ${String(value)} is outside the permitted range ${min}–${max}. ` +
        `Nothing was written.`,
    );
    this.name = "CapitalPolicyValidationError";
    this.field = field;
    this.value = value;
    this.min = min;
    this.max = max;
  }
}

/**
 * Validate a patch against CAPITAL_POLICY_BOUNDS. Throws on the FIRST offending
 * field; returns silently when every supplied field is in range.
 *
 * ⚠ REJECTS, DOES NOT CLAMP. A silent clamp would store a value the operator did
 * not ask for and report success, so the policy in the database and the policy
 * in their head would differ with nothing said. On a surface whose whole job is
 * bounding capital, that is the worse failure.
 *
 * ⚠ FINITE-INTEGER CHECK COMES FIRST, AND IT IS LOAD-BEARING. The route builds
 * each value with `Number(parsed.x)`, so a malformed body arrives as NaN — and
 * `NaN < min` and `NaN > max` are BOTH false, so a bare range comparison ACCEPTS
 * NaN. Every field is a count, a sat amount, or a minute count, so non-integers
 * are refused in the same step.
 *
 * Absent fields are skipped, not defaulted: the route sends `undefined` for
 * every field the operator left alone, so an all-undefined patch is an ordinary
 * request and must stay legal.
 */
export function validateCapitalPolicyPatch(patch: CapitalPolicyPatch): void {
  for (const field of Object.keys(CAPITAL_POLICY_BOUNDS) as CapitalPolicyField[]) {
    const value = patch[field];
    if (value === undefined || value === null) continue;

    const { min, max } = CAPITAL_POLICY_BOUNDS[field];
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new CapitalPolicyValidationError(field, value, min, max);
    }
    if (value < min || value > max) {
      throw new CapitalPolicyValidationError(field, value, min, max);
    }
  }
}

export type CapitalPolicyPatch = {
  min_onchain_reserve_sats?: number;
  max_deploy_ratio_ppm?: number;
  max_pending_opens?: number;
  max_peer_capacity_sats?: number;
  peer_cooldown_minutes?: number;
  max_expansions_per_day?: number;
  max_daily_deploy_sats?: number;
  max_daily_loss_sats?: number;
};

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

export function setCapitalPolicy(policy: CapitalPolicyPatch): TreasuryCapitalPolicy {
  // ⚠ VALIDATE BEFORE READING CURRENT STATE, AND BEFORE THE UPDATE. Throwing
  // here means a patch with one bad field applies NONE of its fields — the
  // alternative would leave the operator holding a policy they never asked for
  // alongside an error saying the write did not happen.
  validateCapitalPolicyPatch(policy);

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
