// Controls for ./withdrawCtaGate.ts — C1-C4 of
// specs/2026-09-03-cashout-withdraw-cta-gate-spec.md §6, paired in both
// directions. C5 (mutation) is a run, not a file; C6 (baseline) is a query.
//
// ⚠ THE HELPER IS A NEW FILE, so these tests cannot be run against pre-fix
// code to prove the suite is capable of failing — the module does not exist
// there. That duty transfers wholly to C5's mutation run, recorded here so its
// absence is never read as an oversight.
//
// ⚠ THE ACCEPTED STRING IS ASSERTED AS A LITERAL, never by importing the
// helper's constant. Comparing a constant to itself passes on any wording at
// all, including an empty one. Same anti-vacuity reason the negatives in C4 are
// paired with a positive equality in the SAME test: ./channelStaleness.test.ts
// (the `?.text ?? ""` shape at ~:121-123) is the in-repo instance of the hole —
// a null notice yields "", and every `not.toMatch` over "" passes while
// asserting nothing.

import { describe, it, expect } from "vitest";
import { withdrawCtaGate } from "./withdrawCtaGate";
import type {
  MemberChannelClassification,
  MemberLiquidityRecommendation,
  MemberLiquidityStatusResponse,
  MemberLoopAvailability,
} from "../api/client";

// The sentence a farmer reads, character-for-character. Also the sentence
// app/api already ships at recommendationEngine.ts:416 — identical wording
// across both surfaces is the property that keeps the two safe to co-render,
// not a coincidence to be improved away.
const ACCEPTED = "Withdrawals are currently unavailable.";

// Banned vocabulary per the spec §4 MUST-NOTs. Paired with a positive in C4 —
// never asserted alone.
const BANNED = /install|configur|expired|grpc/i;

// ─── Fixtures ───────────────────────────────────────────────────────────────
//
// Fixed values throughout; nothing here reads Date.now(), so no case rots.

const FARMER: MemberChannelClassification = {
  channelId: "939318x1492x1",
  capacitySat: 1_000_000,
  memberLocalSat: 400_000,
  treasuryLocalSat: 600_000,
  memberLocalPct: 0.4,
  state: "healthy",
  urgency: "none",
  consecutiveNonHealthyRuns: 0,
  classifiedAt: 1_756_000_000_000,
  channelRole: "farmer",
};

/** The advisor's verdict for a healthy farmer below the 70% band. */
const REC_NONE: MemberLiquidityRecommendation = {
  action: "none",
  suggestedAmountSats: null,
  projectedMemberLocalPct: null,
  reason: "You have room to receive — ready to earn.",
  urgency: "none",
  loopAvailable: true,
  generatedAt: 1_756_000_000_000,
};

const loop = (running: boolean): MemberLoopAvailability => ({
  loopDaemonRunning: running,
  loopOutAvailable: running,
  loopInAvailable: running,
  loopOutTerms: running ? { minSats: 250_000, maxSats: 5_000_000 } : null,
  loopInTerms: running ? { minSats: 250_000, maxSats: 5_000_000 } : null,
});

const advisor = (
  running: boolean,
  recommendation: MemberLiquidityRecommendation | null = REC_NONE,
): MemberLiquidityStatusResponse => ({
  classification: FARMER,
  recommendation,
  loopAvailability: loop(running),
});

// ─── C1 — REFUSAL ───────────────────────────────────────────────────────────

describe("C1 — daemon reported down refuses the CTA", () => {
  it("returns enabled false AND the accepted sentence", () => {
    const gate = withdrawCtaGate(advisor(false));
    expect(gate.enabled).toBe(false);
    // Positive content asserted in the SAME test as the refusal: a helper
    // returning { enabled: false, explanation: null } would satisfy the
    // assertion above and tell the farmer nothing.
    expect(gate.explanation).toBe(ACCEPTED);
  });
});

// ─── C2 — PERMISSION — THE ONE THAT MATTERS ─────────────────────────────────

describe("C2 — healthy farmer below the band keeps the CTA", () => {
  it('daemon up + recommendation "none" leaves the CTA enabled', () => {
    // ⚠ THIS IS THE CONTROL THAT CATCHES DECISION B's REJECTED REGRESSION.
    // A gate written on `recommendation.action === "loop_out"` fails exactly
    // here: `action` is "none" for every farmer below the 70% band, so that
    // gate would disable withdrawals for a healthy farmer holding 400k sats.
    // A suite without this case has proven only half of decision B.
    const gate = withdrawCtaGate(advisor(true));
    expect(
      gate.enabled,
      "a healthy farmer whose daemon is up must keep a live CTA — if this " +
        "failed, the gate is reading the recommendation, not the daemon flag",
    ).toBe(true);
    expect(gate.explanation).toBeNull();
  });

  it("stays enabled even when the recommendation is absent entirely", () => {
    expect(withdrawCtaGate(advisor(true, null)).enabled).toBe(true);
  });
});

// ─── C3 — NULL STATE, and the rest of the unknown-signal family ─────────────

describe("C3 — an unknown signal fails OPEN", () => {
  it("advisor null (first poll not yet resolved) leaves the CTA enabled", () => {
    const gate = withdrawCtaGate(null);
    expect(
      gate.enabled,
      "fail-closed on null would disable every farmer's withdrawals for up " +
        "to one 60s poll interval on every page load",
    ).toBe(true);
    expect(gate.explanation).toBeNull();
  });

  // The two adjacent shapes of the same decision. A mutation can satisfy the
  // null case above and still collapse these into a refusal, which is why the
  // predicate turns on an explicit `false` rather than on falsiness.
  it("an undefined daemon flag is unknown, not down", () => {
    const wire = {
      classification: FARMER,
      recommendation: REC_NONE,
      loopAvailability: { ...loop(true), loopDaemonRunning: undefined },
    } as unknown as MemberLiquidityStatusResponse;
    expect(withdrawCtaGate(wire).enabled).toBe(true);
  });

  it("a missing loopAvailability object is unknown, not down", () => {
    // The type promises this object; a server response is not the type. The
    // helper optional-chains it for that reason, and this pins the choice.
    const wire = {
      classification: FARMER,
      recommendation: REC_NONE,
    } as unknown as MemberLiquidityStatusResponse;
    expect(withdrawCtaGate(wire).enabled).toBe(true);
  });
});

// ─── C4 — THE MUST-NOTs, PAIRED ─────────────────────────────────────────────

describe("C4 — the refusal sentence names no cause", () => {
  it("matches the accepted string exactly and none of the banned vocabulary", () => {
    const gate = withdrawCtaGate(advisor(false));
    // The positive FIRST, in this same test. Without it the negative below is
    // satisfied by a helper that returns no explanation at all.
    expect(gate.explanation).toBe(ACCEPTED);
    expect(gate.explanation).not.toMatch(BANNED);
  });

  it("the ban pattern can actually match (anti-vacuity)", () => {
    // Guards the check above against a regex that matches nothing, in which
    // case C4's negative would pass on any sentence whatsoever.
    expect("Loop is not installed on this node").toMatch(BANNED);
    expect(ACCEPTED).not.toMatch(BANNED);
  });
});
