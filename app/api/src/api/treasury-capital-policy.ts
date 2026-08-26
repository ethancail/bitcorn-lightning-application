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
// ⚠ ZERO IS LEGAL ON SIX FIELDS AND REJECTED ON TWO, AND THE SPLIT IS THE WHOLE
// POINT. On the six, a zero HALTS the thing it governs — no pending opens, no
// expansions per day, no fee budget. That is a freeze, the safest setting the
// field has, and a real operator choice; rejecting it would remove the only kill
// switch reachable from the UI.
//
// On `min_onchain_reserve_sats` and `peer_cooldown_minutes` a zero does the
// OPPOSITE — it turns the protection OFF. Zero reserve is no reserve requirement
// at all. Zero cooldown is no wait between opens to the same peer, and
// assertCanExpand guards that entire check behind `peer_cooldown_minutes > 0`
// (utils/capital-guardrails.ts), so a stored zero does not shorten the cooldown,
// it SKIPS it. A uniform floor of 0 across all eight looks consistent and is
// exactly wrong on these two, which is why they carry `zeroDisablesProtection`
// below rather than a different `min`.
//
// ⚠ NO POSITIVE FLOOR IS BEING SET HERE. The rule is "not zero" and nothing
// more: 1 is legal on both. Choosing a real minimum reserve or a real minimum
// cooldown is a separate decision and is deliberately still open — encoding a
// guess as a `min` would settle it silently.
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

export type CapitalPolicyBound = {
  min: number;
  max: number;
  /**
   * Present ONLY on fields where zero disables the protection rather than
   * freezing it. Exactly 0 is refused; every other value in [min, max] stays
   * legal, so 1 is permitted. This is the whole special case, declared on the
   * two entries it applies to instead of branching in the validator — the table
   * stays the one readable answer to "what does this field permit".
   */
  zeroDisablesProtection?: true;
};

export const CAPITAL_POLICY_BOUNDS: Record<string, CapitalPolicyBound> & {
  readonly [K in
    | "min_onchain_reserve_sats"
    | "max_deploy_ratio_ppm"
    | "max_pending_opens"
    | "max_peer_capacity_sats"
    | "peer_cooldown_minutes"
    | "max_expansions_per_day"
    | "max_daily_deploy_sats"
    | "max_daily_loss_sats"]: CapitalPolicyBound;
} = {
  // ── REJECTS ZERO: zero turns the protection off, it does not freeze it.
  /** Zero = no reserve requirement at all. Ceiling = 1 BTC. No positive floor is set. */
  min_onchain_reserve_sats: { min: 0, max: 100_000_000, zeroDisablesProtection: true },
  /** Zero = no wait between opens to the same peer — assertCanExpand SKIPS the check. 30 days. */
  peer_cooldown_minutes: { min: 0, max: 43_200, zeroDisablesProtection: true },

  // ── ZERO IS A FREEZE: the safest setting each of these has.
  /** DERIVED, not chosen: ppm, so 1_000_000 = 100%. Above it the ratio check cannot bind. */
  max_deploy_ratio_ppm: { min: 0, max: 1_000_000 },
  /** Concurrent funding transactions in flight. 100 is far past any real treasury. */
  max_pending_opens: { min: 0, max: 100 },
  /** A peer may hold several channels, so LND's per-channel max is not the bound. 1 BTC. */
  max_peer_capacity_sats: { min: 0, max: 100_000_000 },
  /** Channel opens per rolling 24h. */
  max_expansions_per_day: { min: 0, max: 100 },
  /** Total capacity deployed per rolling 24h. 1 BTC. */
  max_daily_deploy_sats: { min: 0, max: 100_000_000 },
  /** REBALANCE FEES per rolling 24h — not capital, spend. 0.01 BTC is already far past sane. */
  max_daily_loss_sats: { min: 0, max: 1_000_000 },
};

export type CapitalPolicyField = keyof CapitalPolicyPatch;

/**
 * Why a capital policy write was refused.
 *
 * ⚠ THIS EXISTS BECAUSE `min` ALONE CANNOT DESCRIBE THE PERMITTED SET. Both
 * zero-rejecting fields have `min: 0`, so a payload carrying only {min, max}
 * would tell the operator the range is 0–43200 and then refuse 43200's
 * neighbour at the bottom — a payload that reports `min: 0` while rejecting 0 is
 * a lie. The permitted set is `[min, max]` MINUS `{0}` when `zeroPermitted` is
 * false, and both halves travel so a caller never has to infer the second.
 */
export type CapitalPolicyRejectionReason = "out_of_range" | "zero_disables_protection";

/**
 * Thrown when a capital policy write is refused.
 *
 * Carries the field, both bounds, the reason and whether zero is permitted as
 * DATA rather than only in the message, so the route can surface a structured
 * 400 without parsing prose.
 */
export class CapitalPolicyValidationError extends Error {
  readonly field: CapitalPolicyField;
  readonly value: unknown;
  readonly min: number;
  readonly max: number;
  readonly reason: CapitalPolicyRejectionReason;
  /** False on the two fields where zero disables the protection. */
  readonly zeroPermitted: boolean;

  constructor(
    field: CapitalPolicyField,
    value: unknown,
    bound: CapitalPolicyBound,
    reason: CapitalPolicyRejectionReason,
  ) {
    const zeroPermitted = bound.zeroDisablesProtection !== true;
    super(
      reason === "zero_disables_protection"
        ? `Invalid ${field}: zero is not permitted — it disables the protection rather than ` +
            `tightening it. Any value from 1 to ${bound.max} is accepted. Nothing was written.`
        : `Invalid ${field}: ${String(value)} is outside the permitted range ${bound.min}–${bound.max}` +
            `${zeroPermitted ? "" : " (excluding zero)"}. Nothing was written.`,
    );
    this.name = "CapitalPolicyValidationError";
    this.field = field;
    this.value = value;
    this.min = bound.min;
    this.max = bound.max;
    this.reason = reason;
    this.zeroPermitted = zeroPermitted;
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

    const bound = CAPITAL_POLICY_BOUNDS[field];
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new CapitalPolicyValidationError(field, value, bound, "out_of_range");
    }
    if (value < bound.min || value > bound.max) {
      throw new CapitalPolicyValidationError(field, value, bound, "out_of_range");
    }
    // The one special case, and it reads off the table rather than naming
    // fields here — adding or removing a zero-rejecting field is an edit to
    // CAPITAL_POLICY_BOUNDS alone.
    if (value === 0 && bound.zeroDisablesProtection) {
      throw new CapitalPolicyValidationError(field, value, bound, "zero_disables_protection");
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
