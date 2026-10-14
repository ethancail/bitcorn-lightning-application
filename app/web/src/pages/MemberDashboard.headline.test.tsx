// PR 6 on the member dashboard:
//   H2    — the headline numbers come first, per DECLARED role (SH9, so an
//           inactive channel keeps them): farmer "Available to withdraw" then
//           "Room to receive"; merchant "Available to send" then "Total";
//           unknown "Your balance" then "Room to receive" (P6-7). No channel:
//           "—" with "No channel yet", never 0.
//   CHART — the price chart is the section immediately beneath them.
//   J9/J9a — the subscription banner takes the top slot only when it says
//           payments are refused or a close is coming (P6-3); the name prompt
//           takes the info slot.
//   J7    — the farmer's lifetime received sits in the detail, never the
//           headline; a missing field reads "—", never 0 (P6-1).
//
// Harness: MemberDashboard.declaredRole.test.tsx's; the chart is a marker.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const NOW = Date.now();

const stub = vi.hoisted(() => ({
  getMemberStats: vi.fn(),
  getPendingChannels: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getExchangeRate: vi.fn(),
  getNodeBalances: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getTreasuryInfo: vi.fn(),
  getBitcornName: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/BitcoinPriceGraph", () => ({
  default: () => React.createElement("div", { className: "panel price-tile", "data-testid": "price-chart" }),
}));

import MemberDashboard from "./MemberDashboard";

const never = () => new Promise<never>(() => {});

const CHANNEL = {
  channel_id: "1",
  local_sats: 640_000,
  remote_sats: 360_000,
  capacity_sats: 1_000_000,
  is_active: true,
  freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
};

const memberStats = (o: { channel?: typeof CHANNEL | null; active?: boolean; lifetime?: number | undefined } = {}) => {
  const channel = o.channel === null ? null : { ...(o.channel ?? CHANNEL), is_active: o.active ?? true };
  return {
    hub_pubkey: null,
    membership_status: "active_member",
    node_role: "member",
    is_peered_to_hub: true,
    keysend_enabled: false,
    lnd_live_read_ok: true,
    cert_expiry: null,
    treasury_channel: channel,
    forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
    ...("lifetime" in o ? (o.lifetime === undefined ? {} : { lifetime_received_sats: o.lifetime }) : { lifetime_received_sats: 2_468_000 }),
  };
};

const LOOP = { loopDaemonRunning: false, loopOutAvailable: false, loopInAvailable: false, loopOutTerms: null, loopInTerms: null };

/** What /api/liquidity/status returns: the declared role, with a
 *  classification only while the channel is active (SH9). */
const advisor = (channelRole: "merchant" | "farmer" | "unknown", active = true) => ({
  channelRole,
  classification: active && channelRole !== "unknown"
    ? { channelRole, state: "healthy", localPct: 64, remotePct: 36 }
    : null,
  recommendation: null,
  loopAvailability: LOOP,
});

const subscription = (current_tier: string) => ({
  applicable: true,
  member_pubkey: "03" + "a".repeat(64),
  current_tier,
  paid_through: NOW - 31 * 86_400_000,
  price_sats: 50_000,
  period_days: 30,
  deposit_address: "bcrt1qexample",
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: 0, routing_until: 0, close_at: 0 },
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue(memberStats());
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 100_000, lightning_sats: 640_000, total_sats: 740_000 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function renderDashboard() {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(MemberDashboard)));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

const labels = () => [...host.querySelectorAll(".headline .hl-label")].map((e) => e.textContent);
const nums = () => [...host.querySelectorAll(".headline .hl-num")].map((e) => e.textContent);
const subs = () => [...host.querySelectorAll(".headline .hl-sub")].map((e) => e.textContent);

/** The dashboard's sections in order, skipping empty slots (they render
 *  nothing: .dash-notices:empty and .headline-status:empty are display:none). */
function sections(): Element[] {
  const dash = host.querySelector(".dash")!;
  return [...dash.children].filter(
    (c) => !((c.classList.contains("headline-status") || c.classList.contains("dash-notices")) && c.childElementCount === 0),
  );
}

describe("H2: the member's headline numbers, per declared role", () => {
  it("farmer: available to withdraw, then room to receive", async () => {
    await renderDashboard();
    expect(labels()).toEqual(["Available to withdraw", "Room to receive"]);
    expect(nums()).toEqual(["640,000", "360,000"]);
  });

  it("merchant: available to send, then the total", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("merchant"));
    await renderDashboard();
    expect(labels()).toEqual(["Available to send", "Total"]);
    expect(nums()).toEqual(["640,000", "740,000"]);
  });

  it("unknown role (P6-7): your balance, then room to receive", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("unknown"));
    await renderDashboard();
    expect(labels()).toEqual(["Your balance", "Room to receive"]);
  });

  it("SH9: a declared farmer whose channel is inactive keeps the farmer's headline", async () => {
    stub.getMemberStats.mockResolvedValue(memberStats({ active: false }));
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer", false));
    await renderDashboard();
    expect(labels()).toEqual(["Available to withdraw", "Room to receive"]);
  });

  it("SH9: a declared merchant whose channel is inactive keeps the merchant's headline", async () => {
    stub.getMemberStats.mockResolvedValue(memberStats({ active: false }));
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("merchant", false));
    await renderDashboard();
    expect(labels()).toEqual(["Available to send", "Total"]);
  });

  it("no channel (P6-7): \"—\" with \"No channel yet\", never 0", async () => {
    stub.getMemberStats.mockResolvedValue(memberStats({ channel: null }));
    await renderDashboard();
    expect(nums()[0]).toBe("—");
    expect(subs()[0]).toBe("No channel yet");
    expect(nums()).not.toContain("0");
  });

  it("an empty channel side is a real 0, shown as 0", async () => {
    stub.getMemberStats.mockResolvedValue(memberStats({ channel: { ...CHANNEL, local_sats: 0, remote_sats: 1_000_000 } }));
    await renderDashboard();
    expect(nums()).toEqual(["0", "1,000,000"]);
  });

  it("the headline comes right after the page header", async () => {
    await renderDashboard();
    const s = sections();
    const h = s.findIndex((e) => e.classList.contains("dash-header"));
    expect(s[h + 1].classList.contains("headline")).toBe(true);
  });
});

describe("CHART: the price chart sits immediately beneath the headline numbers", () => {
  for (const role of ["farmer", "merchant", "unknown"] as const) {
    it(`for a ${role}`, async () => {
      stub.getMemberLiquidityStatus.mockResolvedValue(advisor(role));
      await renderDashboard();
      const s = sections();
      const i = s.findIndex((e) => e.classList.contains("headline"));
      expect(s[i + 1].getAttribute("data-testid")).toBe("price-chart");
    });
  }

  it("with no channel", async () => {
    stub.getMemberStats.mockResolvedValue(memberStats({ channel: null }));
    await renderDashboard();
    const s = sections();
    const i = s.findIndex((e) => e.classList.contains("headline"));
    expect(s[i + 1].getAttribute("data-testid")).toBe("price-chart");
  });
});

describe("J9 / J9a (P6-3): the notice slots", () => {
  const slotText = (cls: string) => host.querySelector(`.dash > .${cls}`)!.textContent ?? "";

  it("routing_lapsed — payments refused — takes the top slot", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(subscription("routing_lapsed"));
    await renderDashboard();
    expect(slotText("dash-notices-top")).toContain("Urgent: routing access blocked");
    expect(slotText("dash-notices-info")).not.toContain("routing access blocked");
  });

  it("close_due — a close is coming — takes the top slot", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(subscription("close_due"));
    await renderDashboard();
    expect(slotText("dash-notices-top")).toContain("Critical: channel close imminent");
  });

  it("worker_lapsed takes the info slot, below the headline on a phone", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(subscription("worker_lapsed"));
    await renderDashboard();
    expect(slotText("dash-notices-info")).toContain("Action needed: hosted services lapsed");
    expect(slotText("dash-notices-top")).not.toContain("hosted services lapsed");
  });

  it("the name prompt takes the info slot", async () => {
    stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
    await renderDashboard();
    expect(host.querySelector(".dash > .dash-notices-info .alert.info")).not.toBeNull();
    expect(host.querySelector(".dash > .dash-notices-top .alert.info")).toBeNull();
  });
});

describe("J7 (P6-1): the farmer's lifetime received", () => {
  const lifetime = () => host.querySelector('[data-testid="lifetime-received"]');

  it("sits in the detail, labelled \"Received, lifetime\"", async () => {
    await renderDashboard();
    expect(lifetime()!.textContent).toBe("2,468,000sats");
    expect(lifetime()!.closest(".kv")!.textContent).toContain("Received, lifetime");
    expect(lifetime()!.closest(".dash-grid")).not.toBeNull();
  });

  it("is never a headline number", async () => {
    await renderDashboard();
    expect(nums()).not.toContain("2,468,000");
    expect(host.querySelector(".headline")!.textContent).not.toContain("Received");
  });

  it("a missing field reads \"—\", never 0", async () => {
    stub.getMemberStats.mockResolvedValue(memberStats({ lifetime: undefined }));
    await renderDashboard();
    expect(lifetime()!.textContent).toBe("—sats");
  });

  it("a real zero reads 0", async () => {
    stub.getMemberStats.mockResolvedValue(memberStats({ lifetime: 0 }));
    await renderDashboard();
    expect(lifetime()!.textContent).toBe("0sats");
  });

  it("is the farmer's only: a merchant's detail does not show it", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("merchant"));
    await renderDashboard();
    expect(lifetime()).toBeNull();
  });
});
