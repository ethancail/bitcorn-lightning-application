// D3 on Payments: "Sent" leaves badge-red and "Received" leaves badge-green.
// Both are neutral badges, and an arrow carries the direction. PR3-6: the row's
// direction and status spans carry the base .badge class, which they lacked.
//
// Harness: MemberDashboard.declaredRole.test.tsx's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const payment = (id: number, direction: "send" | "receive") => ({
  id, payment_hash: String(id).repeat(64).slice(0, 64), direction, status: "succeeded",
  amount_sats: 1_000, fee_sats: 0, exchange_rate_usd: null, amount_usd: null, memo: null,
  counterparty_pubkey: null, payment_request: null, created_at: 1_700_000_000, settled_at: 1_700_000_000,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getNetworkPayments.mockResolvedValue([payment(1, "send"), payment(2, "receive")]);
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

async function render() {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(Payments, { title: "Payments" })));
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

const rows = () => [...host.querySelectorAll("tbody tr")];

describe("D3 — the direction badges", () => {
  it("Sent: a neutral badge with ↑, never red", async () => {
    await render();
    const badge = rows()[0].querySelectorAll("td")[0].firstElementChild!;
    expect(badge.textContent).toBe("↑Sent");
    expect(badge.className).toBe("badge badge-muted");
  });

  it("Received: a neutral badge with ↓, not green", async () => {
    await render();
    const badge = rows()[1].querySelectorAll("td")[0].firstElementChild!;
    expect(badge.textContent).toBe("↓Received");
    expect(badge.className).toBe("badge badge-muted");
  });

  it("PR3-6: the status cell carries the base badge class too", async () => {
    await render();
    const status = rows()[0].querySelectorAll("td")[1].firstElementChild!;
    expect(status.textContent).toBe("Success");
    expect(status.className).toBe("badge badge-green");
  });

  it("the arrow is hidden from screen readers; the word is not", async () => {
    await render();
    const glyph = rows()[0].querySelector('[aria-hidden="true"]');
    expect(glyph?.textContent).toBe("↑");
  });
});
