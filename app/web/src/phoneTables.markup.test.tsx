// J14's hooks (PR 7) on the J2 tables: on a phone a table becomes a card, each
// value with its column's name beside it, so every body cell carries that name
// (data-label), each row names its title cell (td-primary), Top Up's Fee is
// the one secondary column (hidden while the table is one line, X4c), and
// Top Up's expanded detail row is marked as one.
//
// The J2 tables: ChannelsPage's four lane tables, Top Up's history and the
// subscription payments table. Contacts (also on J2) has no table.
//
// Harnesses: App.treasuryCapacity.test.tsx's (the REAL App at /channels) and
// capacityV11.test.tsx's (the member pages).

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
  getNode: vi.fn(),
  getBitcornName: vi.fn(),
  getProfileAlias: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getAutoBuyAlertBadge: vi.fn(),
  getDaybreakEdition: vi.fn(),
  getContacts: vi.fn(),
  getPendingChannels: vi.fn(),
  getMemberStats: vi.fn(),
  getExchangeRate: vi.fn(),
  getNodeBalances: vi.fn(),
  getTreasuryInfo: vi.fn(),
  getSwapHistory: vi.fn(),
  getSwap: vi.fn(),
  getSubscriptionPayments: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("./components/BitcoinPriceGraph", () => ({ default: () => null }));
vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

import RefillChannel from "./pages/RefillChannel";
import SubscriptionPayments from "./pages/SubscriptionPayments";

const pk = (c: string) => "02" + c.repeat(64);
const lane = (id: string, peer: string, localPct: number) => ({
  channel_id: id, peer_pubkey: peer, capacity_sat: 2_000_000,
  local_balance_sat: localPct * 20_000, remote_balance_sat: (100 - localPct) * 20_000, active: 1,
});
// One channel per lane: merchant, farmer, external, unclassified (no tag).
const CHANNELS = [lane("1", pk("b"), 40), lane("2", pk("c"), 50), lane("3", pk("d"), 50), lane("4", pk("e"), 50)];
const CONTACTS = [
  { pubkey: pk("b"), name: "Merchant1", tags: ["merchant"] },
  { pubkey: pk("c"), name: "Farmer1", tags: ["farmer"] },
  { pubkey: pk("d"), name: "Ext1", tags: ["external"] },
];

const swap = (id: string, status: string) => ({
  id, created_at: NOW - 3_600_000, updated_at: NOW, node_pubkey: pk("a"), role: "member", swap_type: "loop_in",
  direction: "in", status, amount_sat: 250_000, max_fee_sat: null, quoted_fee_sat: 1_200, actual_fee_sat: null,
  destination_address: null, channel_id: "1", quote_expires_at: null, failure_reason: null, notes: null,
});

const payment = (id: number) => ({
  id, txid: "ab".repeat(32), vout: 0, amount_sats: 50_000, amount_usd_cents_at_receipt: 3_000,
  received_at: NOW - 86_400_000, confirmed_at: NOW - 86_000_000, period_extension_days: 30,
  kind: "onchain", admin_reason: null, status: "confirmed",
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getProfileAlias.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getContacts.mockResolvedValue(CONTACTS);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 2_000_000, lightning_sats: 0, total_sats: 2_000_000 });
  stub.getTreasuryInfo.mockResolvedValue(null);
  // Finished swaps only: an in-flight one switches Top Up to its tracking view.
  stub.getSwapHistory.mockResolvedValue({ swaps: [swap("s1", "completed"), swap("s2", "failed")] });
  stub.getSwap.mockImplementation(never);
  stub.getSubscriptionPayments.mockResolvedValue({ payments: [payment(1), payment(2)] });
  stub.getMemberStats.mockResolvedValue({
    hub_pubkey: null, membership_status: "active", node_role: "member", is_peered_to_hub: true,
    keysend_enabled: false, lnd_live_read_ok: true, cert_expiry: null,
    treasury_channel: {
      channel_id: "1", local_sats: 100_000, remote_sats: 900_000, capacity_sats: 1_000_000,
      is_active: true, freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
    },
    forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (String(url).endsWith("/api/channels") ? CHANNELS : []),
  })));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.unstubAllGlobals();
});

async function mount(el: React.ReactElement, path = "/") {
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}
const page = (C: React.ComponentType) => React.createElement(MemoryRouter, null, React.createElement(C));

async function channelsTables() {
  stub.getNode.mockResolvedValue({ node_role: "treasury", alias: "t", pubkey: pk("a"), synced_to_chain: true });
  const App = (await import("./App")).default;
  const el = await mount(React.createElement(App), "/channels");
  return [...el.querySelectorAll("table")];
}

/** Every body row (detail rows aside): one td-primary, and each other cell
 *  labelled with its column's header — or bare under a header with no name. */
function checkHooks(table: HTMLTableElement) {
  const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent!.trim());
  const rows = [...table.querySelectorAll("tbody tr")].filter((tr) => !tr.classList.contains("row-detail"));
  expect(rows.length, "the table has body rows to check").toBeGreaterThan(0);
  const problems: string[] = [];
  for (const tr of rows) {
    const cells = [...tr.children] as HTMLElement[];
    expect(cells.length).toBe(heads.length);
    const primaries = cells.filter((td) => td.classList.contains("td-primary"));
    if (primaries.length !== 1) problems.push(`${tr.textContent}: ${primaries.length} td-primary`);
    cells.forEach((td, i) => {
      if (td.classList.contains("td-primary")) return;
      const want = heads[i] || null;
      if (td.getAttribute("data-label") !== want) problems.push(`column ${i} "${heads[i]}": data-label=${td.getAttribute("data-label")}`);
    });
  }
  return problems;
}
function expectHooked(table: HTMLTableElement) {
  const problems = checkHooks(table);
  expect(problems, `unhooked: ${problems.join("; ")}`).toEqual([]);
}

describe("J14 hooks: ChannelsPage's lane tables", () => {
  it("four tables — merchant, farmer, external, unclassified — every cell hooked", async () => {
    const tables = await channelsTables();
    expect(tables.length).toBe(4);
    for (const t of tables) expectHooked(t);
  });

  it("the unclassified table's nameless column stays bare (and empty, so a card drops it)", async () => {
    const tables = await channelsTables();
    const unclassified = tables[3];
    const blank = [...unclassified.querySelectorAll("tbody tr")][0].children[4];
    expect(blank.getAttribute("data-label")).toBeNull();
    expect(blank.innerHTML).toBe("");
  });

  it("the Close button sits in the labelled Action cell", async () => {
    const tables = await channelsTables();
    for (const t of tables) {
      const action = t.querySelector('tbody td[data-label="Action"]')!;
      expect(action.querySelector("button")?.textContent).toBe("Close");
    }
  });
});

describe("J14 hooks: Top Up's history", () => {
  beforeEach(() => {
    // Top Up leaves its loading stage once the advisor's read settles.
    stub.getMemberLiquidityStatus.mockResolvedValue(null);
  });

  it("Date is the title; Amount and Status labelled; Fee labelled and secondary", async () => {
    const el = await mount(page(RefillChannel));
    const table = el.querySelector("table")!;
    expectHooked(table);
    expect([...table.querySelectorAll("thead th.col-secondary")].map((th) => th.textContent)).toEqual(["Fee"]);
    expect([...table.querySelectorAll("tbody td.col-secondary")].map((td) => td.getAttribute("data-label"))).toEqual(["Fee", "Fee"]);
  });

  it("X4c: the table is .phone-fit and its wrapper the size container", async () => {
    const el = await mount(page(RefillChannel));
    const table = el.querySelector("table")!;
    expect(table.classList.contains("phone-fit")).toBe(true);
    expect(table.classList.contains("phone-card")).toBe(false);
    expect(table.parentElement!.classList.contains("phone-fit-wrap")).toBe(true);
  });

  it("an expanded row's detail row is marked row-detail and carries no label", async () => {
    const el = await mount(page(RefillChannel));
    const first = el.querySelector("tbody tr") as HTMLTableRowElement;
    await act(async () => { first.click(); });
    const detail = el.querySelector("tbody tr.row-detail");
    expect(detail, "the detail row renders").not.toBeNull();
    expect(detail!.querySelector("[data-label]")).toBeNull();
  });
});

describe("J14 hooks: subscription payments", () => {
  it("Date is the title; Amount, Transaction, Membership extended and Status labelled", async () => {
    const el = await mount(page(SubscriptionPayments));
    const table = el.querySelector("table.sub-history-table") as HTMLTableElement;
    expect(table, "the payments table renders").not.toBeNull();
    expectHooked(table);
  });
});

describe("X4b: each J2 table opts in to the phone card (R4)", () => {
  it("the four lane tables", async () => {
    const tables = await channelsTables();
    expect(tables.map((t) => t.classList.contains("phone-card"))).toEqual([true, true, true, true]);
  });

  it("subscription payments", async () => {
    const el = await mount(page(SubscriptionPayments));
    expect(el.querySelector("table")!.classList.contains("phone-card")).toBe(true);
  });
});
