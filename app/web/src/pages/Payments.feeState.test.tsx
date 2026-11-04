// Drive-mode P1 item 5 (spec P1 item 5; D1.7): a zero-fee, a pending and a
// failed payment each render differently in the history's Fee column. Before,
// all three showed "—" (`p.fee_sats > 0 ? … : "—"`).
//
// Harness: Payments.direction.test.tsx's.

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
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import Payments from "./Payments";

const send = (id: number, status: string, fee_sats: number, fee_state: string) => ({
  id, payment_hash: String(id).repeat(64).slice(0, 64), direction: "send", status,
  amount_sats: 1_000, fee_sats, fee_state, exchange_rate_usd: null, amount_usd: null, memo: `m${id}`,
  counterparty_pubkey: null, payment_request: null, created_at: 1_700_000_000, settled_at: null,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getNetworkPayments.mockResolvedValue([
    send(1, "succeeded", 0, "zero"),
    send(2, "pending", 0, "pending"),
    send(3, "failed", 0, "failed"),
    send(4, "succeeded", 7, "paid"),
  ]);
  stub.getContacts.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
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

async function feeCells(): Promise<Record<string, string>> {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(Payments, { title: "Payments" })));
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  const headers = [...host.querySelectorAll("thead th")].map((th) => th.textContent?.trim());
  const feeCol = headers.indexOf("Fee");
  expect(feeCol, "the history table has a Fee column").toBeGreaterThan(-1);
  const out: Record<string, string> = {};
  for (const tr of host.querySelectorAll("tbody tr")) {
    const cells = [...tr.querySelectorAll("td")].map((td) => (td.textContent ?? "").trim());
    const memo = cells.find((c) => /^m\d$/.test(c));
    if (memo) out[memo] = cells[feeCol];
  }
  return out;
}

describe("D1.7 — zero, pending and failed render differently", () => {
  it("three different strings, and none of the three is a bare '—'", async () => {
    const c = await feeCells();
    expect(Object.keys(c).sort()).toEqual(["m1", "m2", "m3", "m4"]);
    const three = [c.m1, c.m2, c.m3];
    expect(new Set(three).size).toBe(3);
    for (const s of three) expect(s).not.toBe("—");
  });

  it("a paid fee still shows its amount", async () => {
    const c = await feeCells();
    expect(c.m4).toContain("7");
  });
});
