// The Merchant Lanes column that read "Forwarded" reads "Remaining" — decision
// B, bitcorn-research
// decisions/2026-10-22-merchant-lanes-forwarded-column-relabelled-remaining.md;
// the text is Ethan's pick.
//
// The value never changed: remote_balance_sat, the merchant's remaining
// spendable sats — the sats form of the "Forwarding Left" % beside it. Only the
// label was wrong: nothing in that cell is a forwarded total. So:
//   - no "Forwarded" header and no "Forwarded" phone-card data-label remain in
//     Merchant Lanes (forbidding);
//   - "Remaining" carries remote_balance_sat's value, "Forwarding Left" still
//     shows its %, and the Farmer table's "Accumulated" is untouched
//     (permitting).
//
// Harness: App.treasuryCapacity.test.tsx's (the REAL App), with fetch stubbed
// for the Channels page's raw /api/channels read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

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
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

const pk = (c: string) => "02" + c.repeat(64);
const MERCHANT = pk("b"), FARMER = pk("c");

const CHANNELS = [
  // 60% treasury-local → Forwarding Left 40%; remote 800,000 is the Remaining value.
  { channel_id: "1", peer_pubkey: MERCHANT, capacity_sat: 2_000_000, local_balance_sat: 1_200_000, remote_balance_sat: 800_000, active: 1 },
  // Farmer: remote 1,700,000 is the Accumulated value.
  { channel_id: "2", peer_pubkey: FARMER, capacity_sat: 2_000_000, local_balance_sat: 300_000, remote_balance_sat: 1_700_000, active: 1 },
];
const CONTACTS = [
  { pubkey: MERCHANT, name: "Merchant1", tags: ["merchant"] },
  { pubkey: FARMER, name: "Farmer1", tags: ["farmer"] },
];

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
  stub.getProfileAlias.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getContacts.mockResolvedValue(CONTACTS);
  stub.getPendingChannels.mockResolvedValue([]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
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

async function renderChannels() {
  stub.getNode.mockResolvedValue({ node_role: "treasury", alias: "lnd-alias", pubkey: pk("a"), synced_to_chain: true });
  const App = (await import("./App")).default;
  window.history.pushState({}, "", "/channels");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

function lanesTable(el: Element, title: string) {
  const panel = [...el.querySelectorAll(".panel")].find((p) =>
    p.querySelector(".panel-title")?.textContent?.includes(title));
  expect(panel, `the ${title} panel renders`).toBeDefined();
  const table = panel!.querySelector("table");
  expect(table, `the ${title} table renders`).not.toBeNull();
  return table!;
}

const headers = (table: Element) => [...table.querySelectorAll("thead th")].map((th) => th.textContent);
const cell = (table: Element, label: string) => table.querySelector(`tbody tr td[data-label="${label}"]`);

describe('decision B: Merchant Lanes "Forwarded" reads "Remaining", same value', () => {
  it('FORBIDDING: no "Forwarded" header or phone-card data-label in Merchant Lanes', async () => {
    const merchant = lanesTable(await renderChannels(), "Merchant Lanes");
    expect.soft(headers(merchant)).not.toContain("Forwarded");
    expect.soft(cell(merchant, "Forwarded"), 'no td[data-label="Forwarded"]').toBeNull();
  });

  it('PERMITTING: "Remaining" shows remote_balance_sat; "Forwarding Left" shows its %; Farmer "Accumulated" is unchanged', async () => {
    const el = await renderChannels();
    const merchant = lanesTable(el, "Merchant Lanes");
    expect(headers(merchant)).toEqual(["Merchant", "Capacity", "Remaining", "Forwarding Left", "State", "Action"]);
    expect(cell(merchant, "Remaining")?.textContent?.trim()).toBe((800_000).toLocaleString());
    expect(cell(merchant, "Forwarding Left")?.textContent?.trim()).toBe("40%");

    const farmer = lanesTable(el, "Farmer Lanes");
    expect(headers(farmer)).toContain("Accumulated");
    expect(cell(farmer, "Accumulated")?.textContent?.trim()).toBe((1_700_000).toLocaleString());
  });
});
