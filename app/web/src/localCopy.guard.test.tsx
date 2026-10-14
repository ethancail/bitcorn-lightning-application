// SH8, SH8a and R2 (PR 7): no member-facing "local". Top Up and Payments say
// "available to send", Cash Out says "available to withdraw", and the
// unknown-role gauge says "on your side — on the hub's side".
//
// Two checks: a scan of the page sources for the old wording (it reaches the
// quote panel's strip, which only renders after a live quote), and each
// surface rendered in the state that shows its percentage, with the new words
// present and no "local" left in what the member reads.
//
// Harness: capacityText.guard.test.tsx's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const NOW = Date.now();
const never = () => new Promise<never>(() => {});

const stub = vi.hoisted(() => ({
  getBitcornName: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getPendingChannels: vi.fn(),
  getMemberStats: vi.fn(),
  getExchangeRate: vi.fn(),
  getNodeBalances: vi.fn(),
  getTreasuryInfo: vi.fn(),
  getSwapHistory: vi.fn(),
  getNetworkPayments: vi.fn(),
  syncSettlements: vi.fn(),
  decodeInvoice: vi.fn(),
  getContacts: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("./components/BitcoinPriceGraph", () => ({ default: () => null }));

import MemberDashboard from "./pages/MemberDashboard";
import RefillChannel from "./pages/RefillChannel";
import WithdrawBitcoin from "./pages/WithdrawBitcoin";
import Payments from "./pages/Payments";

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
const status = (role: "merchant" | "farmer" | "unknown") => ({
  channelRole: role, classification: null, recommendation: null, loopAvailability: LOOP,
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 2_000_000, lightning_sats: 0, total_sats: 2_000_000 });
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNetworkPayments.mockResolvedValue([]);
  stub.syncSettlements.mockResolvedValue({});
  stub.getContacts.mockResolvedValue([]);
  stub.decodeInvoice.mockResolvedValue({ tokens: 100_000, destination: "02" + "b".repeat(64), description: "", expires_at: null });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function mount(C: React.ComponentType<any>, props: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(MemoryRouter, null, React.createElement(C, props))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

async function settle(ms = 0) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** What the member reads: the text, with no "local" as a word. */
function expectNoLocal(el: Element) {
  expect(el.textContent ?? "").not.toMatch(/\blocal\b/i);
}

describe("SH8/SH8a/R2: the old wording is gone from the sources", () => {
  const PAGES = join(__dirname, "pages");
  const files = readdirSync(PAGES)
    .filter((n) => /\.tsx$/.test(n) && !n.includes(".test."))
    .map((n) => join(PAGES, n))
    .filter((p) => statSync(p).isFile());

  it("no page renders \"N% local\", \"</span> local\" or \"local — remote\"", () => {
    expect(files.length, "the scan sees the pages").toBeGreaterThan(10);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/(%|<\/span>)\s*local\b|% local —|% remote`/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the new wording sits at each site: Top Up 3, Payments 4, Cash Out 2, the gauge 1", () => {
    const count = (file: string, re: RegExp) => (readFileSync(join(PAGES, file), "utf8").match(re) ?? []).length;
    expect(count("RefillChannel.tsx", /(%|<\/span>) available to send$/gm)).toBe(3);
    expect(count("Payments.tsx", /% available to send$/gm)).toBe(4);
    expect(count("WithdrawBitcoin.tsx", /% available to withdraw$/gm)).toBe(2);
    expect(count("MemberDashboard.tsx", /% on your side — \$\{remotePct\}% on the hub's side`/g)).toBe(1);
  });
});

describe("SH8/SH8a/R2: each surface as the member reads it", () => {
  it("Top Up: \"N% available to send\" and \"After top up: N% → M% available to send\"", async () => {
    stub.getMemberStats.mockResolvedValue(stats(100_000));
    stub.getMemberLiquidityStatus.mockResolvedValue(status("merchant"));
    const el = await mount(RefillChannel);
    expect(el.textContent).toContain("10% available to send");
    expect(el.textContent).toMatch(/After top up: 10% → 35%\s*available to send/);
    expectNoLocal(el);
  });

  it("Cash Out: \"N% available to withdraw\", and after the withdrawal", async () => {
    stub.getMemberStats.mockResolvedValue(stats(900_000));
    stub.getMemberLiquidityStatus.mockResolvedValue(status("farmer"));
    const el = await mount(WithdrawBitcoin);
    expect(el.textContent).toContain("90% available to withdraw");
    expect(el.textContent).toMatch(/After withdrawal: 90% → \d+% available to withdraw/);
    expectNoLocal(el);
  });

  it("Payments, receive: the channel and \"After receive\" say available to send", async () => {
    stub.getMemberStats.mockResolvedValue(stats(100_000));
    const el = await mount(Payments, { title: "Payments" });
    type(el.querySelector('input[aria-label="Amount"]') as HTMLInputElement, "50000");
    await settle();
    expect(el.textContent).toContain("10% available to send");
    expect(el.textContent).toMatch(/After receive: 10% → 15% available to send/);
    expectNoLocal(el);
  });

  it("Payments, send: the channel and \"After send\" say available to send", async () => {
    stub.getMemberStats.mockResolvedValue(stats(900_000));
    const el = await mount(Payments, { title: "Payments" });
    const tab = [...el.querySelectorAll("button")].find((b) => b.textContent === "Send a Payment")!;
    await act(async () => { tab.click(); });
    type(el.querySelector('textarea[aria-label="Payment request"]') as HTMLTextAreaElement, "lnbcrt1u1" + "q".repeat(60));
    await settle(350); // the 300ms decode debounce
    expect(stub.decodeInvoice).toHaveBeenCalled();
    expect(el.textContent).toContain("90% available to send");
    expect(el.textContent).toMatch(/After send: 90% → 80% available to send/);
    expectNoLocal(el);
  });

  it("the unknown-role gauge: \"N% on your side — M% on the hub's side\"", async () => {
    stub.getMemberStats.mockResolvedValue(stats(300_000));
    stub.getMemberLiquidityStatus.mockResolvedValue(status("unknown"));
    const el = await mount(MemberDashboard);
    expect(el.textContent).toContain("30% on your side — 70% on the hub's side");
    expectNoLocal(el);
  });
});
