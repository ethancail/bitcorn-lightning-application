// The tier ladder → JWT scope mapping, pinned.
//
// WHY THIS FILE EXISTS: `scopeForTier` and `computeTier` had ZERO test coverage
// before this, and the stablecoin rail now depends on both. Moving /base/* from
// payment-scope to full-scope (cloudflare-worker/src/index.ts) makes this
// mapping the thing that decides who can use the rail, so it needs to be a
// tested surface rather than an assumed one.
//
// It also closes a cross-package gap: cloudflare-worker/tests/baseScope.test.ts
// hard-codes the tier→scope table it drives its fixtures from, because the
// Worker package cannot import across into the API package. This file is what
// makes that table verified instead of assumed. If the mapping here changes, the
// Worker test's fixtures are wrong and this file is where it surfaces.
//
// Test seam (no production-code change): tokenIssuance.ts and tierDispatch.ts
// both statically import `../db`, which opens SQLite and mkdirs DB_DIR at module
// load (default /data/db, not writable here). Same discipline as
// stablecoin/handlers.test.ts — point DB_DIR at a throwaway temp dir, then pull
// the modules in via dynamic import once env is set.

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-tier-scope-"));
process.env.DB_DIR = TMP_DIR;
process.env.TREASURY_PUBKEY = process.env.TREASURY_PUBKEY ?? "02".padEnd(66, "a");

let scopeForTier: typeof import("./tokenIssuance").scopeForTier;
let computeTier: typeof import("./tierDispatch").computeTier;

beforeAll(async () => {
  ({ scopeForTier } = await import("./tokenIssuance"));
  ({ computeTier } = await import("./tierDispatch"));
});

const MS_PER_DAY = 86_400_000;

// Grace values distinct from each other so a ladder test can never pass by
// reading the wrong one. These are NOT the deployed policy since migration 071
// (worker = routing = 30); the deployed values have their own block below.
const LADDER = {
  graceDaysWorker: 7,
  graceDaysRouting: 30,
  graceDaysClose: 60,
};

describe("scopeForTier — the mapping the /base/* gate now depends on", () => {
  // Exactly one tier maps to `full`. Enumerated one-by-one rather than looped so
  // a future tier addition fails to compile/enumerate rather than silently
  // slipping into the default.
  it("maps `current` to full", () => {
    expect(scopeForTier("current")).toBe("full");
  });

  it.each(["prepay", "worker_lapsed", "routing_lapsed", "close_due"])(
    "maps `%s` to payment (blocked from the rail after the scope change)",
    (tier) => {
      expect(scopeForTier(tier)).toBe("payment");
    },
  );

  it("defaults an unknown tier to payment, not full", () => {
    // Defensive fallback (tokenIssuance.ts:98-101). A future tier value must
    // fail CLOSED — issuing `full` to an unrecognized tier would hand rail
    // access to a state nobody has reasoned about.
    expect(scopeForTier("some_future_tier")).toBe("payment");
    expect(scopeForTier("")).toBe("payment");
  });
});

describe("computeTier — a never-paid row has NO pre-payment access (membership-gating T1)", () => {
  // This block used to pin the opposite: "fresh-grace access to the rail is
  // INTENDED", with a 30-day window from created_at during which a never-paid
  // row computed `current`. Decision D1 (bitcorn-research
  // specs/2026-11-05-membership-gating-spec.md T1) removed fresh grace, so the
  // property is now its negation: from the moment a row exists, no payment that
  // credits time means `prepay`, which means payment scope and no rail.
  const createdAt = 1_700_000_000_000;

  it.each([0, 1, 5, 30, 400])(
    "a never-paid row %i day(s) after creation computes `prepay`, payment scope",
    (days) => {
      const tier = computeTier({
        hasAnyPaymentRow: false,
        paidThroughMs: createdAt, // allocator seeds paid_through = created_at
        ...LADDER,
        nowMs: createdAt + days * MS_PER_DAY,
      });
      expect(tier).toBe("prepay");
      expect(scopeForTier(tier)).toBe("payment");
    },
  );

  it("even a paid_through in the future does not help a row with no credited payment", () => {
    // paid_through is only meaningful on the paid ladder; a row reaches that
    // ladder through a payment row with period_extension_days > 0.
    const tier = computeTier({
      hasAnyPaymentRow: false,
      paidThroughMs: createdAt + 30 * MS_PER_DAY,
      ...LADDER,
      nowMs: createdAt,
    });
    expect(tier).toBe("prepay");
  });
});

describe("computeTier — under the deployed policy since migration 071 (worker 30, routing 30)", () => {
  const paidThrough = 1_700_000_000_000;
  const DEPLOYED = { graceDaysWorker: 30, graceDaysRouting: 30, graceDaysClose: 60 };
  const at = (ms: number) =>
    computeTier({ hasAnyPaymentRow: true, paidThroughMs: paidThrough, ...DEPLOYED, nowMs: ms });

  it("current through paid_through + 30d inclusive — full scope, rail open", () => {
    expect(at(paidThrough + 30 * MS_PER_DAY)).toBe("current");
    expect(scopeForTier(at(paidThrough + 30 * MS_PER_DAY))).toBe("full");
  });

  it("one millisecond past + 30d is routing_lapsed — worker_lapsed is unreachable (R3)", () => {
    expect(at(paidThrough + 30 * MS_PER_DAY + 1)).toBe("routing_lapsed");
    expect(scopeForTier(at(paidThrough + 30 * MS_PER_DAY + 1))).toBe("payment");
    for (let d = 0; d <= 70; d++) {
      expect(at(paidThrough + d * MS_PER_DAY)).not.toBe("worker_lapsed");
    }
  });

  it("close_due past + 60d (unchanged)", () => {
    expect(at(paidThrough + 61 * MS_PER_DAY)).toBe("close_due");
  });
});

describe("computeTier — the paid ladder, and where the rail cuts off", () => {
  const paidThrough = 1_700_000_000_000;

  function tierAtDaysPastExpiry(days: number) {
    return computeTier({
      hasAnyPaymentRow: true,
      paidThroughMs: paidThrough,
      ...LADDER,
      nowMs: paidThrough + days * MS_PER_DAY,
    });
  }

  it("still `current` inside paid_through", () => {
    expect(tierAtDaysPastExpiry(-1)).toBe("current");
  });

  it("still `current` inside the +7d worker grace — rail still works", () => {
    expect(tierAtDaysPastExpiry(6)).toBe("current");
    expect(scopeForTier(tierAtDaysPastExpiry(6))).toBe("full");
  });

  it("⚠ past the worker grace a PAYING member drops to worker_lapsed and LOSES the rail", () => {
    // With LADDER's 7-day worker grace (migration 036's default, the deployed
    // value until migration 071 moved it to 30): 8 days late costs the rail.
    // The DEPLOYED cutoff is pinned in the "deployed policy" block above; this
    // test pins the ladder's shape with distinct values.
    expect(tierAtDaysPastExpiry(8)).toBe("worker_lapsed");
    expect(scopeForTier(tierAtDaysPastExpiry(8))).toBe("payment");
  });

  it("routing_lapsed past +30d, close_due past +60d — both payment scope", () => {
    expect(tierAtDaysPastExpiry(31)).toBe("routing_lapsed");
    expect(tierAtDaysPastExpiry(61)).toBe("close_due");
    expect(scopeForTier(tierAtDaysPastExpiry(31))).toBe("payment");
    expect(scopeForTier(tierAtDaysPastExpiry(61))).toBe("payment");
  });

  it("a paid row is evaluated against paid_through alone", () => {
    const tier = computeTier({
      hasAnyPaymentRow: true,
      paidThroughMs: paidThrough,
      ...LADDER,
      nowMs: paidThrough + 100 * MS_PER_DAY,
    });
    expect(tier).toBe("close_due");
  });
});
