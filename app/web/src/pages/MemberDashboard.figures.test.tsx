// drive-mode P2, below the price chart:
//   item 2 — the gauges read P1's figures: the farmer's "Room to receive" is
//            room_to_receive_sats / capacity, the merchant's "Room to send" is
//            room_to_send_sats / capacity; a percentage and the bar, no sats.
//   item 3 — D2.1: no figure appears twice on one dashboard screen, counting
//            only what renders with every <details> closed (R27(4)).
//   item 4 — Your Node: dollars first, sats underneath in .kv-meta, from P1's
//            rate states (R27(3), the interim).
//   R27(10) — the farmer's client-side "Estimated fee: ~X sats" guess is gone.
//
// Harness: MemberDashboard.headline.test.tsx's; the chart is a marker.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

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
  getSwapLimits: vi.fn(),
  getMemberCosts: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/BitcoinPriceGraph", () => ({
  default: () => React.createElement("div", { "data-testid": "price-chart" }),
}));

import MemberDashboard from "./MemberDashboard";

const never = () => new Promise<never>(() => {});
const NOW = 1_790_000_000_000;

// Reserves of 10,000 per side, so P1's room figures differ from the raw sides
// (35% vs 36% to receive, 63% vs 64% to send).
const CHANNEL = {
  channel_id: "1",
  local_sats: 640_000,
  remote_sats: 360_000,
  capacity_sats: 1_000_000,
  is_active: true,
  room_to_send_sats: 630_000,
  room_to_receive_sats: 350_000,
  local_reserve_sats: 10_000,
  remote_reserve_sats: 10_000,
  pending_outgoing_sats: 0,
  pending_incoming_sats: 0,
  commit_fee_sats: null,
  freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
};

const stats = (channel: Partial<typeof CHANNEL> = {}) => ({
  hub_pubkey: null,
  membership_status: "active_member",
  node_role: "member",
  is_peered_to_hub: true,
  keysend_enabled: false,
  lnd_live_read_ok: true,
  cert_expiry: null,
  treasury_channel: { ...CHANNEL, ...channel },
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
  lifetime_received_sats: 2_468_000,
});

const LOOP = {
  loopDaemonRunning: true,
  loopOutAvailable: true,
  loopInAvailable: true,
  loopOutTerms: { minSats: 250_000, maxSats: 5_000_000 },
  loopInTerms: { minSats: 250_000, maxSats: 5_000_000 },
};

const advisor = (channelRole: "merchant" | "farmer" | "unknown") => ({
  channelRole,
  classification: channelRole === "unknown"
    ? null
    : { channelRole, state: "healthy", urgency: "none", memberLocalPct: 64 },
  recommendation: null,
  loopAvailability: LOOP,
});

const FRESH = { usd: 60_000, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" };

// GET /api/member/costs. 42 + 4,000 = 4,042 sats; at $60,000, $2.43.
const COSTS = { since_ms: NOW - 30 * 86_400_000, payment_fees_sat: 42, withdraw_fees_sat: 4_000, topup_fees_sat: 0, total_sat: 4_042 };
const NONE = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getMemberStats.mockResolvedValue(stats());
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue(FRESH);
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 100_000, lightning_sats: 640_000, total_sats: 740_000 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getSwapLimits.mockResolvedValue({ loop_available: true, loop_out: { min_sats: 250_000 }, loop_in: { min_sats: 250_000 } });
  stub.getMemberCosts.mockResolvedValue(COSTS);
  stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
});

async function renderDashboard() {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(MemberDashboard)));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

/** The text a member sees with every <details> closed: a closed <details>
 *  contributes its <summary> only (R27(4): "one tap down" is not on screen). */
function visibleText(node: Node = host): string {
  return rawVisible(node).replace(/\s+/g, " ");
}
// Elements are space-separated (two cells never fuse into one number);
// adjacent text nodes are not (JSX splits one sentence into several).
function rawVisible(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  if (el.tagName === "DETAILS" && !(el as HTMLDetailsElement).open) {
    const summary = el.querySelector(":scope > summary");
    return summary ? ` ${summary.textContent} ` : " ";
  }
  return ` ${[...el.childNodes].map(rawVisible).join("")} `;
}

/** The figures on screen: every dollar amount, and every sats-sized number
 *  (1,000 and up). Smaller numbers — percentages, "1–3" confirmations — are
 *  not money figures and may legitimately coincide. */
function figures(): string[] {
  const tokens = visibleText().match(/\$\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?/g) ?? [];
  return tokens.filter((t) => t.startsWith("$") || Number(t.replace(/,/g, "")) >= 1_000);
}

function duplicates(list: string[]): string[] {
  return [...new Set(list.filter((t, i) => list.indexOf(t) !== i))];
}

const gauge = () => host.querySelector(".member-gauge") as HTMLElement;
const gaugeLabel = () => host.querySelector("[data-testid='gauge-label']")!.firstChild!.textContent;
const gaugeFigure = () => gauge().querySelector(".labels")!.children[1].textContent;
const barWidth = () => (host.querySelector(".member-gauge [data-testid='capacity-bar']") as HTMLElement).style.width;

/** Your Node's row for a label: its value and its .kv-meta line(s). */
function yourNodeRow(label: string) {
  const panel = [...host.querySelectorAll(".panel")].find((p) => p.querySelector(".panel-title")?.textContent?.includes("Your Node"))!;
  const row = [...panel.querySelectorAll(".kv")].find((k) => k.querySelector(".kv-label")?.textContent === label);
  if (!row) return null;
  return {
    value: row.querySelector(".kv-value")!.textContent,
    meta: [...row.querySelectorAll(".kv-meta")].map((m) => m.textContent),
  };
}

describe("item 2: the gauges read P1's room figures", () => {
  it("farmer: \"Room to receive\", room_to_receive / capacity, a percentage and no sats", async () => {
    await renderDashboard();
    expect(gaugeLabel()).toBe("Room to receive");
    expect(gauge().getAttribute("aria-valuenow")).toBe("35");
    expect(barWidth()).toBe("35%");
    expect(gaugeFigure()).toBe("35% of your connection");
  });

  it("merchant: \"Room to send\", room_to_send / capacity, a percentage and no sats", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("merchant"));
    await renderDashboard();
    expect(gaugeLabel()).toBe("Room to send");
    expect(gauge().getAttribute("aria-valuenow")).toBe("63");
    expect(barWidth()).toBe("63%");
    expect(gaugeFigure()).toBe("63% of your connection");
  });

  it("unknown role: the raw split, unchanged", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("unknown"));
    await renderDashboard();
    expect(gaugeLabel()).toBe("Channel balance");
    expect(gaugeFigure()).toBe("64% on your side — 36% on the hub's side");
  });
});

describe("item 3, D2.1: no figure appears twice on one dashboard screen", () => {
  it("farmer", async () => {
    await renderDashboard();
    expect(figures().length).toBeGreaterThan(3);
    expect(duplicates(figures())).toEqual([]);
  });

  it("merchant", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("merchant"));
    await renderDashboard();
    expect(figures().length).toBeGreaterThan(3);
    expect(duplicates(figures())).toEqual([]);
  });

  it("farmer below the withdrawal minimum: the hint does not repeat the balance", async () => {
    stub.getMemberStats.mockResolvedValue(stats({ local_sats: 200_000, remote_sats: 800_000, room_to_send_sats: 190_000, room_to_receive_sats: 790_000 }));
    stub.getNodeBalances.mockResolvedValue({ onchain_sats: 100_000, lightning_sats: 200_000, total_sats: 300_000 });
    await renderDashboard();
    expect(visibleText()).toContain("Minimum withdrawal: 250,000 sats.");
    expect(duplicates(figures())).toEqual([]);
  });

  it("Channel details stays one tap down, and shows the breakdown there", async () => {
    await renderDashboard();
    const details = host.querySelector("details.tile-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const rows = [...details.querySelectorAll(".kv-label")].map((e) => e.textContent);
    expect(rows).toEqual(["Channel capacity", "Your side", "Hub's side", "Your reserve", "Hub's reserve", "In flight", "Channel role"]);
  });
});

describe("item 4: Your Node shows dollars first, sats underneath", () => {
  it("a fresh rate: the value is dollars, the sats are in .kv-meta", async () => {
    await renderDashboard();
    expect(yourNodeRow("Bitcoin")).toEqual({ value: "$60.00", meta: ["100,000 sats"] });
    expect(yourNodeRow("Total")).toEqual({ value: "$444.00", meta: ["740,000 sats"] });
  });

  it("state \"none\": the value is sats, and the page says why", async () => {
    stub.getExchangeRate.mockResolvedValue(NONE);
    await renderDashboard();
    expect(yourNodeRow("Bitcoin")).toEqual({ value: "100,000sats", meta: [] });
    expect(visibleText()).toContain("amounts are shown in sats");
  });

  it("the Channel row is gone (the headline shows that figure)", async () => {
    await renderDashboard();
    expect(yourNodeRow("Channel")).toBeNull();
  });
});

/** The "Costs, last 30 days" panel: its total, sats line and breakdown rows. */
function costs() {
  const panel = [...host.querySelectorAll(".panel")].find((p) => p.querySelector(".panel-title")?.textContent?.includes("Costs, last 30 days"));
  if (!panel) return null;
  const details = panel.querySelector("details")!;
  return {
    total: panel.querySelector("[data-testid='costs-total']")!.textContent,
    sats: panel.querySelector("[data-testid='costs-total-sats']")?.textContent ?? null,
    open: details.open,
    rows: [...details.querySelectorAll("[data-testid='cost-part']")].map((r) => [
      r.querySelector(".kv-label")!.textContent,
      Number(r.getAttribute("data-sats")),
    ]),
  };
}

describe("item 14: costs over the last 30 days, itemised one tap down", () => {
  it("farmer: the total in dollars, sats under it; payment and Withdraw fees behind a dropdown", async () => {
    await renderDashboard();
    const c = costs()!;
    expect(c).not.toBeNull();
    expect(c.total).toBe("$2.43");
    expect(c.sats).toBe("4,042 sats");
    expect(c.open).toBe(false);
    expect(c.rows).toEqual([["Payment fees", 42], ["Withdraw fees", 4_000]]);
    expect(c.rows.reduce((s, [, v]) => s + (v as number), 0)).toBe(COSTS.total_sat);
  });

  it("merchant: payment and Top Up fees", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("merchant"));
    stub.getMemberCosts.mockResolvedValue({ ...COSTS, withdraw_fees_sat: 0, topup_fees_sat: 2_200, total_sat: 2_242 });
    await renderDashboard();
    expect(costs()!.rows).toEqual([["Payment fees", 42], ["Top Up fees", 2_200]]);
  });

  it("a fee from the other direction is listed too, so the rows always sum to the total", async () => {
    stub.getMemberCosts.mockResolvedValue({ ...COSTS, topup_fees_sat: 1_000, total_sat: 5_042 });
    await renderDashboard();
    const c = costs()!;
    expect(c.rows).toEqual([["Payment fees", 42], ["Withdraw fees", 4_000], ["Top Up fees", 1_000]]);
    expect(c.rows.reduce((s, [, v]) => s + (v as number), 0)).toBe(5_042);
  });

  it("the read failing: no panel, and the rest of the dashboard renders", async () => {
    stub.getMemberCosts.mockRejectedValue(new Error("down"));
    await renderDashboard();
    expect(costs()).toBeNull();
    expect(host.textContent).toContain("Your Node");
  });

  it("D2.1 still holds with the panel on screen", async () => {
    await renderDashboard();
    expect(costs()).not.toBeNull();
    expect(duplicates(figures())).toEqual([]);
  });
});

describe("R27(10): no client-side withdrawal fee guess", () => {
  it("the farmer's withdraw button has no \"Estimated fee\" caption", async () => {
    await renderDashboard();
    expect(host.textContent).toContain("Withdraw Earnings →");
    expect(host.textContent).not.toContain("Estimated fee");
  });
});
