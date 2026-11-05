// drive-mode P2 item 6, D2.3: each of Loop's four unavailable states shows its
// own sentence and action; available shows nothing. Sentences are LITERALS
// here, not imported: comparing a constant to itself passes on any wording.
//
// Paired in both directions, as recommendationEngine.test.ts does for the
// same states: the PERMISSION direction (each state says its own thing, and
// the four differ) catches states collapsed onto one sentence; the REFUSAL
// direction (no cause, no internals) is asserted only beside positive content.

import { describe, it, expect } from "vitest";
import { loopAlertFor, loopAlertsFor } from "./loopAlert";
import type { LoopAvailability } from "./loopAvailability";

const UP: LoopAvailability = {
  loopDaemonRunning: true,
  loopOutAvailable: true,
  loopInAvailable: true,
  loopOutTerms: { minSats: 250_000, maxSats: 5_000_000 },
  loopInTerms: { minSats: 250_000, maxSats: 5_000_000 },
  unavailableReason: null,
};
const down = (reason: "credentials_absent" | "unreachable" | null): LoopAvailability => ({
  loopDaemonRunning: false,
  loopOutAvailable: false,
  loopInAvailable: false,
  loopOutTerms: null,
  loopInTerms: null,
  unavailableReason: reason,
});
const OUT_TERMS_FAILED: LoopAvailability = { ...UP, loopOutAvailable: false, loopOutTerms: null };
const IN_TERMS_FAILED: LoopAvailability = { ...UP, loopInAvailable: false, loopInTerms: null };

/** D3's banned claims in every state, plus daemon internals and transport words. */
const BANNED = /install|configured|expired|not set up|certificate|cert\b|loopd|daemon|gRPC|grpc|macaroon|connection refused|timeout|timed out|code \d/i;

describe("the four unavailable states, each its own sentence and action", () => {
  it("credentials absent", () => {
    expect(loopAlertFor(down("credentials_absent"), "loop_out")).toEqual({
      text: "Loop is still setting up on this node, so Withdraw isn't available yet. If this lasts more than 10 minutes, restart Bitcorn.",
      action: { label: "Check again" },
    });
    expect(loopAlertFor(down("credentials_absent"), "loop_in")!.text).toBe(
      "Loop is still setting up on this node, so Top Up isn't available yet. If this lasts more than 10 minutes, restart Bitcorn.",
    );
  });

  it("unreachable: no cause, and no restart (the cert notice owns that fault)", () => {
    expect(loopAlertFor(down("unreachable"), "loop_out")).toEqual({
      text: "Loop isn't responding right now, so Withdraw isn't available.",
      action: { label: "Check again" },
    });
    expect(loopAlertFor(down("unreachable"), "loop_in")!.text).toBe(
      "Loop isn't responding right now, so Top Up isn't available.",
    );
    expect(loopAlertFor(down("unreachable"), "loop_out")!.text).not.toMatch(/restart/i);
  });

  it("Loop Out terms failed: Withdraw only", () => {
    expect(loopAlertsFor(OUT_TERMS_FAILED)).toEqual({
      loop_out: { text: "Withdrawals are currently unavailable.", action: { label: "Try again" } },
      loop_in: null,
    });
  });

  it("Loop In terms failed: Top Up only", () => {
    expect(loopAlertsFor(IN_TERMS_FAILED)).toEqual({
      loop_out: null,
      loop_in: { text: "Top Up is currently unavailable.", action: { label: "Try again" } },
    });
  });

  it("the four states render four different sentences, in either direction", () => {
    const states = [down("credentials_absent"), down("unreachable"), OUT_TERMS_FAILED, IN_TERMS_FAILED];
    const out = states.map((s) => loopAlertFor(s, "loop_out")?.text ?? loopAlertFor(s, "loop_in")!.text);
    expect(new Set(out).size).toBe(4);
  });

  it("a daemon down with no classified reason reads as unreachable (the catch-all)", () => {
    expect(loopAlertFor(down(null), "loop_out")).toEqual(loopAlertFor(down("unreachable"), "loop_out"));
  });
});

describe("available: nothing", () => {
  it("both directions null", () => {
    expect(loopAlertsFor(UP)).toEqual({ loop_out: null, loop_in: null });
  });
});

describe("no banned claim, no internals, in any state (beside positive content)", () => {
  for (const [name, loop] of [
    ["credentials_absent", down("credentials_absent")],
    ["unreachable", down("unreachable")],
    ["Loop Out terms failed", OUT_TERMS_FAILED],
    ["Loop In terms failed", IN_TERMS_FAILED],
  ] as const) {
    it(name, () => {
      for (const d of ["loop_out", "loop_in"] as const) {
        const a = loopAlertFor(loop, d);
        if (!a) continue;
        expect(a.text.length).toBeGreaterThan(10);
        expect(a.text).not.toMatch(BANNED);
      }
    });
  }
});
