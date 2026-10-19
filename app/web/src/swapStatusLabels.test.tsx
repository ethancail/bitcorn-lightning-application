// Swap-history Status labels (member-ui-fixes item 4): `quote_created` reads
// "Quoted", and a status the map doesn't know is humanized, never shown raw.
//
// quote_created reaches both histories: swapService writes it on every quote,
// Loop In and Loop Out alike, until the swap poller expires it. So Top Up
// (RefillChannel) and Cash Out (WithdrawBitcoin) share one label map.
//
// Harness: phoneTables.markup.test.tsx's (the member pages, api stubbed).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

const NOW = Date.now();
const never = () => new Promise<never>(() => {});

const stub = vi.hoisted(() => ({
  getMemberLiquidityStatus: vi.fn(),
  getMemberStats: vi.fn(),
  getExchangeRate: vi.fn(),
  getNodeBalances: vi.fn(),
  getNodeAddress: vi.fn(),
  getSwapHistory: vi.fn(),
  getSwap: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import RefillChannel from "./pages/RefillChannel";
import WithdrawBitcoin from "./pages/WithdrawBitcoin";

const pk = (c: string) => "02" + c.repeat(64);

const swap = (id: string, swapType: "loop_in" | "loop_out", status: string) => ({
  id, created_at: NOW - 3_600_000, updated_at: NOW, node_pubkey: pk("a"), role: "member", swap_type: swapType,
  direction: swapType === "loop_in" ? "chain_to_lightning" : "lightning_to_chain", status, amount_sat: 250_000,
  max_fee_sat: null, quoted_fee_sat: 1_200, actual_fee_sat: null, destination_address: null, channel_id: "1",
  quote_expires_at: null, failure_reason: null, notes: null,
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 2_000_000, lightning_sats: 0, total_sats: 2_000_000 });
  stub.getNodeAddress.mockImplementation(never);
  stub.getSwap.mockImplementation(never);
  stub.getMemberStats.mockResolvedValue({
    hub_pubkey: null, membership_status: "active", node_role: "member", is_peered_to_hub: true,
    keysend_enabled: false, lnd_live_read_ok: true, cert_expiry: null,
    treasury_channel: {
      channel_id: "1", local_sats: 500_000, remote_sats: 500_000, capacity_sats: 1_000_000,
      is_active: true, freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
    },
    forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function mount(C: React.ComponentType) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(MemoryRouter, null, React.createElement(C))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

/** The history table (the one with a Status column) and its Status cells, row by row. */
function historyStatuses(el: HTMLElement) {
  const table = [...el.querySelectorAll("table")].find((t) =>
    [...t.querySelectorAll("th")].some((th) => th.textContent === "Status"));
  expect(table, "the history table renders").toBeDefined();
  const col = [...table!.querySelectorAll("thead th")].findIndex((th) => th.textContent === "Status");
  const cells = [...table!.querySelectorAll("tbody tr")].map((tr) => tr.querySelectorAll("td")[col]?.textContent);
  return { table: table!, cells };
}

for (const [page, C, swapType] of [
  ["Top Up (RefillChannel)", RefillChannel, "loop_in"],
  ["Cash Out (WithdrawBitcoin)", WithdrawBitcoin, "loop_out"],
] as const) {
  describe(`${page}: history Status labels`, () => {
    it("quote_created reads Quoted", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap("q", swapType, "quote_created")] });
      const { cells } = historyStatuses(await mount(C));
      expect(cells).toEqual(["Quoted"]);
    });

    it("an unknown status is humanized, never raw", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap("u", swapType, "some_new_status")] });
      const { table, cells } = historyStatuses(await mount(C));
      expect(cells).toEqual(["Some new status"]);
      expect(table.textContent).not.toMatch(/[a-z]+_[a-z]+/);
    });

    it("PERMITTING: completed still reads Complete", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap("c", swapType, "completed")] });
      const { cells } = historyStatuses(await mount(C));
      expect(cells).toEqual(["Complete"]);
    });
  });
}

// The tracking panel: an in-flight swap in the history opens it on mount, and
// quote_created counts as in flight (only completed/failed/expired end it).
// A quoted swap hasn't started — the member starts it with Confirm — so it
// says so. TechnicalDetails is a <details>: its rows are in the DOM while
// collapsed, so the whole-page check covers the Protocol status row.
function trackingPanel(el: HTMLElement) {
  const panel = [...el.querySelectorAll(".panel")].find((p) =>
    /Status$/.test(p.querySelector(".panel-title")?.textContent ?? ""));
  expect(panel, "the tracking panel renders").toBeDefined();
  return panel!;
}
const protocolRow = (panel: Element) =>
  [...panel.querySelectorAll("details span")].find((s) => s.textContent === "Protocol status")?.nextElementSibling?.textContent;

for (const [page, C, swapType, sentence, initiatedRow] of [
  ["Top Up (RefillChannel)", RefillChannel, "loop_in", "Quote received. The top-up hasn't started yet.",
    "initiated — Publishing on-chain HTLC"],
  ["Cash Out (WithdrawBitcoin)", WithdrawBitcoin, "loop_out", "Quote received. The withdrawal hasn't started yet.",
    "initiated — Paying Lightning invoice to Loop server"],
] as const) {
  describe(`${page}: the tracking panel never shows a raw status`, () => {
    it("quote_created: the page's sentence, a Quoted technical row, and quote_created nowhere on the page", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap("q", swapType, "quote_created")] });
      const el = await mount(C);
      const panel = trackingPanel(el);
      expect(panel.textContent).toContain(sentence);
      expect(protocolRow(panel)).toBe("Quoted");
      expect(el.textContent).not.toContain("quote_created");
    });

    it("an unknown status is humanized in the panel too", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap("u", swapType, "some_new_status")] });
      const el = await mount(C);
      const panel = trackingPanel(el);
      expect(panel.textContent).toContain("Some new status");
      expect(protocolRow(panel)).toBe("Some new status");
      expect(el.textContent).not.toContain("some_new_status");
    });

    it("PERMITTING: a known in-flight state's Protocol status row reads as it always has", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap("i", swapType, "initiated")] });
      expect(protocolRow(trackingPanel(await mount(C)))).toBe(initiatedRow);
    });
  });
}

describe("one label map, shared", () => {
  it("neither page defines its own statusBadge", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of ["RefillChannel.tsx", "WithdrawBitcoin.tsx"]) {
      const src = readFileSync(join(__dirname, "pages", f), "utf8");
      expect(src, `${f}: the scan reads the page`).toContain("statusBadge(");
      expect(src, f).not.toMatch(/function statusBadge\(/);
    }
  });
});
