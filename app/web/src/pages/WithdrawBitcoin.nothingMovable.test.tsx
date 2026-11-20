// Below the minimum on Withdraw.
//
// Drive-mode P3, item 5 (BACKLOG §2, owned by drive-mode; gate 2 on Karan's
// farmer node): when nothing can move, Withdraw shows no amount input, no
// "250,000" placeholder and no presets — one honest sentence instead. While
// the connection to BitCorn is down, that sentence is the connection-down one
// (P2's), not a balance complaint. The copy says "connection", never "channel".
//
// Re-pinned for member-first-run-ui slice 3, R7 (Ethan's "recs", 2026-11-17):
// the big slot reads "Nothing to withdraw yet", with "of $X (N sats) in your
// connection" under it, then "You can withdraw once about $Y (N sats) is in
// your connection. The least you can withdraw is $Z (250,000 sats)." — the
// SERVER's trigger_sats and minimum (GET /api/swaps/options), never
// recomputed. The presets, box, note and button are HIDDEN. The page now
// gates on options.state, so the server's nothing_movable (today's fees leave
// less than the minimum, though the limits alone say enough) is no longer
// missed. The connection-down and daily-limit variants use the same slot with
// their existing sentences ("BitCorn").
//
// Harness: WithdrawBitcoin.presets.test.tsx's, with transfersApi stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getMemberStats: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getExchangeRate: vi.fn(),
  getSwapHistory: vi.fn(),
  getNodeAddress: vi.fn(),
  getSwapLimits: vi.fn(),
  getSwapLoopOutQuote: vi.fn(),
  getSwapOptions: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const { getSwapOptions, ...rest } = stub;
  return {
    ...actual,
    api: { ...(actual as any).api, ...rest },
    transfersApi: { ...(actual as any).transfersApi, getSwapOptions },
  };
});

import WithdrawBitcoin from "./WithdrawBitcoin";

type Stays = { total_sats: number; reserve_sats: number; fee_headroom_sats: number; swap_buffer_sats: number };
const ALWAYS_STAYS: Stays = { total_sats: 60_000, reserve_sats: 3_500, fee_headroom_sats: 6_500, swap_buffer_sats: 50_000 };

const limits = (o: { availableNow: number; dailyRemaining?: number; alwaysStays?: Stays | null }) => ({
  loop_available: true,
  loop_out: {
    min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000,
    daily_remaining_sats: o.dailyRemaining ?? 5_000_000,
    available_now_sats: o.availableNow,
    always_stays: o.alwaysStays === undefined ? ALWAYS_STAYS : o.alwaysStays,
  },
  loop_in: { min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000 },
});

const stats = (isActive: boolean, local = 100_000, capacity = 350_000) => ({
  treasury_channel: {
    channel_id: "1", local_sats: local, remote_sats: capacity - local, capacity_sats: capacity, is_active: isActive,
    room_to_send_sats: Math.max(0, local - 10_000), room_to_receive_sats: capacity - local - 3_500,
    local_reserve_sats: 3_500, remote_reserve_sats: 3_500,
    pending_outgoing_sats: 0, pending_incoming_sats: 0, commit_fee_sats: 1_532,
    freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
  },
});

/** GET /api/swaps/options for a state that offers nothing. */
const blockedOptions = (state: string, trigger: number | null, quoteState = "not_needed") => ({
  direction: "loop_out", state, strategy: "save", floor_sats: 70_000, room_sats: 200_000, calm: "unknown",
  min_sats: 250_000, trigger_sats: trigger, quote_state: quoteState, fee_limit_checked: true, cards: [], reason: null,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNodeAddress.mockResolvedValue({ address: "bcrt1qtestaddress" });
  stub.getSwapOptions.mockRejectedValue(new Error("not stubbed"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function mount(s: ReturnType<typeof stats>, l: ReturnType<typeof limits>, options?: ReturnType<typeof blockedOptions>) {
  stub.getMemberStats.mockResolvedValue(s);
  stub.getSwapLimits.mockResolvedValue(l);
  if (options) stub.getSwapOptions.mockResolvedValue(options);
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(WithdrawBitcoin))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const answer = () => host.querySelector("[data-testid='withdraw-answer']")?.textContent ?? null;
const inConnection = () => host.querySelector("[data-testid='in-connection']")?.textContent ?? null;
const sentence = () => host.querySelector("[data-testid='withdraw-nothing-movable']")?.textContent ?? null;

/** R7: everything a member would act with is hidden. */
function expectNothingToActWith() {
  expect(host.querySelector('input[aria-label="Amount"]'), "no box").toBeNull();
  expect(host.innerHTML).not.toContain('placeholder="250,000"');
  expect(host.querySelector(".withdraw-presets"), "no presets").toBeNull();
  expect(text(), "no 'How much'").not.toContain("How much");
  expect(host.querySelector("[data-testid='capacity-text']"), "no note").toBeNull();
  expect(text()).not.toContain("Your connection goes from");
  const labels = [...host.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
  expect(labels, "no Review button").not.toContain("Review withdrawal");
  expect(text()).not.toContain("You'll see the exact fee before anything moves.");
  expect(labels, "no way to set the most").not.toContain("Use the most");
  expect(text(), "no maximum").not.toContain("You can withdraw up to");
}

const CONNECTION_DOWN =
  "Your connection to BitCorn is down, so payments can't go through it right now. It usually reconnects within a few minutes; if it's still down in an hour, restart the Lightning app.";
const DAILY = "You've withdrawn as much as the daily limit allows. It frees up over the next 24 hours.";

describe("R7 — below the minimum", () => {
  it("Karan's figures (49,619 of 350,000; nothing free now): the server's trigger and minimum, dollars with sats", async () => {
    await mount(
      stats(true, 49_619, 350_000),
      limits({ availableNow: 0, alwaysStays: { total_sats: 49_619, reserve_sats: 3_500, fee_headroom_sats: 6_500, swap_buffer_sats: 39_619 } }),
      // The server's trigger as it sends it today (min + always_stays.total;
      // it understates the real trigger — filed, not fixed, in this slice).
      blockedOptions("nothing_movable", 299_619),
    );
    expect(answer()).toBe("Nothing to withdraw yet");
    expect(inConnection()).toBe("of $29.77 (49,619 sats) in your connection");
    expect(sentence()).toBe(
      "You can withdraw once about $179.77 (299,619 sats) is in your connection. The least you can withdraw is $150.00 (250,000 sats).",
    );
    expectNothingToActWith();
    // "Why not all of it?" is still one tap away, closed.
    const why = host.querySelector("[data-testid='row-why-not']") as HTMLDetailsElement;
    expect(why).not.toBeNull();
    expect(why.open).toBe(false);
  });

  it("the server's nothing_movable when the limits alone say enough (today's fees leave less than the minimum)", async () => {
    await mount(stats(true, 400_000, 1_000_000), limits({ availableNow: 300_000 }), blockedOptions("nothing_movable", 310_000, "ok"));
    expect(answer()).toBe("Nothing to withdraw yet");
    expect(sentence()).toBe(
      "You can withdraw once about $186.00 (310,000 sats) is in your connection. The least you can withdraw is $150.00 (250,000 sats).",
    );
    expectNothingToActWith();
  });

  it("the trigger is the server's figure, not min + always_stays recomputed on the page", async () => {
    // always_stays says 60,000, so a page computing its own trigger would say 310,000.
    await mount(stats(true), limits({ availableNow: 36_500 }), blockedOptions("nothing_movable", 333_333));
    expect(sentence()).toContain("(333,333 sats)");
    expect(text()).not.toContain("310,000");
  });

  it("connection down: the same slot, the connection-down sentence, no balance trigger", async () => {
    await mount(stats(false), limits({ availableNow: 0, alwaysStays: null }), blockedOptions("connection_down", null));
    expect(answer()).toBe("Nothing to withdraw yet");
    expect(sentence()).toBe(CONNECTION_DOWN);
    expect(text()).not.toContain("You can withdraw once");
    expectNothingToActWith();
  });

  it("today's limit used up: the same slot, the daily-limit sentence, no balance trigger", async () => {
    await mount(stats(true), limits({ availableNow: 100_000, dailyRemaining: 100_000 }), blockedOptions("daily_limit", null));
    expect(answer()).toBe("Nothing to withdraw yet");
    expect(sentence()).toBe(DAILY);
    expect(text()).not.toContain("You can withdraw once");
    expectNothingToActWith();
  });

  it("the options read failed: the limits still say below the minimum; the server's minimum alone, no invented trigger", async () => {
    await mount(stats(true), limits({ availableNow: 36_500 }));
    expect(answer()).toBe("Nothing to withdraw yet");
    expect(sentence()).toBe("The least you can withdraw is $150.00 (250,000 sats).");
    expectNothingToActWith();
  });

  it("no message says 'channel' or 'hub', and BitCorn is spelled so", async () => {
    for (const [s, l, o] of [
      [stats(true), limits({ availableNow: 36_500 }), blockedOptions("nothing_movable", 310_000)],
      [stats(false), limits({ availableNow: 0, alwaysStays: null }), blockedOptions("connection_down", null)],
    ] as const) {
      await mount(s, l, o);
      // Text nodes joined with spaces: textContent glues neighbours ("channelWhy"), which \b misses.
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue ?? "");
      const words = parts.join(" ");
      expect(words, "the scan reads the page").toContain("Nothing to withdraw yet");
      expect(words).not.toMatch(/\bchannels?\b|\bhubs?\b/i);
      expect(words).not.toContain("Bitcorn");
      await act(async () => { root.unmount(); });
      root = createRoot(host);
    }
  });

  it("something can move: the box and the button are back", async () => {
    await mount(stats(true), limits({ availableNow: 700_000 }));
    expect(host.querySelector('input[aria-label="Amount"]')).not.toBeNull();
    expect([...host.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === "Review withdrawal")).toBe(true);
    expect(sentence()).toBeNull();
  });
});
