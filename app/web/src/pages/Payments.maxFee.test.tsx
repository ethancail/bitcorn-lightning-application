// Drive-mode P1 item 4 (spec P1 item 4; D1.6): before a payment is sent, the
// pay form shows the most it can cost in fees — the server's limit, 10 sats +
// 1%, rounded up (/api/network/decode → max_fee_sats) — and the confirmation
// step repeats it. The client sends no fee field.
//
// Harness: Payments.capacity.test.tsx's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { summarizePayInvoice } from "../components/actionConfirm/confirmAction";

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

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getNetworkPayments.mockResolvedValue([]);
  stub.getContacts.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.syncSettlements.mockResolvedValue({});
  stub.getMemberStats.mockImplementation(() => new Promise(() => {}));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");

async function decodeWith(maxFeeSats: number | null) {
  stub.decodeInvoice.mockResolvedValue({
    id: "cc".repeat(32), destination: "03" + "cd".repeat(32), tokens: 1_234_567,
    description: null, expires_at: null, max_fee_sats: maxFeeSats,
  });
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(Payments, { title: "Payments" })));
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  const tab = [...host.querySelectorAll("button")].find((b) => b.textContent === "Send a Payment")!;
  await act(async () => { tab.click(); });
  const box = host.querySelector('textarea[aria-label="Payment request"]') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "lnbcrt1u1" + "q".repeat(60));
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
  expect(stub.decodeInvoice).toHaveBeenCalled();
}

describe("D1.6 — the most a payment can cost, before it is sent", () => {
  it("the decoded preview shows the fee limit, rounded up, with its dollar value", async () => {
    await decodeWith(12_356);
    expect(text()).toContain("Most in fees");
    expect(text()).toContain("12,356 sats");
    expect(text()).toContain("$7.41"); // 12,356 sats at $60,000
  });

  it("no limit (the treasury's own payment) → no row", async () => {
    await decodeWith(null);
    expect(text()).not.toContain("Most in fees");
  });

  it("the confirmation summary carries the same row", () => {
    const s = summarizePayInvoice({ amountSats: 1_234_567, maxFeeSats: 12_356 });
    expect(s.rows).toContainEqual({ label: "Most in fees", value: "12,356 sats" });
  });
});
