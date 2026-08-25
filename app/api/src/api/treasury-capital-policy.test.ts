// Range validation for the treasury capital policy write path.
//
// ⚠ WHY THIS FILE EXISTS. treasury_capital_policy holds the eight limits that
// bind assertCanExpand() and assertDailyLossCapNotExceeded() — the only two
// permit/refuse consumers of capital policy in the app. Before this suite,
// setCapitalPolicy() wrote every field as `patch ?? current` straight into the
// UPDATE with no range check, so `min_onchain_reserve_sats: -1` removed the
// reserve floor and `max_deploy_ratio_ppm: 99_000_000` made the deploy-ratio
// check unable to bind. The route returned 200 either way.
//
// ─── THE PAIR THAT MATTERS ──────────────────────────────────────────────────
//
// A validator is only half-proven by showing it refuses. The other half — that
// it still PERMITS the shipped defaults and a realistic operator adjustment — is
// the half that keeps this from becoming a self-inflicted outage on a treasury
// that is operated by hand. Both halves are below, and the permit half was
// written to pass on the UNMODIFIED code so it could not be tuned to the
// validator afterwards.
//
// Ordering, recorded because it is the evidence: the refuse block was run
// against unmodified setCapitalPolicy() FIRST and went red for the right reason
// — the out-of-range value was written and returned, not rejected. The permit
// block was green at that same moment. Raw output is in the commit message.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Controllable db stand-in ───────────────────────────────────────────────
// setCapitalPolicy() reads current state through getCapitalPolicy() and then
// runs one UPDATE. The stand-in records every run() so a test can assert that a
// REJECTED patch performed no write at all — "the stored value is unchanged on
// read-back", expressed at the layer that would do the writing.

const s = vi.hoisted(() => ({
  row: {
    id: 1,
    min_onchain_reserve_sats: 300_000,
    max_deploy_ratio_ppm: 600_000,
    max_pending_opens: 1,
    max_peer_capacity_sats: 300_000,
    peer_cooldown_minutes: 720,
    max_expansions_per_day: 3,
    max_daily_deploy_sats: 400_000,
    max_daily_loss_sats: 5_000,
    updated_at: 1_700_000_000_000,
    last_applied_at: null as number | null,
  },
  /** Every db.prepare(...).run(...) argument list, in order. */
  writes: [] as unknown[][],
}));

vi.mock("../db", () => ({
  db: {
    prepare: (sql: string) => ({
      get: () => s.row,
      all: () => [],
      run: (...args: unknown[]) => {
        s.writes.push(args);
        // Mirror the real UPDATE so a permitted write is observable on read-back
        // through the same getCapitalPolicy() the production code returns.
        if (sql.includes("UPDATE treasury_capital_policy SET") && sql.includes("min_onchain_reserve_sats")) {
          const [
            min_onchain_reserve_sats,
            max_deploy_ratio_ppm,
            max_pending_opens,
            max_peer_capacity_sats,
            peer_cooldown_minutes,
            max_expansions_per_day,
            max_daily_deploy_sats,
            max_daily_loss_sats,
            updated_at,
          ] = args as number[];
          Object.assign(s.row, {
            min_onchain_reserve_sats,
            max_deploy_ratio_ppm,
            max_pending_opens,
            max_peer_capacity_sats,
            peer_cooldown_minutes,
            max_expansions_per_day,
            max_daily_deploy_sats,
            max_daily_loss_sats,
            updated_at,
          });
        }
        return undefined;
      },
    }),
  },
}));

import { setCapitalPolicy } from "./treasury-capital-policy";

/** The shipped defaults, from treasury-capital-policy.ts's own INSERT. */
const SHIPPED_DEFAULTS = {
  min_onchain_reserve_sats: 300_000,
  max_deploy_ratio_ppm: 600_000,
  max_pending_opens: 1,
  max_peer_capacity_sats: 300_000,
  peer_cooldown_minutes: 720,
  max_expansions_per_day: 3,
  max_daily_deploy_sats: 400_000,
  max_daily_loss_sats: 5_000,
};

beforeEach(() => {
  Object.assign(s.row, { ...SHIPPED_DEFAULTS, id: 1, updated_at: 1_700_000_000_000, last_applied_at: null });
  s.writes = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// (i) REFUSES — the violating case
// ═══════════════════════════════════════════════════════════════════════════

describe("setCapitalPolicy refuses out-of-range writes", () => {
  it("rejects a NEGATIVE min_onchain_reserve_sats and writes nothing", () => {
    // The dangerous direction for this field specifically: it is the one limit
    // where a LOW value loosens the guardrail. Every other field loosens HIGH.
    expect(() => setCapitalPolicy({ min_onchain_reserve_sats: -1 })).toThrow();
    expect(s.writes, "a rejected patch must not reach the UPDATE").toEqual([]);
    expect(s.row.min_onchain_reserve_sats).toBe(300_000);
  });

  it("rejects an absurd max_deploy_ratio_ppm and writes nothing", () => {
    // 99_000_000 ppm = 9900%. The deploy-ratio check compares against
    // totalCapital * ppm / 1e6, so anything above 1_000_000 cannot bind.
    expect(() => setCapitalPolicy({ max_deploy_ratio_ppm: 99_000_000 })).toThrow();
    expect(s.writes).toEqual([]);
    expect(s.row.max_deploy_ratio_ppm).toBe(600_000);
  });

  it("rejects a negative value on every field", () => {
    for (const field of Object.keys(SHIPPED_DEFAULTS)) {
      s.writes = [];
      expect(() => setCapitalPolicy({ [field]: -1 } as any), `${field} accepted -1`).toThrow();
      expect(s.writes, `${field} wrote despite rejection`).toEqual([]);
    }
  });

  it("rejects an over-ceiling value on every field", () => {
    // Number.MAX_SAFE_INTEGER is above every ceiling by construction, so this
    // asserts each field HAS a ceiling without restating the table.
    for (const field of Object.keys(SHIPPED_DEFAULTS)) {
      s.writes = [];
      expect(
        () => setCapitalPolicy({ [field]: Number.MAX_SAFE_INTEGER } as any),
        `${field} accepted MAX_SAFE_INTEGER`,
      ).toThrow();
      expect(s.writes, `${field} wrote despite rejection`).toEqual([]);
    }
  });

  it("rejects NaN rather than letting it pass the range comparison", () => {
    // The route builds values with Number(parsed.x), so garbage arrives as NaN.
    // NaN < min and NaN > max are BOTH false, so a naive range check accepts it.
    expect(() => setCapitalPolicy({ max_daily_loss_sats: Number.NaN })).toThrow();
    expect(s.writes).toEqual([]);
  });

  it("rejects a rejected field without applying the OTHER fields in the same patch", () => {
    // Partial application would leave the operator with a policy they never
    // asked for and a rejection saying it did not happen.
    expect(() =>
      setCapitalPolicy({ max_pending_opens: 2, min_onchain_reserve_sats: -5 }),
    ).toThrow();
    expect(s.writes).toEqual([]);
    expect(s.row.max_pending_opens, "sibling field applied despite rejection").toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (ii) PERMITS — the legitimate case. THIS IS THE ONE THAT MATTERS.
// A validator that blocks a real policy change is an outage Ethan hits by hand.
// ═══════════════════════════════════════════════════════════════════════════

describe("setCapitalPolicy permits legitimate writes", () => {
  it("writes the shipped defaults unchanged", () => {
    const out = setCapitalPolicy({ ...SHIPPED_DEFAULTS });
    expect(s.writes.length, "the defaults must reach the UPDATE").toBe(1);
    for (const [k, v] of Object.entries(SHIPPED_DEFAULTS)) {
      expect(out[k as keyof typeof SHIPPED_DEFAULTS], `${k} not stored`).toBe(v);
    }
  });

  it("writes a realistic operator adjustment", () => {
    // Loosening the reserve, widening the ratio to 80%, allowing a second
    // concurrent open and a larger per-peer position: an ordinary treasury
    // retune, none of it out of bounds.
    const out = setCapitalPolicy({
      min_onchain_reserve_sats: 500_000,
      max_deploy_ratio_ppm: 800_000,
      max_pending_opens: 2,
      max_peer_capacity_sats: 2_000_000,
      peer_cooldown_minutes: 360,
      max_expansions_per_day: 5,
      max_daily_deploy_sats: 2_000_000,
      max_daily_loss_sats: 25_000,
    });
    expect(s.writes.length).toBe(1);
    expect(out.max_deploy_ratio_ppm).toBe(800_000);
    expect(out.max_peer_capacity_sats).toBe(2_000_000);
    expect(out.max_daily_loss_sats).toBe(25_000);
  });

  it("permits a partial patch, leaving unnamed fields at their current values", () => {
    const out = setCapitalPolicy({ max_expansions_per_day: 4 });
    expect(s.writes.length).toBe(1);
    expect(out.max_expansions_per_day).toBe(4);
    expect(out.min_onchain_reserve_sats, "unnamed field changed").toBe(300_000);
  });

  it("permits an empty patch", () => {
    // The route sends `undefined` for every field the operator left alone, so
    // an all-undefined patch is a real request shape, not a degenerate one.
    const out = setCapitalPolicy({});
    expect(s.writes.length).toBe(1);
    expect(out.max_deploy_ratio_ppm).toBe(600_000);
  });

  it("permits the deliberate freeze values", () => {
    // Zero is a legitimate operator choice on these: it halts expansion rather
    // than loosening anything. Rejecting it would be the validator inventing a
    // policy nobody asked for.
    const out = setCapitalPolicy({
      max_pending_opens: 0,
      max_expansions_per_day: 0,
      peer_cooldown_minutes: 0,
    });
    expect(s.writes.length).toBe(1);
    expect(out.max_pending_opens).toBe(0);
    expect(out.peer_cooldown_minutes).toBe(0);
  });

  it("permits max_deploy_ratio_ppm at exactly 1_000_000 (100%)", () => {
    // The boundary is inclusive: 100% deployment is expressible policy, and an
    // off-by-one here would reject a value the operator can reach in the UI.
    const out = setCapitalPolicy({ max_deploy_ratio_ppm: 1_000_000 });
    expect(s.writes.length).toBe(1);
    expect(out.max_deploy_ratio_ppm).toBe(1_000_000);
  });
});
