// The auto-pay history never shows a raw alert type name for the two
// treasury-price-trust alerts; it shows their labels (DRAFT, for drive-mode
// review). The anti-vacuity half, in the same test: the labels DO render, and
// the history really lists both rows (a history that rendered nothing would
// pass "no raw name" vacuously).
//
// Slice 4 (R2): the history is in the Membership panel's "About automatic
// renewal" row (AutoRenewAbout), fed by the panel's one auto-pay read
// (useAutoRenew). R8: a failed history read says so; it is not "No auto-pay
// events yet."

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const stub = vi.hoisted(() => ({ getAutoPayConfig: vi.fn(), getAutoPayHistory: vi.fn() }));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import { AutoRenewAbout, useAutoRenew } from "./AutoPaySection";

const row = (id: number, type: string) => ({
  id, member_pubkey: "02" + "c".repeat(64), type, severity: "warning", status: "active",
  consecutive_count: 1, context: null, created_at: 1_790_000_000, updated_at: 1_790_000_000,
});

function About() {
  const auto = useAutoRenew();
  return React.createElement(AutoRenewAbout, { auto, pausesOn: 1_790_000_000_000, payBlocked: false, rate: null });
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  stub.getAutoPayConfig.mockResolvedValue({
    enabled: true, enabled_at: null, last_acknowledged_price: null, last_acknowledged_price_at: null,
    current_price: null, price_change_pending: false, status_verification: "unsigned",
    status_verification_reason: null, price_refusal: null, active_alerts: [],
    badge: { active_count: 2, highest_severity: "warning" },
  });
  stub.getAutoPayHistory.mockResolvedValue([row(1, "AUTOPAY_STATUS_UNVERIFIED"), row(2, "AUTOPAY_PAY_TARGET_REFUSED")]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
async function openHistory() {
  await act(async () => { root.render(React.createElement(About)); });
  await flush();
  const toggle = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("View auto-pay history"));
  expect(toggle, "setup: the history toggle is missing").toBeDefined();
  await act(async () => { toggle!.click(); });
  await flush();
  return host.textContent ?? "";
}

describe("auto-pay history labels (treasury-price-trust)", () => {
  it("neither raw type name renders; each label does", async () => {
    const text = await openHistory();
    expect(text, "a raw alert type name rendered in the history").not.toContain("AUTOPAY_STATUS_UNVERIFIED");
    expect(text, "a raw alert type name rendered in the history").not.toContain("AUTOPAY_PAY_TARGET_REFUSED");

    // Anti-vacuity: the history lists both rows, by their labels.
    expect(text).toContain("Auto-pay paused: couldn't confirm the price came from BitCorn");
    expect(text).toContain("Auto-pay paused: payment held for safety");
  });
});

describe("R8 — a failed history read is an error, not an empty history", () => {
  it("failed: the error shows, and 'No auto-pay events yet.' does not", async () => {
    stub.getAutoPayHistory.mockRejectedValue(new Error("Failed to fetch"));
    const text = await openHistory();
    expect(text).toContain("Couldn't load the auto-pay history.");
    expect(text).not.toContain("No auto-pay events yet.");
  });

  it("control: an empty history that loaded says 'No auto-pay events yet.'", async () => {
    stub.getAutoPayHistory.mockResolvedValue([]);
    const text = await openHistory();
    expect(text).toContain("No auto-pay events yet.");
    expect(text).not.toContain("Couldn't load the auto-pay history.");
  });
});
