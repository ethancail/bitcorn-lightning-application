// Capacity colour on a member node — D3 / V11: capacity is never red.
//
// The tone is read from the Liquidity Advisor's state (/api/liquidity/status →
// classification.state), never recomputed here from a percentage. The state
// says which side the balance sits on, not whether that is good, so the role
// decides which states are a warning:
//   merchant — low local (receive_heavy, receive_exhausted): little left to send
//   farmer   — high local (send_heavy, send_saturated): getting full, time to withdraw
// R2 and PR3-4: an unknown role, or no classification at all (the treasury
// channel is inactive), gets a neutral bar.
//
// PR3-7: amber goes on bars and dots only, never on text — light --amber is
// 2.68:1 on --bg-1. A warning's number stays in --text, and capacityWord names
// the state in --text beside it.

import type { MemberChannelClassification, MemberChannelRole } from "../api/client";

export type CapacityTone = "good" | "warn" | "neutral";

export function capacityTone(
  role: MemberChannelRole,
  classification: MemberChannelClassification | null | undefined,
): CapacityTone {
  if (!classification || role === "unknown") return "neutral";
  const s = classification.state;
  if (role === "merchant") return s === "receive_heavy" || s === "receive_exhausted" ? "warn" : "good";
  return s === "send_heavy" || s === "send_saturated" ? "warn" : "good";
}

export const CAPACITY_BAR_COLOR: Record<CapacityTone, string> = {
  good: "var(--green)",
  warn: "var(--amber)",
  neutral: "var(--text-3)",
};

export const CAPACITY_TEXT_COLOR: Record<CapacityTone, string> = {
  good: "var(--green)",
  warn: "var(--text)",
  neutral: "var(--text)",
};

/** The word that says a warning in --text, since its colour no longer can. */
export function capacityWord(role: MemberChannelRole, tone: CapacityTone): string | null {
  if (tone !== "warn") return null;
  return role === "farmer" ? "Getting full" : "Low";
}
