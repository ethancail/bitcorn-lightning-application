// drive-mode P2, D2.2 — everything above the price chart, per role.
//
// WHAT THIS PROVES: the dashboard's top region (the notice slots, the page
// header, the headline numbers and their status line — every .dash child
// before the chart) renders the same DOM before and after P2, except for the
// changes R11(2) and R27(1) allow.
//
// HOW: the .snap file beside this test is written against the PRE-P2 code
// (drive-mode P2 commit 1) and is never updated afterwards. A later commit
// that changes the region on purpose undoes exactly its allowed changes on the
// captured text before matching (allowedChangesUndone, below), and asserts
// the new text directly, so an allowed change that did not happen still fails.
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

// Fixed, so the freshness and rate lines cannot drift with the clock.
const NOW = 1_790_000_000_000;

// The room figures differ from the raw sides on purpose (reserves of 10,000
// and 5,000), so a headline that switches to them shows a different number.
const CHANNEL = {
  channel_id: "1",
  local_sats: 640_000,
  remote_sats: 360_000,
  capacity_sats: 1_000_000,
  is_active: true,
  room_to_send_sats: 630_000,
  room_to_receive_sats: 355_000,
  local_reserve_sats: 10_000,
  remote_reserve_sats: 5_000,
  pending_outgoing_sats: 0,
  pending_incoming_sats: 0,
  commit_fee_sats: null,
  freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
};

const STATS = {
  hub_pubkey: null,
  membership_status: "active_member",
  node_role: "member",
  is_peered_to_hub: true,
  keysend_enabled: false,
  lnd_live_read_ok: true,
  cert_expiry: null,
  treasury_channel: CHANNEL,
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
  lifetime_received_sats: 2_468_000,
};

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

// ─── DOM capture: text and every attribute, in document order ──────────────

function serialize(node: Node, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent === "" ? [] : [`${pad}${JSON.stringify(node.textContent)}`];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const attrs = [...el.attributes].map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort();
  const open = `${pad}<${el.tagName.toLowerCase()}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  return [open, ...[...el.childNodes].flatMap((c) => serialize(c, depth + 1))];
}

/** Every .dash child before the price chart, serialized. */
function topRegion(): string {
  const dash = host.querySelector(".dash")!;
  const out: string[] = [];
  for (const child of dash.children) {
    if (child.getAttribute("data-testid") === "price-chart") return out.join("\n");
    out.push(...serialize(child));
  }
  throw new Error("price chart not found under .dash");
}

// ─── Harness ───────────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getMemberStats.mockResolvedValue(STATS);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 100_000, lightning_sats: 640_000, total_sats: 740_000 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getSwapLimits.mockImplementation(never);
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

describe("D2.2: the region above the price chart, against the pre-P2 build", () => {
  for (const role of ["farmer", "merchant", "unknown"] as const) {
    it(`${role}`, async () => {
      stub.getMemberLiquidityStatus.mockResolvedValue(advisor(role));
      await renderDashboard();
      expect(topRegion()).toMatchSnapshot();
    });
  }
});
