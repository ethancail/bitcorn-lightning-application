// PR3-7 guard: no capacity TEXT element uses --amber. Light --amber is 2.68:1
// on --bg-1, so amber marks capacity on bars and dots only; a warning's number,
// label or word is --text.
//
// Every capacity surface is rendered in its WARNING state (where amber would
// land), and every element tagged data-testid="capacity-text" is checked by its
// EFFECTIVE text colour: the first colour set on it or an ancestor, inline or
// by a class rule in styles.css. The count of checked elements is pinned, so a
// surface that stops rendering its texts cannot pass vacuously.
//
// Harnesses: capacityV11.test.tsx's and App.treasuryCapacity.test.tsx's; for
// Payments, Payments.direction.test.tsx's (PR 4 extends the guard to its send view).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cssRules } from "./styleRules.testutil";

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
  getLiquidityHealth: vi.fn(),
  getPendingChannels: vi.fn(),
  getMemberStats: vi.fn(),
  getExchangeRate: vi.fn(),
  getNodeBalances: vi.fn(),
  getTreasuryInfo: vi.fn(),
  getSwapHistory: vi.fn(),
  getNetworkPayments: vi.fn(),
  syncSettlements: vi.fn(),
  decodeInvoice: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("./components/BitcoinPriceGraph", () => ({ default: () => null }));
vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

import MemberDashboard from "./pages/MemberDashboard";
import RefillChannel from "./pages/RefillChannel";
import WithdrawBitcoin from "./pages/WithdrawBitcoin";
import Payments from "./pages/Payments";
import LiquidityLaneRow from "./components/liquidity/LiquidityLaneRow";
import LiquidityKpiBanner from "./components/liquidity/LiquidityKpiBanner";

// ── fixtures ────────────────────────────────────────────────────────────────

const stats = (localSats: number) => ({
  hub_pubkey: null, membership_status: "active", node_role: "member", is_peered_to_hub: true,
  keysend_enabled: false, lnd_live_read_ok: true, cert_expiry: null,
  treasury_channel: {
    channel_id: "1", local_sats: localSats, remote_sats: 1_000_000 - localSats, capacity_sats: 1_000_000,
    is_active: true, freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
  },
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
});
const LOOP = { loopDaemonRunning: false, loopOutAvailable: false, loopInAvailable: false, loopOutTerms: null, loopInTerms: null };
const warnStatus = (role: "merchant" | "farmer") => ({
  channelRole: role,
  classification: {
    channelId: "1", capacitySat: 1_000_000, memberLocalSat: 0, treasuryLocalSat: 0, memberLocalPct: 0,
    state: role === "merchant" ? "receive_exhausted" : "send_saturated",
    urgency: "high", consecutiveNonHealthyRuns: 3, classifiedAt: NOW, channelRole: role,
  },
  recommendation: null,
  loopAvailability: LOOP,
});

const pk = (c: string) => "02" + c.repeat(64);
const LANE_CHANNELS = [
  { channel_id: "1", peer_pubkey: pk("b"), capacity_sat: 2_000_000, local_balance_sat: 1_800_000, remote_balance_sat: 200_000, active: 1 }, // exhausted
  { channel_id: "2", peer_pubkey: pk("c"), capacity_sat: 2_000_000, local_balance_sat: 200_000, remote_balance_sat: 1_800_000, active: 1 }, // full_needs_withdrawal
  { channel_id: "3", peer_pubkey: pk("d"), capacity_sat: 2_000_000, local_balance_sat: 100_000, remote_balance_sat: 1_900_000, active: 1 }, // critical
  { channel_id: "4", peer_pubkey: pk("f"), capacity_sat: 2_000_000, local_balance_sat: 1_200_000, remote_balance_sat: 800_000, active: 1 }, // degrading
];
const LANE_CONTACTS = [
  { pubkey: pk("b"), name: "M1", tags: ["merchant"] },
  { pubkey: pk("c"), name: "F1", tags: ["farmer"] },
  { pubkey: pk("d"), name: "E1", tags: ["external"] },
  { pubkey: pk("f"), name: "M2", tags: ["merchant"] },
];
const SMALL_CHANNEL = [{ channel_id: "9", peer_pubkey: pk("e"), capacity_sat: 500_000, local_balance_sat: 250_000, remote_balance_sat: 250_000, active: 1 }];

// ── harness ─────────────────────────────────────────────────────────────────

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let channels: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getProfileAlias.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
  stub.getContacts.mockResolvedValue(LANE_CONTACTS);
  stub.getLiquidityHealth.mockResolvedValue([]);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 2_000_000, lightning_sats: 0, total_sats: 2_000_000 });
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNetworkPayments.mockResolvedValue([]);
  stub.syncSettlements.mockResolvedValue({});
  stub.decodeInvoice.mockResolvedValue({
    tokens: 100_000, destination: pk("b"), description: "", expires_at: null,
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
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

// ── the check ───────────────────────────────────────────────────────────────

const RULES = cssRules().filter((r) => r.media === null && r.decls["color"]);
/** Colour a class rule gives an element: the last top-level `.cls` rule naming color. */
function classColor(el: Element): string | null {
  let found: string | null = null;
  for (const r of RULES) {
    if (r.selectors.some((s) => el.classList.contains(s.replace(/^\./, "")) && /^\.[\w-]+$/.test(s))) found = r.decls["color"];
  }
  return found;
}
/** The first text colour set on the element or an ancestor. */
function effectiveColor(el: Element | null): string | null {
  for (let n = el; n; n = n.parentElement) {
    const inline = (n as HTMLElement).style?.color;
    if (inline) return inline;
    const c = classColor(n);
    if (c) return c;
  }
  return null;
}

function checkCapacityTexts(el: Element) {
  const texts = [...el.querySelectorAll('[data-testid="capacity-text"]')];
  const offenders = texts
    .map((t) => ({ text: t.textContent, color: effectiveColor(t), cls: t.className }))
    .filter((t) => /amber/.test(t.color ?? "") || /badge-amber/.test(String(t.cls)));
  return { count: texts.length, offenders };
}

describe("PR3-7: no capacity text element uses --amber", () => {
  it("member dashboard, merchant in warning", async () => {
    stub.getMemberStats.mockResolvedValue(stats(500_000));
    stub.getMemberLiquidityStatus.mockResolvedValue(warnStatus("merchant"));
    const r = checkCapacityTexts(await mount(page(MemberDashboard)));
    expect(r.offenders).toEqual([]);
    expect(r.count).toBe(2); // the headline's first number (the old hero, PR 6), the word
  });

  it("member dashboard, farmer in warning", async () => {
    stub.getMemberStats.mockResolvedValue(stats(900_000));
    stub.getMemberLiquidityStatus.mockResolvedValue(warnStatus("farmer"));
    const r = checkCapacityTexts(await mount(page(MemberDashboard)));
    expect(r.offenders).toEqual([]);
    expect(r.count).toBe(2);
  });

  it("Top Up, merchant in warning", async () => {
    stub.getMemberStats.mockResolvedValue(stats(100_000));
    stub.getMemberLiquidityStatus.mockResolvedValue(warnStatus("merchant"));
    const r = checkCapacityTexts(await mount(page(RefillChannel)));
    expect(r.offenders).toEqual([]);
    expect(r.count).toBe(3); // N% available to send, after top up: now → projected
  });

  it("Cash Out, farmer in warning", async () => {
    stub.getMemberStats.mockResolvedValue(stats(900_000));
    stub.getMemberLiquidityStatus.mockResolvedValue(warnStatus("farmer"));
    const r = checkCapacityTexts(await mount(page(WithdrawBitcoin)));
    expect(r.offenders).toEqual([]);
    expect(r.count).toBe(2); // N% available to withdraw, after withdrawal
  });

  it("Payments send view, a decoded invoice (PR 4)", async () => {
    stub.getMemberStats.mockResolvedValue(stats(900_000));
    const el = await mount(React.createElement(MemoryRouter, null, React.createElement(Payments, { title: "Payments" })));
    const tab = [...el.querySelectorAll("button")].find((b) => b.textContent === "Send a Payment")!;
    await act(async () => { tab.click(); });
    const box = el.querySelector('textarea[aria-label="Payment request"]') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(box, "lnbcrt1u1" + "q".repeat(60));
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 350)); }); // the 300ms decode debounce
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(stub.decodeInvoice).toHaveBeenCalled();
    const r = checkCapacityTexts(el);
    expect(r.offenders).toEqual([]);
    expect(r.count).toBe(3); // N% available to send, send capacity, after send: now → projected
  });

  it("treasury Channels, every lane in a warning state", async () => {
    channels = LANE_CHANNELS;
    stub.getNode.mockResolvedValue({ node_role: "treasury", alias: "t", pubkey: pk("a"), synced_to_chain: true });
    const App = (await import("./App")).default;
    const r = checkCapacityTexts(await mount(React.createElement(App), "/channels"));
    expect(r.offenders).toEqual([]);
    expect(r.count).toBe(8); // a % and a badge per lane
  });

  it("member Channels, \"Too small\"", async () => {
    channels = SMALL_CHANNEL;
    stub.getNode.mockResolvedValue({ node_role: "node", alias: "m", pubkey: pk("a"), synced_to_chain: true });
    stub.getMemberLiquidityStatus.mockImplementation(never);
    const App = (await import("./App")).default;
    const r = checkCapacityTexts(await mount(React.createElement(App), "/channels"));
    expect(r.offenders).toEqual([]);
    expect(r.count).toBe(1);
  });

  it("Liquidity lane rows and KPIs, warning tiers", async () => {
    const peer = (role: "merchant" | "farmer", tier: "critical" | "heavy") => ({
      pubkey: pk("b"), name: "P", role, capacity: 2_000_000, memberLocal: 0, memberRemote: 0,
      channelCount: 1, rolePct: 0.1, healthTier: tier,
    });
    const el = await mount(React.createElement("div", null,
      React.createElement(LiquidityLaneRow, { peer: peer("merchant", "critical"), isSelected: false, pulseKey: 0 }),
      React.createElement(LiquidityLaneRow, { peer: peer("farmer", "heavy"), isSelected: false, pulseKey: 0 }),
      React.createElement(LiquidityKpiBanner, { kpis: {
        totalDeployed: 4_000_000, peerCount: 2, merchantsHealthy: 0, merchantsTotal: 1, merchantsTier: "critical",
        farmersHealthy: 0, farmersTotal: 1, farmersTier: "heavy",
      } as any }),
    ));
    const r = checkCapacityTexts(el);
    expect(r.offenders).toEqual([]);
    expect(r.count).toBe(6); // word + chip per row, two KPI counts
  });

  it("the check itself sees a class rule's colour (.badge-amber → amber)", () => {
    const span = document.createElement("span");
    span.className = "badge badge-amber";
    expect(effectiveColor(span)).toBe("var(--amber)");
    span.className = "badge badge-caution";
    expect(effectiveColor(span)).toBe("var(--text)");
  });

  it("the caution badge carries its amber on the dot, its word in --text", () => {
    const rule = (sel: string) => cssRules().find((r) => r.media === null && r.selectors.includes(sel))?.decls;
    expect(rule(".badge-caution")?.["color"]).toBe("var(--text)");
    expect(rule(".badge-caution::before")?.["background"]).toBe("var(--amber)");
  });
});
