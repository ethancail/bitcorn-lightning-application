// D3 / V11 on the member pages — the dashboard gauge, Top Up and Cash Out take
// their capacity colour from the Liquidity Advisor's state, never red and never
// from the percentage. R2 / PR3-4: an unknown role or no classification is
// neutral. PR3-2: Top Up's projected % is --text. PR3-7: amber only on the bar.
//
// The fixtures put the state and the percentage at odds (a 50% channel the
// advisor calls receive_exhausted, a 10% one it calls healthy), so a colour
// recomputed from the percentage fails them.
//
// Harness: MemberDashboard.declaredRole.test.tsx's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cssRules } from "../styleRules.testutil";

const NOW = Date.now();

const stub = vi.hoisted(() => ({
  getMemberStats: vi.fn(),
  getPendingChannels: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getExchangeRate: vi.fn(),
  getNodeBalances: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getTreasuryInfo: vi.fn(),
  getBitcornName: vi.fn(),
  getSwapHistory: vi.fn(),
  getSwapLimits: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/BitcoinPriceGraph", () => ({ default: () => React.createElement("div") }));

import MemberDashboard from "./MemberDashboard";
import RefillChannel from "./RefillChannel";
import WithdrawBitcoin from "./WithdrawBitcoin";
import type { MemberChannelRole, MemberChannelState } from "../api/client";

const never = () => new Promise<never>(() => {});

const stats = (localSats: number) => ({
  hub_pubkey: null,
  membership_status: "active",
  node_role: "member",
  is_peered_to_hub: true,
  keysend_enabled: false,
  lnd_live_read_ok: true,
  cert_expiry: null,
  treasury_channel: {
    channel_id: "1",
    local_sats: localSats,
    remote_sats: 1_000_000 - localSats,
    capacity_sats: 1_000_000,
    is_active: true,
    // P1's figures, each side less a 10,000 reserve (the dashboard gauge reads
    // them since drive-mode P2).
    room_to_send_sats: Math.max(0, localSats - 10_000),
    room_to_receive_sats: Math.max(0, 1_000_000 - localSats - 10_000),
    freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
  },
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
});

const LOOP = { loopDaemonRunning: false, loopOutAvailable: false, loopInAvailable: false, loopOutTerms: null, loopInTerms: null };

const status = (role: MemberChannelRole, state: MemberChannelState | null) => ({
  channelRole: role,
  classification: state === null ? null : {
    channelId: "1", capacitySat: 1_000_000, memberLocalSat: 0, treasuryLocalSat: 0, memberLocalPct: 0,
    state, urgency: "medium", consecutiveNonHealthyRuns: 1, classifiedAt: NOW, channelRole: role,
  },
  recommendation: null,
  loopAvailability: LOOP,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 2_000_000, lightning_sats: 0, total_sats: 2_000_000 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  // GET /api/swaps/limits at the env defaults, as the server returns them
  // since drive-mode P1 item 6 (the pages read their swap limits from it).
  stub.getSwapLimits.mockResolvedValue({ loop_available: true, loop_out: { min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000 }, loop_in: { min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000 } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function render(page: React.ComponentType) {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(page)));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

const style = (el: Element) => el.getAttribute("style") ?? "";
const bar = () => {
  const el = host.querySelector('[data-testid="capacity-bar"]');
  expect(el, "the capacity bar renders").not.toBeNull();
  return style(el!);
};
const texts = () => Array.from(host.querySelectorAll('[data-testid="capacity-text"]'));

function setup(localSats: number, role: MemberChannelRole, state: MemberChannelState | null) {
  stub.getMemberStats.mockResolvedValue(stats(localSats));
  stub.getMemberLiquidityStatus.mockResolvedValue(status(role, state));
}

describe("V11 — the member dashboard's gauge", () => {
  it("a merchant at 50% the advisor calls receive_exhausted → amber bar, hero in --text, \"Getting low\"", async () => {
    setup(500_000, "merchant", "receive_exhausted");
    await render(MemberDashboard);
    expect(bar()).toContain("var(--amber)");
    expect(texts().map(style).join("|")).not.toMatch(/amber|red/);
    expect(host.textContent).toContain("Room to send · Getting low"); // R33 finding 7
    // On a phone the word must not wrap away from its label.
    expect(host.querySelector('[data-testid="gauge-label"]')!.getAttribute("style") ?? "").toContain("white-space: nowrap");
    const labels = cssRules().find((r) => r.media === null && r.selectors.includes(".member-gauge .labels"))!.decls;
    expect(labels["gap"], "the label and the figure never touch").toBe("12px");
  });

  it("PERMITTING: a merchant at 10% the advisor calls healthy → green bar, no word", async () => {
    setup(100_000, "merchant", "healthy");
    await render(MemberDashboard);
    expect(bar()).toContain("var(--green)");
    expect(host.textContent).not.toContain("Getting low");
  });

  it("a farmer the advisor calls send_saturated → amber bar, \"Getting low\", never red", async () => {
    setup(900_000, "farmer", "send_saturated");
    await render(MemberDashboard);
    expect(bar()).toContain("var(--amber)");
    // The farmer's gauge reads "Room to receive" since drive-mode P2 (item 2).
    expect(host.textContent).toContain("Room to receive · Getting low"); // R33 finding 7
    expect(host.innerHTML).not.toContain("var(--red)");
  });

  it("R2: an unknown role at 5% → a neutral bar", async () => {
    setup(50_000, "unknown", "receive_exhausted");
    await render(MemberDashboard);
    expect(bar()).toContain("var(--text-3)");
  });

  it("PR3-4: a declared merchant with no classification → a neutral bar", async () => {
    setup(50_000, "merchant", null);
    await render(MemberDashboard);
    expect(bar()).toContain("var(--text-3)");
  });
});

describe("V11 — Top Up", () => {
  it("a merchant at 50% the advisor calls receive_heavy → amber bar, \"Getting low\", text in --text", async () => {
    setup(500_000, "merchant", "receive_heavy");
    await render(RefillChannel);
    expect(bar()).toContain("var(--amber)");
    expect(host.textContent).toContain("Getting low · 50% available to send"); // R33 finding 7: the bar is the merchant's room to send
    expect(texts().length).toBeGreaterThanOrEqual(3);
    expect(texts().map(style).join("|")).not.toMatch(/amber|red/);
  });

  it("PERMITTING: a merchant at 10% the advisor calls healthy → green bar", async () => {
    setup(100_000, "merchant", "healthy");
    await render(RefillChannel);
    expect(bar()).toContain("var(--green)");
  });

  it("PR3-2: the projected \"after top up\" % is --text", async () => {
    setup(100_000, "merchant", "healthy");
    await render(RefillChannel);
    const projected = texts().find((el) => el.textContent?.trim() === "35%");
    expect(projected, "the projected 35% renders").toBeDefined();
    expect(style(projected!)).toContain("color: var(--text)");
  });
});

describe("V11 — Cash Out", () => {
  it("a farmer at 50% the advisor calls send_heavy → amber bar, \"Room to receive getting low\", text in --text", async () => {
    setup(500_000, "farmer", "send_heavy");
    await render(WithdrawBitcoin);
    expect(bar()).toContain("var(--amber)");
    // drive-mode P2 item 15: a share of the connection, not of what is withdrawable.
    // R33 finding 7: the bar is the share in the connection, so the word names the room.
    expect(host.textContent).toContain("Room to receive getting low · 50% of your connection");
    expect(texts().map(style).join("|")).not.toMatch(/amber|red/);
  });

  it("PERMITTING: a farmer at 5% the advisor calls healthy → green bar, never red", async () => {
    setup(50_000, "farmer", "healthy");
    await render(WithdrawBitcoin);
    expect(bar()).toContain("var(--green)");
    expect(host.innerHTML).not.toContain("var(--red)");
  });
});

describe("PR3-3 — the advisor's alert", () => {
  it("high urgency → the warning alert with ⚠, never the red critical", async () => {
    setup(50_000, "merchant", "receive_exhausted");
    stub.getMemberLiquidityStatus.mockResolvedValue({
      ...status("merchant", "receive_exhausted"),
      recommendation: {
        action: "loop_in", suggestedAmountSats: 500_000, projectedMemberLocalPct: 0.5,
        reason: "Your channel is nearly out of room to send.", urgency: "high",
        loopAvailable: true, generatedAt: NOW,
      },
    });
    await render(MemberDashboard);
    const alert = [...host.querySelectorAll(".alert")].find((a) => a.textContent?.includes("nearly out of room"));
    expect(alert, "the advisor alert renders").toBeDefined();
    expect(alert!.className).toBe("alert warning");
    expect(alert!.querySelector(".alert-icon")?.textContent).toBe("⚠");
  });
});

describe("PR 7: the gauge's figure wraps instead of clipping", () => {
  // At 1.5x on a phone the farmer's "71% full — 7,088,766 of 10,000,000 sats"
  // ran past the tile. jsdom has no layout, so the rule is read; the browser
  // matrix is the evidence of what renders.
  it("the labels row wraps; the figure, last, keeps to the right on its own line", async () => {
    setup(710_000, "farmer", "healthy");
    await render(MemberDashboard);
    const labels = host.querySelector(".member-gauge .labels")!;
    // drive-mode P2 item 2: room to receive, (1,000,000 − 710,000 − 10,000) /
    // 1,000,000, as a percentage only.
    expect(labels.lastElementChild!.textContent).toBe("28% of your connection");
    const rules = cssRules().filter((r) => r.media === null);
    const decls = (sel: string) => Object.assign({}, ...rules.filter((r) => r.selectors.includes(sel)).map((r) => r.decls));
    expect(decls(".member-gauge .labels")["flex-wrap"]).toBe("wrap");
    expect(decls(".member-gauge .labels > :last-child")["margin-left"]).toBe("auto");
    // PR 3 (5902f9b): the label and its word still never part.
    expect(host.querySelector('[data-testid="gauge-label"]')!.getAttribute("style") ?? "").toContain("white-space: nowrap");
  });
});
