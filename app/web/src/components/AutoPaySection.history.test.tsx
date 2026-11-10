// The auto-pay history never shows a raw alert type name for the two
// treasury-price-trust alerts; it shows their labels (DRAFT, for drive-mode
// review). The anti-vacuity half, in the same test: the labels DO render, and
// the history really lists both rows (a history that rendered nothing would
// pass "no raw name" vacuously).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const stub = vi.hoisted(() => ({ getAutoPayConfig: vi.fn(), getAutoPayHistory: vi.fn() }));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import AutoPaySection from "./AutoPaySection";

const row = (id: number, type: string) => ({
  id, member_pubkey: "02" + "c".repeat(64), type, severity: "warning", status: "active",
  consecutive_count: 1, context: null, created_at: 1_790_000_000, updated_at: 1_790_000_000,
});

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

describe("auto-pay history labels (treasury-price-trust)", () => {
  it("neither raw type name renders; each label does", async () => {
    await act(async () => { root.render(React.createElement(AutoPaySection)); });
    await flush();
    const toggle = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("View auto-pay history"));
    expect(toggle, "setup: the history toggle is missing").toBeDefined();
    await act(async () => { toggle!.click(); });
    await flush();
    const text = host.textContent ?? "";
    expect(text, "a raw alert type name rendered in the history").not.toContain("AUTOPAY_STATUS_UNVERIFIED");
    expect(text, "a raw alert type name rendered in the history").not.toContain("AUTOPAY_PAY_TARGET_REFUSED");

    // Anti-vacuity: the history lists both rows, by their labels.
    expect(text).toContain("Auto-pay paused: couldn't confirm Bitcorn's details");
    expect(text).toContain("Auto-pay paused: payment held for safety");
  });
});
