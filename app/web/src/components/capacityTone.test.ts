// D3 / V11, R2, PR3-4, PR3-7 — the member channel's capacity tone, read from
// the Liquidity Advisor's state. Every role × state, and no classification,
// is pinned; none may come out red, and no text colour may be amber.

import { describe, it, expect } from "vitest";
import {
  capacityTone,
  capacityWord,
  CAPACITY_BAR_COLOR,
  CAPACITY_TEXT_COLOR,
  type CapacityTone,
} from "./capacityTone";
import type { MemberChannelClassification, MemberChannelRole, MemberChannelState } from "../api/client";

const STATES: MemberChannelState[] = ["healthy", "send_heavy", "send_saturated", "receive_heavy", "receive_exhausted"];
const ROLES: MemberChannelRole[] = ["merchant", "farmer", "unknown"];

const cls = (state: MemberChannelState, role: MemberChannelRole): MemberChannelClassification => ({
  channelId: "1",
  capacitySat: 1_000_000,
  memberLocalSat: 500_000,
  treasuryLocalSat: 500_000,
  memberLocalPct: 0.5,
  state,
  urgency: "medium",
  consecutiveNonHealthyRuns: 1,
  classifiedAt: 0,
  channelRole: role,
});

const EXPECTED: Record<MemberChannelRole, Record<MemberChannelState, CapacityTone>> = {
  merchant: { healthy: "good", send_heavy: "good", send_saturated: "good", receive_heavy: "warn", receive_exhausted: "warn" },
  farmer: { healthy: "good", send_heavy: "warn", send_saturated: "warn", receive_heavy: "good", receive_exhausted: "good" },
  unknown: { healthy: "neutral", send_heavy: "neutral", send_saturated: "neutral", receive_heavy: "neutral", receive_exhausted: "neutral" },
};

describe("capacityTone — the advisor's state, by role", () => {
  for (const role of ROLES) {
    for (const state of STATES) {
      it(`${role} · ${state} → ${EXPECTED[role][state]}`, () => {
        expect(capacityTone(role, cls(state, role))).toBe(EXPECTED[role][state]);
      });
    }
  }

  it("PR3-4: a declared role with no classification is neutral", () => {
    expect(capacityTone("merchant", null)).toBe("neutral");
    expect(capacityTone("farmer", undefined)).toBe("neutral");
  });
});

describe("the colours — never red; amber on the bar only (PR3-7)", () => {
  const tones: CapacityTone[] = ["good", "warn", "neutral"];
  it("no bar or text colour is red", () => {
    for (const t of tones) {
      expect(CAPACITY_BAR_COLOR[t]).not.toMatch(/red/);
      expect(CAPACITY_TEXT_COLOR[t]).not.toMatch(/red/);
    }
  });
  it("a warning's bar is amber, and its text is --text", () => {
    expect(CAPACITY_BAR_COLOR.warn).toBe("var(--amber)");
    expect(CAPACITY_TEXT_COLOR.warn).toBe("var(--text)");
  });
  it("no text colour is amber", () => {
    for (const t of tones) expect(CAPACITY_TEXT_COLOR[t]).not.toMatch(/amber/);
  });
  it("neutral is --text-3 on the bar (R2)", () => {
    expect(CAPACITY_BAR_COLOR.neutral).toBe("var(--text-3)");
  });
});

describe("capacityWord — the state in words, only for a warning", () => {
  it("merchant → Low; farmer → Getting full; otherwise none", () => {
    expect(capacityWord("merchant", "warn")).toBe("Low");
    expect(capacityWord("farmer", "warn")).toBe("Getting full");
    expect(capacityWord("merchant", "good")).toBeNull();
    expect(capacityWord("unknown", "neutral")).toBeNull();
  });
});
