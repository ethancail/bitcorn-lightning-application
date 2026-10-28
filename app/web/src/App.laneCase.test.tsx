// The Channels page's inline lane derivation against case-mixed contacts —
// billing-pubkey-case arc (bitcorn-research
// specs/2026-10-28-billing-pubkey-case-normalization-spec.md, D2: DW-5 and
// DW-13 for the inline lane view).
//
// The channel's peer key arrives in LND's lowercase; the contact may be stored
// in any case. Before the fix an uppercase-stored merchant sat under
// "Unclassified" with a truncated key, while the backend billed it as a
// merchant. Among case twins the lane and name come from the backend's
// tie-break winner (manual, then lowest id).
//
// Harness: App.merchantLanesRemaining.test.tsx's (the REAL App), with fetch
// stubbed for the Channels page's raw /api/channels read.

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

const LOWER = "03" + "d4".repeat(32);
const UPPER = LOWER.toUpperCase();
const ABSENT = "02" + "e5".repeat(32);

const CHANNELS = [
  { channel_id: "1", peer_pubkey: LOWER, capacity_sat: 2_000_000, local_balance_sat: 1_200_000, remote_balance_sat: 800_000, active: 1 },
];

const contact = (id: number, pubkey: string, name: string, source: "manual" | "auto", tags: string[]) => ({
  id, pubkey, name, notes: null, tags, source, created_at: 0, updated_at: 0, channels: [],
});

let channels = CHANNELS;
let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  channels = CHANNELS;
  localStorage.removeItem("bitcorn_setup_done");
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
  stub.getProfileAlias.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getPendingChannels.mockResolvedValue([]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith("/api/channels") ? channels : []),
  })));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.unstubAllGlobals();
});

async function renderChannels(contacts: unknown[]) {
  stub.getContacts.mockResolvedValue(contacts);
  stub.getNode.mockResolvedValue({ node_role: "treasury", alias: "lnd-alias", pubkey: "02" + "a".repeat(64), synced_to_chain: true });
  const App = (await import("./App")).default;
  window.history.pushState({}, "", "/channels");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

/** The peer names listed in the lane panel with this title ([] if it is empty or absent). */
function namesIn(el: Element, title: string): string[] {
  const panel = [...el.querySelectorAll(".panel")].find((p) =>
    p.querySelector(".panel-title")?.textContent?.includes(title));
  if (!panel) return [];
  return [...panel.querySelectorAll("tbody td.td-primary")].map((td) => td.textContent ?? "");
}

describe("DW-5: the inline lane view classifies and names an uppercase-stored contact", () => {
  it("lists it under Merchant Lanes by its name, not under Unclassified", async () => {
    const el = await renderChannels([contact(1, UPPER, "Prairie Mill", "manual", ["merchant"])]);
    expect(namesIn(el, "Merchant Lanes")).toEqual(["Prairie Mill"]);
    expect(namesIn(el, "Unclassified")).toEqual([]);
  });

  it("ANTI-VACUITY: a channel peer with no contact is Unclassified and shown by its truncated key", async () => {
    channels = [{ ...CHANNELS[0], channel_id: "2", peer_pubkey: ABSENT }];
    const el = await renderChannels([contact(1, UPPER, "Prairie Mill", "manual", ["merchant"])]);
    expect(namesIn(el, "Unclassified")).toEqual([`${ABSENT.slice(0, 12)}…${ABSENT.slice(-6)}`]);
    expect(namesIn(el, "Merchant Lanes")).toEqual([]);
  });
});

describe("DW-13: the inline lane view takes the tie-break winner of a case-duplicate pair", () => {
  // GET /api/contacts orders by name, so the losing row ("Alpha Auto") comes first.
  const losing = contact(1, LOWER, "Alpha Auto", "auto", ["farmer"]);
  const manual = contact(2, UPPER, "Zulu Manual", "manual", ["merchant"]);

  it.each([
    ["losing row first", [losing, manual]],
    ["manual row first", [manual, losing]],
  ])("the MANUAL row's lane and name (%s)", async (_l, contacts) => {
    const el = await renderChannels(contacts);
    expect(namesIn(el, "Merchant Lanes")).toEqual(["Zulu Manual"]);
    expect(namesIn(el, "Farmer Lanes")).toEqual([]);
  });
});
