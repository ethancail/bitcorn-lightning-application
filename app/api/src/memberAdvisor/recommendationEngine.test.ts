import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

// Stub the singleton db module so importing ./recommendationEngine (which
// imports ../db) doesn't try to mkdir /data/db on the test host — same
// pattern as base/store.test.ts.
//
// ⚠ THE TABLE IS CREATED HERE, NOT JUST THE DATABASE. getConfig() runs
// `SELECT * FROM member_liquidity_advisor_config` on every computeRecommendation
// call, and better-sqlite3 throws at prepare() on a missing table — so a bare
// `new Database(":memory:")` (which is all this mock used to be, when the only
// test subject was describeSustainedRuns) makes every engine test die in setup
// rather than assert. Columns and defaults mirror migrations 027 + 028 + 032;
// only the ones getConfig() reads are declared.
vi.mock("../db", () => {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE member_liquidity_advisor_config (
      id                                INTEGER PRIMARY KEY DEFAULT 1,
      target_mid_pct                    REAL    NOT NULL DEFAULT 0.50,
      min_loop_sats                     INTEGER NOT NULL DEFAULT 50000,
      max_loop_sats                     INTEGER NOT NULL DEFAULT 2000000,
      floor_sats                        INTEGER NOT NULL DEFAULT 10000,
      min_channel_capacity_sat          INTEGER NOT NULL DEFAULT 500000,
      merchant_recommended_capacity_sat INTEGER NOT NULL DEFAULT 2000000,
      farmer_recommended_capacity_sat   INTEGER NOT NULL DEFAULT 1000000
    )
  `);
  d.exec(`INSERT INTO member_liquidity_advisor_config (id) VALUES (1)`);
  return { db: d };
});

// Resolves to the mock above, so this IS the in-memory handle — which is what
// lets the one test that needs a non-default floor_sats set it (see
// "farmer's SECOND manual_recovery" below).
import { db as memDb } from "../db";
import { describeSustainedRuns, computeRecommendation } from "./recommendationEngine";
import type { ChannelClassification } from "./channelClassifier";
import type { LoopAvailability } from "./loopAvailability";

// One scheduler run = 15 minutes (advisorScheduler.ts). The member-facing
// "repeated depletion/filling" copy renders this as a duration, never as
// "N consecutive runs" jargon.
describe("describeSustainedRuns", () => {
  it("renders minutes for short sustained states", () => {
    expect(describeSustainedRuns(1)).toBe("about 15 minutes");
    expect(describeSustainedRuns(3)).toBe("about 45 minutes"); // the >=3 escalation threshold
    expect(describeSustainedRuns(4)).toBe("about 60 minutes");
  });

  it("switches to hours past one hour", () => {
    expect(describeSustainedRuns(5)).toBe("about 1 hour");
    expect(describeSustainedRuns(8)).toBe("about 2 hours");
    expect(describeSustainedRuns(40)).toBe("about 10 hours");
  });

  it("caps at 'more than a day' — including legacy inflated counters", () => {
    expect(describeSustainedRuns(96)).toBe("more than a day");
    // pre-fix dev DBs accumulated counters like 51,588 from poll-driven
    // increments; the cap keeps those rows from rendering absurd durations
    expect(describeSustainedRuns(51_588)).toBe("more than a day");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURES
//
// Capacities are chosen to clear the per-role undersized pre-emption, which
// fires BEFORE any band check and would otherwise swallow every case below:
// merchant needs >= 2,000,000 and farmer >= 1,000,000 (getConfig defaults,
// migration 032). memberLocalPct is a FRACTION, not a percentage —
// recommendationEngine.ts:131 renders it with `* 100` for display.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_FLOOR_SATS = 10_000;

beforeEach(() => {
  // Restore the seeded default; one test below writes a non-default floor.
  memDb
    .prepare("UPDATE member_liquidity_advisor_config SET floor_sats = ? WHERE id = 1")
    .run(DEFAULT_FLOOR_SATS);
});

function classification(over: Partial<ChannelClassification> = {}): ChannelClassification {
  const capacitySat = over.capacitySat ?? 2_000_000;
  const memberLocalSat = over.memberLocalSat ?? 1_000_000;
  return {
    channelId: "1x1x1",
    capacitySat,
    memberLocalSat,
    treasuryLocalSat: capacitySat - memberLocalSat,
    memberLocalPct: memberLocalSat / capacitySat,
    state: "healthy",
    urgency: "none",
    consecutiveNonHealthyRuns: 0,
    classifiedAt: 0,
    channelRole: "unknown",
    ...over,
  };
}

/** loopd never answered: the classified reason is the only cause signal. */
function loopDown(reason: "credentials_absent" | "unreachable"): LoopAvailability {
  return {
    loopDaemonRunning: false,
    loopOutAvailable: false,
    loopInAvailable: false,
    loopOutTerms: null,
    loopInTerms: null,
    unavailableReason: reason,
  };
}

/**
 * §2's FOURTH copy case: the daemon IS up, and only the terms fetch failed
 * (loopAvailability.ts:52-54 / :64-66, reached after loopDaemonRunning is
 * already true). There is no unavailability reason to carry, because the
 * daemon is not unavailable.
 */
function loopUpTermsFailed(): LoopAvailability {
  return {
    loopDaemonRunning: true,
    loopOutAvailable: false,
    loopInAvailable: false,
    loopOutTerms: null,
    loopInTerms: null,
    unavailableReason: null,
  };
}

/** Daemon up and terms served — the ordinary working case. */
function loopUp(): LoopAvailability {
  return {
    loopDaemonRunning: true,
    loopOutAvailable: true,
    loopInAvailable: true,
    loopOutTerms: { minSats: 250_000, maxSats: 500_000 },
    loopInTerms: { minSats: 250_000, maxSats: 500_000 },
    unavailableReason: null,
  };
}

// A depleted merchant (localPct 0.10 < 0.15) large enough not to be undersized.
const MERCHANT_DEPLETED = classification({
  channelRole: "merchant",
  capacitySat: 2_000_000,
  memberLocalSat: 200_000,
  state: "receive_exhausted",
  urgency: "high",
});

// A full farmer (localPct 0.90 >= 0.85) large enough not to be undersized.
const FARMER_FULL = classification({
  channelRole: "farmer",
  capacitySat: 1_000_000,
  memberLocalSat: 900_000,
  state: "send_saturated",
  urgency: "high",
});

/**
 * The claims D3 forbids in EVERY unavailability state. Kept as one list so a
 * new state cannot be added with a looser ban than its siblings.
 */
const FORBIDDEN_CLAIMS = /install|installed|not set up|configured|expired/i;

/**
 * ⚠ ANTI-VACUITY GUARD. Every negative assertion below runs through this.
 *
 * `expect(rec.reason ?? "").not.toMatch(/install/)` passes on an empty string,
 * on undefined, and on a component that renders nothing at all — which is the
 * hole app/web/src/components/channelStaleness.test.ts:112-114 has (existing
 * §2 entry). A suite that only FORBIDS strings cannot tell a fixed message
 * from an absent one, so nothing here is allowed to assert a negative without
 * asserting positive content in the same test.
 */
function assertNonVacuous(reason: string): void {
  expect(typeof reason).toBe("string");
  expect(reason.length).toBeGreaterThan(10);
}

// ═══════════════════════════════════════════════════════════════════════════
// D1/D2/D3 — THREE STATES, BOTH ROLES, PAIRED IN BOTH DIRECTIONS.
//
// The pairing is the point. The REFUSAL direction (unreachable must not claim
// a cause) is the easy half and passes on a blank string. The PERMISSION
// direction (credentials_absent must actually say its own thing, and must
// differ from unreachable) is the half that catches a three-state model
// collapsed back onto one string.
// ═══════════════════════════════════════════════════════════════════════════

describe("Loop unavailability copy — merchant", () => {
  it("credentials_absent says its own thing (PERMISSION direction)", () => {
    const rec = computeRecommendation(MERCHANT_DEPLETED, loopDown("credentials_absent"));
    assertNonVacuous(rec.reason);
    expect(rec.action).toBe("manual_recovery");
    expect(rec.reason).toContain("Loop isn't ready on this node yet.");
  });

  it("unreachable says its own thing, and asserts no cause (PAIRED)", () => {
    const rec = computeRecommendation(MERCHANT_DEPLETED, loopDown("unreachable"));
    assertNonVacuous(rec.reason);
    expect(rec.action).toBe("manual_recovery");
    // POSITIVE first — this is what makes the negative below mean something.
    expect(rec.reason).toContain("Loop isn't responding right now.");
    expect(rec.reason).not.toMatch(FORBIDDEN_CLAIMS);
  });

  it("the two states do NOT render the same sentence", () => {
    const absent = computeRecommendation(MERCHANT_DEPLETED, loopDown("credentials_absent")).reason;
    const unreachable = computeRecommendation(MERCHANT_DEPLETED, loopDown("unreachable")).reason;
    assertNonVacuous(absent);
    assertNonVacuous(unreachable);
    expect(absent).not.toBe(unreachable);
  });
});

describe("Loop unavailability copy — farmer", () => {
  it("credentials_absent says its own thing (PERMISSION direction)", () => {
    const rec = computeRecommendation(FARMER_FULL, loopDown("credentials_absent"));
    assertNonVacuous(rec.reason);
    expect(rec.action).toBe("manual_recovery");
    expect(rec.reason).toContain("Loop isn't ready on this node yet.");
  });

  it("unreachable says its own thing, and asserts no cause (PAIRED)", () => {
    const rec = computeRecommendation(FARMER_FULL, loopDown("unreachable"));
    assertNonVacuous(rec.reason);
    expect(rec.action).toBe("manual_recovery");
    expect(rec.reason).toContain("Loop isn't responding right now.");
    expect(rec.reason).not.toMatch(FORBIDDEN_CLAIMS);
  });

  it("the two states do NOT render the same sentence", () => {
    const absent = computeRecommendation(FARMER_FULL, loopDown("credentials_absent")).reason;
    const unreachable = computeRecommendation(FARMER_FULL, loopDown("unreachable")).reason;
    assertNonVacuous(absent);
    assertNonVacuous(unreachable);
    expect(absent).not.toBe(unreachable);
  });
});

// ⚠ D3's cert-notice constraint: an expired or rotated LND cert lands in
// `unreachable`, and the cert notice already owns that fault's cause and
// remediation on the same dashboard in the same poll cycle. The advisor states
// the state; it must not re-explain the cause or name a restart.
describe("unreachable does not duplicate the cert notice", () => {
  it("names no certificate, no restart, and no daemon internals", () => {
    for (const c of [MERCHANT_DEPLETED, FARMER_FULL]) {
      const reason = computeRecommendation(c, loopDown("unreachable")).reason;
      assertNonVacuous(reason);
      expect(reason).toContain("Loop isn't responding right now.");
      expect(reason).not.toMatch(/certificate|cert\b|restart|loopd|gRPC|grpc|code 1[0-9]/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 ROW FOUR — THE REGRESSION A THREE-STATE REFACTOR IS MOST LIKELY TO EAT.
//
// Three DAEMON states, FOUR COPY cases. This row is reached only AFTER
// loopDaemonRunning is already true, so it is not a daemon state at all — and
// its copy was already honest and must not move. An implementation that maps
// three daemon states onto the existing two ternary arms collapses this row.
// ═══════════════════════════════════════════════════════════════════════════

describe("§2 row four — daemon up, terms fetch failed — copy UNCHANGED", () => {
  it("merchant still says Top Up is currently unavailable", () => {
    const rec = computeRecommendation(MERCHANT_DEPLETED, loopUpTermsFailed());
    assertNonVacuous(rec.reason);
    expect(rec.action).toBe("manual_recovery");
    expect(rec.reason).toContain("Top Up is currently unavailable.");
    // It must NOT borrow either daemon-down sentence: the daemon is up.
    expect(rec.reason).not.toContain("Loop isn't ready on this node yet.");
    expect(rec.reason).not.toContain("Loop isn't responding right now.");
  });

  it("farmer still says Withdrawals are currently unavailable", () => {
    const rec = computeRecommendation(FARMER_FULL, loopUpTermsFailed());
    assertNonVacuous(rec.reason);
    expect(rec.action).toBe("manual_recovery");
    expect(rec.reason).toContain("Withdrawals are currently unavailable.");
    expect(rec.reason).not.toContain("Loop isn't ready on this node yet.");
    expect(rec.reason).not.toContain("Loop isn't responding right now.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D4 — THE INSTALL CLAIM OUTSIDE THE TERNARY.
//
// recommendationEngine.ts's merchant base prose made the claim independently
// of the discriminator, so a merchant whose loopd was fine but whose Loop In
// terms fetch failed was told to install software that IS installed, in the
// same sentence as being told it was merely unavailable.
// ═══════════════════════════════════════════════════════════════════════════

describe("D4 — merchant base prose makes no installation claim", () => {
  it("keeps its function and drops the claim, in every merchant reason", () => {
    for (const loop of [
      loopDown("credentials_absent"),
      loopDown("unreachable"),
      loopUpTermsFailed(),
    ]) {
      const rec = computeRecommendation(MERCHANT_DEPLETED, loop);
      assertNonVacuous(rec.reason);
      // POSITIVE: the sentence still routes the merchant to Top Up.
      expect(rec.reason).toContain("To restore your ability to pay");
      expect(rec.reason).toContain("Top Up");
      // NEGATIVE, meaningful only because of the two above.
      expect(rec.reason).not.toMatch(/install/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BANDS AND PRE-EMPTIONS — pinned while the file is open (spec §6).
//
// All of this was unpinned, so a fix that inverted a band would have shipped
// green.
// ═══════════════════════════════════════════════════════════════════════════

describe("merchant band — healthy at localPct >= 0.30", () => {
  it("returns action none with healthy copy at exactly 0.30", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "merchant",
        capacitySat: 2_000_000,
        memberLocalSat: 600_000, // exactly 0.30
      }),
      loopUp(),
    );
    expect(rec.action).toBe("none");
    expect(rec.urgency).toBe("none");
    assertNonVacuous(rec.reason);
    expect(rec.reason).toContain("ready to pay");
  });

  it("falls out of the healthy band just below 0.30", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "merchant",
        capacitySat: 2_000_000,
        memberLocalSat: 599_000, // 0.2995
      }),
      loopUp(),
    );
    expect(rec.action).not.toBe("none");
  });
});

describe("farmer band — healthy at localPct <= 0.70", () => {
  it("returns action none with healthy copy at exactly 0.70", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "farmer",
        capacitySat: 1_000_000,
        memberLocalSat: 700_000, // exactly 0.70
      }),
      loopUp(),
    );
    expect(rec.action).toBe("none");
    expect(rec.urgency).toBe("none");
    assertNonVacuous(rec.reason);
    expect(rec.reason).toContain("ready to earn");
  });

  it("falls out of the healthy band just above 0.70", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "farmer",
        capacitySat: 1_000_000,
        memberLocalSat: 701_000, // 0.701
      }),
      loopUp(),
    );
    expect(rec.action).not.toBe("none");
  });
});

// ⚠ THE HEALTHY-BAND SILENCE — the property Phase 1 recorded and nothing pinned.
// A healthy node is the overwhelmingly common case, and this ships as a release
// members install by clicking. A healthy farmer whose loopd is dead must be told
// nothing about Loop at all.
describe("healthy-band silence survives a dead daemon", () => {
  it("says nothing about Loop to a healthy farmer whose loopd is unreachable", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "farmer",
        capacitySat: 1_000_000,
        memberLocalSat: 500_000, // 0.50 — comfortably healthy
      }),
      loopDown("unreachable"),
    );
    expect(rec.action).toBe("none");
    assertNonVacuous(rec.reason);
    expect(rec.reason).toContain("ready to earn");
    expect(rec.reason).not.toMatch(/loop/i);
    expect(rec.loopAvailable).toBe(false);
  });

  it("says nothing about Loop to a healthy merchant whose credentials are absent", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "merchant",
        capacitySat: 2_000_000,
        memberLocalSat: 1_000_000, // 0.50
      }),
      loopDown("credentials_absent"),
    );
    expect(rec.action).toBe("none");
    assertNonVacuous(rec.reason);
    expect(rec.reason).toContain("ready to pay");
    expect(rec.reason).not.toMatch(/loop/i);
    expect(rec.loopAvailable).toBe(false);
  });
});

// ⚠ THE TWO PRE-EMPTION IDENTIFIERS ARE DIFFERENT PER ROLE, and they key off
// OPPOSITE channel-state families: merchant `repeatedDepletion` wants
// receive_heavy/receive_exhausted, farmer `repeatedFilling` wants
// send_heavy/send_saturated. A test written against the wrong family pins
// nothing and passes anyway — so each role gets a negative control using the
// OTHER role's state family.
describe("merchant pre-emption — undersized || repeatedDepletion", () => {
  it("undersized beats the unhealthy band", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "merchant",
        capacitySat: 1_999_999, // one sat under the merchant minimum
        memberLocalSat: 200_000,
        state: "receive_exhausted",
      }),
      loopDown("unreachable"),
    );
    expect(rec.action).toBe("channel_upgrade");
    assertNonVacuous(rec.reason);
    expect(rec.reason).toContain("recommended merchant");
  });

  it("repeatedDepletion fires on the RECEIVE state family", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "merchant",
        capacitySat: 2_000_000, // not undersized
        memberLocalSat: 200_000,
        state: "receive_exhausted",
        consecutiveNonHealthyRuns: 3,
      }),
      loopDown("unreachable"),
    );
    expect(rec.action).toBe("channel_upgrade");
    expect(rec.reason).toContain("sending balance has stayed low");
  });

  it("does NOT fire on the farmer's state family — proves the identifier is role-correct", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "merchant",
        capacitySat: 2_000_000,
        memberLocalSat: 200_000,
        state: "send_saturated", // the FARMER family; merchant must ignore it
        consecutiveNonHealthyRuns: 3,
      }),
      loopDown("unreachable"),
    );
    expect(rec.action).not.toBe("channel_upgrade");
    expect(rec.action).toBe("manual_recovery");
  });
});

describe("farmer pre-emption — undersized || repeatedFilling", () => {
  it("undersized beats the unhealthy band", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "farmer",
        capacitySat: 999_999, // one sat under the farmer minimum
        memberLocalSat: 900_000,
        state: "send_saturated",
      }),
      loopDown("unreachable"),
    );
    expect(rec.action).toBe("channel_upgrade");
    assertNonVacuous(rec.reason);
    expect(rec.reason).toContain("recommended farmer");
  });

  it("repeatedFilling fires on the SEND state family", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "farmer",
        capacitySat: 1_000_000, // not undersized
        memberLocalSat: 900_000,
        state: "send_saturated",
        consecutiveNonHealthyRuns: 3,
      }),
      loopDown("unreachable"),
    );
    expect(rec.action).toBe("channel_upgrade");
    expect(rec.reason).toContain("full or nearly full");
  });

  it("does NOT fire on the merchant's state family — proves the identifier is role-correct", () => {
    const rec = computeRecommendation(
      classification({
        channelRole: "farmer",
        capacitySat: 1_000_000,
        memberLocalSat: 900_000,
        state: "receive_heavy", // the MERCHANT family; farmer must ignore it
        consecutiveNonHealthyRuns: 3,
      }),
      loopDown("unreachable"),
    );
    expect(rec.action).not.toBe("channel_upgrade");
    expect(rec.action).toBe("manual_recovery");
  });
});

/**
 * The farmer's SECOND manual_recovery return — the one that sets
 * `loopAvailable: true` and carries NO unavailability reason, because Loop is
 * working and the balance is simply too small to withdraw.
 *
 * ⚠ Reaching it requires a non-default `floor_sats`. With the seeded default
 * (10,000) it is UNREACHABLE: the guard is `amount <= 0` after
 * `amount = min(amount, memberLocalSat - floorSats)`, and a farmer in this band
 * already holds more than 0.70 of a >= 1,000,000-sat channel, so
 * `memberLocalSat - 10_000` is always comfortably positive. It becomes reachable
 * exactly when the configured reserve floor meets or exceeds the farmer's whole
 * local balance — a legitimate operator setting, and the only way in.
 */
describe("farmer's SECOND manual_recovery — Loop up, balance too small", () => {
  it("keeps loopAvailable true and names no Loop unavailability", () => {
    memDb
      .prepare("UPDATE member_liquidity_advisor_config SET floor_sats = ? WHERE id = 1")
      .run(1_000_000); // exceeds memberLocalSat below

    const rec = computeRecommendation(
      classification({
        channelRole: "farmer",
        capacitySat: 1_000_000,
        memberLocalSat: 900_000, // 0.90 — in the Loop Out band
        state: "send_saturated",
      }),
      loopUp(),
    );

    expect(rec.action).toBe("manual_recovery");
    expect(rec.loopAvailable).toBe(true);
    assertNonVacuous(rec.reason);
    expect(rec.reason).toContain("too small to withdraw");
    expect(rec.reason).not.toContain("Loop isn't ready on this node yet.");
    expect(rec.reason).not.toContain("Loop isn't responding right now.");
    expect(rec.reason).not.toContain("Withdrawals are currently unavailable.");
  });
});
