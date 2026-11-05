// Drive-mode P1 item 3 (spec P1 item 3; D1.4; R15(6)): the page reads the
// rate's state from /api/exchange-rate —
//   fresh: dollars, no note;
//   stale (past 10 minutes): dollars with "Price as of <time>";
//   none (past 6 hours, or no rate): sats only, with one sentence.
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

const FETCHED = new Date("2026-11-03T15:42:00").getTime();
// The no-price sentence since drive-mode P2 item 8 (it claims no age).
const NONE_SENTENCE = "The bitcoin price isn't available right now, so amounts are shown in sats.";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getNetworkPayments.mockResolvedValue([]);
  stub.getContacts.mockResolvedValue([]);
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

async function renderWithRate(rate: unknown) {
  stub.getExchangeRate.mockResolvedValue(rate);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(Payments, { title: "Payments" })));
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  const input = host.querySelector('input[aria-label="Amount"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "100000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const asOf = "Price as of " + new Date(FETCHED).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

describe("D1.4 — the rate's state on the page", () => {
  it("fresh: dollars, and no note", async () => {
    await renderWithRate({ usd: 60_000, source: "coinbase", fetched_at: FETCHED, age_ms: 60_000, state: "fresh" });
    expect(text()).toContain("$60.00");
    expect(text()).not.toContain("Price as of");
    expect(text()).not.toContain(NONE_SENTENCE);
  });

  it("stale: dollars, with 'Price as of <time>'", async () => {
    await renderWithRate({ usd: 60_000, source: "coinbase", fetched_at: FETCHED, age_ms: 601_000, state: "stale" });
    expect(text()).toContain("$60.00");
    expect(text()).toContain(asOf);
  });

  it("none: no dollars, and the one sentence", async () => {
    await renderWithRate({ usd: null, source: "coinbase", fetched_at: FETCHED, age_ms: 21_601_000, state: "none" });
    expect(text()).not.toContain("$");
    expect(text()).toContain(NONE_SENTENCE);
  });
});
