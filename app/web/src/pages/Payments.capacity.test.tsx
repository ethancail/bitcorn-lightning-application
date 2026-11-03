// Drive-mode P1 item 2 (spec P1 item 2; D1.2; R18(5)): the pay form's cap is
// the server's room to send, and the request form's is room to receive — one
// number per direction, from /api/member/stats. The 85% "Most you can …" soft
// caps are removed, and the raw local/remote balance is no longer the cap.
//
// Harness: Payments.direction.test.tsx's and capacityText.guard.test.tsx's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getNetworkPayments: vi.fn(),
  getContacts: vi.fn(),
  getExchangeRate: vi.fn(),
  syncSettlements: vi.fn(),
  getMemberStats: vi.fn(),
  decodeInvoice: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import Payments from "./Payments";

// Raw balances deliberately ABOVE the room figures, so a form that caps at the
// raw balance accepts room + 1.
const CHANNEL = {
  channel_id: "800000x1x0",
  local_sats: 600_000,
  remote_sats: 389_000,
  capacity_sats: 1_000_000,
  is_active: true,
  room_to_send_sats: 570_000,
  room_to_receive_sats: 364_000,
  local_reserve_sats: 30_000,
  remote_reserve_sats: 25_000,
  pending_outgoing_sats: 0,
  pending_incoming_sats: 0,
  commit_fee_sats: 2_810,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getNetworkPayments.mockResolvedValue([]);
  stub.getContacts.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.syncSettlements.mockResolvedValue({});
  stub.getMemberStats.mockResolvedValue({ treasury_channel: CHANNEL });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

async function render() {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(Payments, { title: "Payments" })));
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

async function typeAmount(value: string) {
  const input = host.querySelector('input[aria-label="Amount"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function decodeAmount(tokens: number) {
  stub.decodeInvoice.mockResolvedValue({
    id: "cc".repeat(32), destination: "03" + "cd".repeat(32), tokens, description: null, expires_at: null,
  });
  await act(async () => { button("Send a Payment").click(); });
  const box = host.querySelector('textarea[aria-label="Payment request"]') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "lnbcrt1u1" + "q".repeat(60));
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); }); // the 300 ms decode debounce
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(stub.decodeInvoice).toHaveBeenCalled();
}

describe("D1.2 — the pay form's cap is room to send", () => {
  it("room to send + 1 is refused by the form, naming room to send", async () => {
    await render();
    await decodeAmount(570_001);
    expect(button("Confirm & Pay").disabled).toBe(true);
    expect(text()).toContain("more than you can send (570,000 sats)");
  });

  it("exactly room to send is allowed, with no 'close to your limit' warning", async () => {
    await render();
    await decodeAmount(570_000);
    expect(button("Confirm & Pay").disabled).toBe(false);
    expect(text()).not.toContain("close to your limit");
  });

  it("the send capacity card shows room to send, and no 85% 'Most you can send' (R18(5))", async () => {
    await render();
    await decodeAmount(1_000);
    expect(text()).toContain("570,000");
    expect(text()).not.toContain("Most you can send");
    expect(text()).not.toContain((Math.floor(600_000 * 0.85)).toLocaleString()); // 510,000
  });
});

describe("the request form's cap is room to receive", () => {
  it("room to receive + 1 is refused, naming room to receive", async () => {
    await render();
    await typeAmount("364001");
    expect(button("Create Payment Request").disabled).toBe(true);
    expect(text()).toContain("exceeds receive capacity (364,000 sats)");
  });

  it("exactly room to receive is allowed, with no soft warning and no 85% 'Most you can receive'", async () => {
    await render();
    await typeAmount("364000");
    expect(button("Create Payment Request").disabled).toBe(false);
    expect(text()).not.toContain("close to your limit");
    expect(text()).not.toContain("Most you can receive");
  });
});
