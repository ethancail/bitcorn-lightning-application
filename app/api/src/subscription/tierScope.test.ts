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
const GRACE_FRESH = 30;

// Grace values distinct from each other AND from GRACE_FRESH so a test can
// never pass by reading the wrong one.
const LADDER = {
  graceDaysFresh: GRACE_FRESH,
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

describe("computeTier — fresh-grace access to the rail is INTENDED", () => {
  // These are the tests that must fail if someone later "tightens" the gate by
  // removing fresh-grace access. Trial access is a deliberate property (see the
  // rationale block in cloudflare-worker/src/index.ts), so it gets a test that
  // names it.
  const createdAt = 1_700_000_000_000;

  it("a never-paid row INSIDE its fresh-grace window computes to `current`", () => {
    const tier = computeTier({
      hasAnyPaymentRow: false,
      createdAtMs: createdAt,
      paidThroughMs: createdAt, // allocator seeds paid_through = created_at
      ...LADDER,
      nowMs: createdAt + 5 * MS_PER_DAY,
    });
    expect(tier).toBe("current");
  });

  it("...and therefore holds a FULL-scope token, so it reaches /base/*", () => {
    // The end-to-end property stated as one assertion: a brand-new node that has
    // never paid a satoshi can use the rail. Composing the two functions is the
    // point — either one alone would let the property break silently.
    const tier = computeTier({
      hasAnyPaymentRow: false,
      createdAtMs: createdAt,
      paidThroughMs: createdAt,
      ...LADDER,
      nowMs: createdAt + 1 * MS_PER_DAY,
    });
    expect(scopeForTier(tier)).toBe("full");
  });

  it("a never-paid row PAST its fresh-grace window computes to `prepay` (payment scope)", () => {
    const tier = computeTier({
      hasAnyPaymentRow: false,
      createdAtMs: createdAt,
      paidThroughMs: createdAt,
      ...LADDER,
      nowMs: createdAt + (GRACE_FRESH + 1) * MS_PER_DAY,
    });
    expect(tier).toBe("prepay");
    expect(scopeForTier(tier)).toBe("payment");
  });

  it("the fresh-grace boundary is inclusive at the deadline, lapsed just past it", () => {
    const atDeadline = createdAt + GRACE_FRESH * MS_PER_DAY;
    expect(
      computeTier({
        hasAnyPaymentRow: false,
        createdAtMs: createdAt,
        paidThroughMs: createdAt,
        ...LADDER,
        nowMs: atDeadline,
      }),
    ).toBe("current");
    expect(
      computeTier({
        hasAnyPaymentRow: false,
        createdAtMs: createdAt,
        paidThroughMs: createdAt,
        ...LADDER,
        nowMs: atDeadline + 1,
      }),
    ).toBe("prepay");
  });

  it("an EXISTING never-paid node (old row) is already blocked", () => {
    // Reason 2 of the fresh-grace decision: the window runs from created_at, so
    // every pre-existing never-paid row is long past it. Fresh grace reaches
    // only genuinely new nodes — it is not a hole for the existing fleet.
    const tier = computeTier({
      hasAnyPaymentRow: false,
      createdAtMs: createdAt,
      paidThroughMs: createdAt,
      ...LADDER,
      nowMs: createdAt + 400 * MS_PER_DAY,
    });
    expect(tier).toBe("prepay");
    expect(scopeForTier(tier)).toBe("payment");
  });
});

describe("computeTier — the paid ladder, and where the rail cuts off", () => {
  const paidThrough = 1_700_000_000_000;

  function tierAtDaysPastExpiry(days: number) {
    return computeTier({
      hasAnyPaymentRow: true,
      createdAtMs: paidThrough - 365 * MS_PER_DAY,
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

  it("⚠ at +8d a PAYING member drops to worker_lapsed and LOSES the rail", () => {
    // The known, accepted disproportion recorded in the Worker's rationale
    // block: 8 days late on a ~50,000-sat subscription costs the ability to
    // send a six-figure settlement. Pinned as a test so the cutoff is a
    // visible, deliberate number rather than an emergent surprise — if the
    // threshold is ever revisited, this is the test that has to change.
    expect(tierAtDaysPastExpiry(8)).toBe("worker_lapsed");
    expect(scopeForTier(tierAtDaysPastExpiry(8))).toBe("payment");
  });

  it("routing_lapsed past +30d, close_due past +60d — both payment scope", () => {
    expect(tierAtDaysPastExpiry(31)).toBe("routing_lapsed");
    expect(tierAtDaysPastExpiry(61)).toBe("close_due");
    expect(scopeForTier(tierAtDaysPastExpiry(31))).toBe("payment");
    expect(scopeForTier(tierAtDaysPastExpiry(61))).toBe("payment");
  });

  it("a paid row never falls back into the fresh-grace branch", () => {
    // hasAnyPaymentRow=true must bypass the fresh-grace test entirely, even
    // when created_at is recent. Otherwise a member who paid on day 1 would be
    // evaluated against created_at forever.
    const tier = computeTier({
      hasAnyPaymentRow: true,
      createdAtMs: paidThrough,
      paidThroughMs: paidThrough,
      ...LADDER,
      nowMs: paidThrough + 100 * MS_PER_DAY,
    });
    expect(tier).toBe("close_due");
  });
});
