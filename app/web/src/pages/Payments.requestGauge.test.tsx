// Drive-mode P3 (BACKLOG §2, owned by drive-mode; gate 2): Payments' Request
// tab read "Current channel · N% available to send" — a sending figure on the
// receiving form. R40(7): it shows room to receive.
//
// Harness: Payments.capacity.test.tsx's.

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

// R40(7): the Request tab's gauge is about RECEIVING, so it shows room to
// receive (364,000 of 1,000,000 here = 36%), and receiving shrinks it. The Pay
// tab keeps room to send (R34 item 5), unchanged. "Current channel" goes.
describe("P3 — the Request tab's gauge shows room to receive (R40(7))", () => {
  it("Room to receive · 36% of your connection; no 'Current channel', no 'available to send'", async () => {
    await render();
    expect(text()).toContain("Room to receive");
    expect(text()).toContain("36% of your connection");
    expect(text()).not.toContain("Current channel");
    expect(text()).not.toContain("available to send");
  });

  it("after receiving 50,000: 36% → 31% room to receive", async () => {
    await render();
    await typeAmount("50000");
    expect(text()).toMatch(/After receive: 36% → 31% room to receive/);
  });

  it("the Pay tab still reads room to send (R34 item 5)", async () => {
    await render();
    await decodeAmount(100_000);
    expect(text()).toContain("57% available to send");
    expect(text()).toMatch(/After send: 57% → 47% available to send/);
  });
});
