// The simplified Withdraw (member-first-run-ui slice 3; the ruled design,
// 2026-11-13 §2; Ethan's "recs" to R1–R8, relayed 2026-11-17).
//
//   tiers          always visible: outside every <details>; one tap away:
//                  four rows, each CLOSED by default
//   R3             the tip "Waiting costs less" exactly when the server
//                  recommends waiting (fees_high, bigger_share, over the fee
//                  limit), with that case's reason; none when it recommends now
//   inventory      every fact of the page before slice 3 is still reachable,
//                  in the state that shows it (the canvas inventory's claim)
//   R6             the rate: loading → no sentence, sats only; failed, none or
//                  no usd → the sentence exactly once; stale → "Price as of"
//   member text    no "channel" or "hub"; "BitCorn"
//   R5             no control sets the over-limit amount without the tick
//
// The below-minimum variants are WithdrawBitcoin.nothingMovable.test.tsx's.
// Harness: optionCards.pages.test.tsx's.

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
  initiateSwapLoopOut: vi.fn(),
  getSwap: vi.fn(),
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
import { NO_RATE_NOTE } from "../components/amount/amountDescriptor";

const channel = (local = 600_000, isActive = true) => ({
  channel_id: "1", local_sats: local, remote_sats: 1_000_000 - local, capacity_sats: 1_000_000, is_active: isActive,
  room_to_send_sats: local - 10_000, room_to_receive_sats: 1_000_000 - local - 10_000, local_reserve_sats: 10_000, remote_reserve_sats: 10_000,
  pending_outgoing_sats: 0, pending_incoming_sats: 0, commit_fee_sats: 872,
  freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
});

const ALWAYS = { total_sats: 60_000, reserve_sats: 10_000, fee_headroom_sats: 0, swap_buffer_sats: 50_000 };
const limits = (o: { availableNow?: number; daily?: number } = {}) => ({
  loop_available: true,
  loop_out: {
    min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: o.daily ?? 5_000_000,
    available_now_sats: o.availableNow ?? 540_000, always_stays: ALWAYS,
  },
  loop_in: { min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, onchain_rule: null, onchain_floor_sats: null, available_now_sats: null },
});

type Reason = "room_low" | "fees_low" | "fees_high" | "over_fee_limit" | "bigger_share" | "keep_room_open";
const WAIT_REASONS: Reason[] = ["fees_high", "bigger_share", "over_fee_limit"];
const NOW_REASONS: Reason[] = ["room_low", "fees_low", "keep_room_open"];

const OUT = (o: { reason?: Reason; over?: boolean; quote?: "ok" | "unavailable"; nowAmount?: number; limitChecked?: boolean } = {}) => {
  const reason = o.reason ?? (o.over ? "over_fee_limit" : "bigger_share");
  const waitRec = WAIT_REASONS.includes(reason);
  const unq = o.quote === "unavailable";
  return {
    direction: "loop_out", state: "ok", strategy: "save", floor_sats: 70_000, room_sats: 380_000, calm: "unknown",
    min_sats: 250_000, trigger_sats: null, quote_state: o.quote ?? "ok", fee_limit_checked: o.limitChecked ?? true, reason,
    cards: [
      { key: "now", amount_sats: unq ? 540_000 : o.nowAmount ?? 531_600, fee_sats: unq ? null : 8_316, over_fee_limit: !!o.over, recommended: !waitRec },
      { key: "wait_bigger", amount_sats: 850_000, fee_sats: null, over_fee_limit: false, recommended: waitRec },
    ],
  };
};

const FRESH = { usd: 100_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue({ treasury_channel: channel() });
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue(FRESH);
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNodeAddress.mockResolvedValue({ address: "bcrt1qtestaddress" });
  stub.getSwapLimits.mockResolvedValue(limits());
  stub.getSwapOptions.mockResolvedValue(OUT());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function mount() {
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(WithdrawBitcoin))); });
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function remount() {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await mount();
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ");
const text = () => norm(host.textContent);
function outsideDetails(): string {
  const clone = host.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details").forEach((d) => d.remove());
  return norm(clone.textContent);
}
const rows = () => [...host.querySelectorAll("details.withdraw-row")] as HTMLDetailsElement[];
const amountValue = () => (host.querySelector('input[aria-label="Amount"]') as HTMLInputElement | null)?.value.replace(/[^0-9]/g, "") ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
async function typeAmount(value: string) {
  const input = host.querySelector('input[aria-label="Amount"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// ─── Tiers ──────────────────────────────────────────────────────────────────
describe("the tiers", () => {
  it("always visible: every ruled line is outside every <details>", async () => {
    await mount();
    const out = outsideDetails();
    expect(host.querySelector("h1")?.textContent).toBe("Withdraw");
    for (const line of [
      "Move money out of your connection into your node's bitcoin wallet.",
      "You can withdraw up to",
      "$531.60", // the big amount, dollars…
      "531,600 sats", // …with the sats under them
      "of $600.00 (600,000 sats) in your connection",
      "How much",
      "Your connection goes from 60% to 35% full.",
      "Goes to: Your node's bitcoin wallet",
      "Review withdrawal",
      "You'll see the exact fee before anything moves.",
    ]) expect(out, line).toContain(line);
    // The big amount is the hero Amount.
    expect(host.querySelector("[data-testid='withdraw-answer'] .amount-hero")).not.toBeNull();
    // The presets: dollars, the sats under them.
    const preset = host.querySelector(".withdraw-presets .choice-option") as HTMLElement;
    expect(preset.querySelector("[data-line='usd']")?.textContent).toBe("$250.00");
    expect(preset.querySelector("[data-line='sats']")?.textContent).toBe("250,000 sats");
    // The box: sats, with the dollars under it.
    expect(host.querySelector(".withdraw-unit")?.textContent).toBe("sats");
    expect(host.querySelector(".withdraw-box-usd")?.textContent).toBe("$250.00");
  });

  it("one tap away: the four rows, in order, each closed by default", async () => {
    await mount();
    expect(rows().map((d) => d.querySelector("summary")!.textContent)).toEqual([
      "Why not all of it?",
      "Withdraw the most now",
      "Limits and address",
      "Recent withdrawals (0)",
    ]);
    for (const d of rows()) expect(d.open, d.querySelector("summary")!.textContent!).toBe(false);
    // What they hold is not on the always-visible tier.
    const out = outsideDetails();
    for (const hidden of ["Always stays to keep you connected", "Minimum: 250,000 sats", "bcrt1qtestaddress", "Use the most", "No withdrawals yet"]) {
      expect(out, hidden).not.toContain(hidden);
    }
  });

  it("only when it applies: no tip, no warning, no error when none applies", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT({ reason: "fees_low" }));
    await mount();
    expect(host.querySelector("[data-testid='withdraw-tip']")).toBeNull();
    expect(host.querySelector("[data-testid='capacity-warning']")).toBeNull();
    expect(host.querySelector(".withdraw-error")).toBeNull();
  });

  it("errors only past a limit: over the most, under the minimum", async () => {
    await mount();
    await typeAmount("600000");
    expect(text()).toContain("The most you can withdraw right now is 540,000 sats.");
    await typeAmount("200000");
    expect(text()).toContain("Withdrawal must be at least 250,000 sats.");
    await typeAmount("300000");
    expect(host.querySelector(".withdraw-error")).toBeNull();
  });

  it("a preset is a Choice keyed by sats; a typed amount selects none", async () => {
    await mount();
    const radio = (v: string) => host.querySelector(`.withdraw-presets input[value="${v}"]`) as HTMLInputElement;
    await act(async () => { radio("500000").click(); });
    expect(amountValue()).toBe("500000");
    expect(radio("500000").checked).toBe(true);
    await typeAmount("333333");
    expect([...host.querySelectorAll(".withdraw-presets input")].some((r) => (r as HTMLInputElement).checked)).toBe(false);
  });
});

// ─── R3: the tip ────────────────────────────────────────────────────────────
describe("R3 — 'Waiting costs less' whenever the server recommends waiting", () => {
  const REASON_TEXT: Record<Reason, string> = {
    fees_high: "Fees are high today, and a later, bigger transfer costs a smaller share.",
    bigger_share: "A later, bigger transfer costs a smaller share.",
    over_fee_limit: "Today's fee is over your fee limit, and a later, bigger transfer costs a smaller share.",
    room_low: "", fees_low: "", keep_room_open: "",
  };
  for (const reason of WAIT_REASONS) {
    it(`${reason}: the tip, with that reason`, async () => {
      stub.getSwapOptions.mockResolvedValue(OUT({ reason, over: reason === "over_fee_limit" }));
      await mount();
      const tip = host.querySelector("[data-testid='withdraw-tip']")!;
      expect(tip, "the tip shows").not.toBeNull();
      expect(tip.closest("details"), "the tip is not behind a tap").toBeNull();
      expect(tip.querySelector(".withdraw-tip-title")?.textContent).toBe("Waiting costs less");
      expect(tip.querySelector("[data-testid='recommended-reason']")?.textContent).toBe(REASON_TEXT[reason]);
    });
  }
  for (const reason of NOW_REASONS) {
    it(`${reason} (the server recommends now): no tip`, async () => {
      stub.getSwapOptions.mockResolvedValue(OUT({ reason }));
      await mount();
      expect(host.querySelector("[data-testid='withdraw-tip']")).toBeNull();
      expect(text()).not.toContain("Waiting costs less");
    });
  }
});

// ─── Every fact reachable ───────────────────────────────────────────────────
// The page before slice 3 (517f1c3), fact by fact, and the state that shows
// it. Each must be somewhere in the page — always visible, or in a row.
type Setup = () => void | Promise<void>;
const STATES: Record<string, { setup: Setup; after?: () => Promise<void> }> = {
  ok: { setup: () => {} },
  waiting: { setup: () => { stub.getSwapOptions.mockImplementation(() => new Promise(() => {})); } },
  over: { setup: () => { stub.getSwapOptions.mockResolvedValue(OUT({ over: true })); } },
  unquoted: { setup: () => { stub.getSwapOptions.mockResolvedValue(OUT({ quote: "unavailable" })); } },
  nowRecommended: { setup: () => { stub.getSwapOptions.mockResolvedValue(OUT({ reason: "fees_low" })); } },
  noPrice: {
    setup: () => {
      stub.getExchangeRate.mockResolvedValue({ usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" });
      stub.getSwapOptions.mockResolvedValue(OUT({ limitChecked: false }));
    },
  },
  stale: { setup: () => { stub.getExchangeRate.mockResolvedValue({ ...FRESH, state: "stale", fetched_at: Date.now() - 2 * 3600_000 }); } },
  warn: {
    setup: () => {
      stub.getMemberLiquidityStatus.mockResolvedValue({
        channelRole: "farmer",
        classification: { channelId: "1", capacitySat: 1_000_000, memberLocalSat: 0, treasuryLocalSat: 0, memberLocalPct: 0, state: "send_heavy", urgency: "medium", consecutiveNonHealthyRuns: 1, classifiedAt: Date.now(), channelRole: "farmer" },
        recommendation: null, loopAvailability: null,
        loopAlert: { loop_out: { text: "Loop isn't available for withdrawals right now.", action: { label: "Check again" } } },
      });
    },
  },
  typedOver: { setup: () => {}, after: async () => { await typeAmount("600000"); } },
  typedUnder: { setup: () => {}, after: async () => { await typeAmount("200000"); } },
  noAddress: { setup: () => { stub.getNodeAddress.mockRejectedValue(new Error("lnd down")); } },
  belowMin: {
    setup: () => {
      stub.getSwapLimits.mockResolvedValue(limits({ availableNow: 0 }));
      stub.getSwapOptions.mockResolvedValue({ ...OUT(), state: "nothing_movable", cards: [], reason: null, trigger_sats: 310_000 });
    },
  },
  down: {
    setup: () => {
      stub.getMemberStats.mockResolvedValue({ treasury_channel: channel(600_000, false) });
      stub.getSwapLimits.mockResolvedValue(limits({ availableNow: 0 }));
      stub.getSwapOptions.mockResolvedValue({ ...OUT(), state: "connection_down", cards: [], reason: null });
    },
  },
  daily: {
    setup: () => {
      stub.getSwapLimits.mockResolvedValue(limits({ availableNow: 100_000, daily: 100_000 }));
      stub.getSwapOptions.mockResolvedValue({ ...OUT(), state: "daily_limit", cards: [], reason: null });
    },
  },
  historyRows: {
    setup: () => {
      stub.getSwapHistory.mockResolvedValue({
        swaps: [{
          id: "w1", created_at: 1_700_000_000, updated_at: 1_700_000_100, node_pubkey: "x", role: "member", swap_type: "loop_out",
          direction: "out", status: "completed", amount_sat: 300_000, quoted_fee_sat: 4_000, actual_fee_sat: 4_321, actual_fee_usd_cents: 300,
          destination_address: "bcrt1qold", failure_reason: null,
        }],
      });
    },
  },
  historyFailed: { setup: () => { stub.getSwapHistory.mockRejectedValue(new Error("fetch failed")); } },
};

const FACTS: Array<[fact: string, state: keyof typeof STATES, shown: string]> = [
  // header
  ["the title", "ok", "Withdraw"],
  ["the lead", "ok", "Move money out of your connection into your node's bitcoin wallet."],
  ["the stale price note", "stale", "Price as of"],
  ["the no-price sentence", "noPrice", NO_RATE_NOTE],
  ["the Loop alert and its action", "warn", "Loop isn't available for withdrawals right now.Check again"],
  // the answer (was "Most you can withdraw" and "In your connection")
  ["the most you can withdraw", "ok", "You can withdraw up to$531.60531,600 sats"],
  ["what is in the connection", "ok", "of $600.00 (600,000 sats) in your connection"],
  ["the advisor's warning (was the bar's colour and word)", "warn", "Room to receive getting low"],
  ["checking today's fees", "waiting", "Checking today's fees…"],
  // the note (was the bar's % and "After withdrawal")
  ["the share, before and after", "ok", "Your connection goes from 60% to 35% full."],
  // "Why not all of it?"
  ["always stays", "ok", "Always stays to keep you connected60,000 sats"],
  ["the reserve", "ok", "Connection reserve10,000 sats"],
  ["the fee headroom", "ok", "Lightning fee headroom0 sats"],
  ["the swap buffer", "ok", "Swap buffer50,000 sats"],
  // the "now" card → "Withdraw the most now"
  ["the most, in the row", "ok", "Amount $531.60531,600 sats"],
  ["the fee at today's fees", "ok", "Fee, at today's fees $8.328,316 sats"],
  ["room to receive after it", "ok", "Room to receive rises to $911.60 (911,600 sats)."],
  ["R25, quote-based", "ok", "This allows for today's fees; if they rise before you confirm, the quote will say so."],
  ["R25, no quote", "unquoted", "The swap's fees come out of this, so the exact amount you can withdraw is set when you get a quote."],
  ["over the fee limit", "over", "That's over your fee limit, so you'd allow it once."],
  ["allow it this once", "over", "Allow it this once"],
  ["the fee limit can't be checked", "noPrice", "Can't check this against your fee limit right now: the bitcoin price isn't available."],
  ["the reason when now is recommended", "nowRecommended", "Fees are low today."],
  ["use the most", "ok", "Use the most"],
  // the wait card + badge → the tip
  ["the tip", "ok", "Waiting costs less"],
  ["the wait reason", "ok", "A later, bigger transfer costs a smaller share."],
  ["the wait card's line", "ok", "Worth more once room to receive has dropped to $70.00 (70,000 sats)."],
  ["the wait card's amount", "ok", "A later transfer could move about $850.00 (850,000 sats)."],
  // how much
  ["the presets", "ok", "$250.00250,000 sats$500.00500,000 sats"],
  ["the box's unit", "ok", "sats"],
  ["the over-the-most error", "typedOver", "The most you can withdraw right now is 540,000 sats."],
  ["the under-the-minimum error", "typedUnder", "Withdrawal must be at least 250,000 sats."],
  // limits and address
  ["min and max", "ok", "Minimum: 250,000 sats. Maximum: 2,000,000 sats."],
  ["the address, Copy, New", "ok", "bcrt1qtestaddressCopyNew"],
  ["where the address sends", "ok", "Your withdrawn bitcoin will be sent to this on-chain address."],
  ["the address failure and its retry", "noAddress", "Failed to generate address — retry"],
  // where it goes, the action
  ["goes to", "ok", "Goes to: Your node's bitcoin wallet"],
  ["the button", "ok", "Review withdrawal"],
  ["the button's line", "ok", "You'll see the exact fee before anything moves."],
  // below the minimum
  ["nothing to withdraw", "belowMin", "Nothing to withdraw yet"],
  ["the trigger and the minimum", "belowMin", "You can withdraw once about $310.00 (310,000 sats) is in your connection. The least you can withdraw is $250.00 (250,000 sats)."],
  ["the connection is down", "down", "Your connection to BitCorn is down, so payments can't go through it right now."],
  ["the daily limit", "daily", "You've withdrawn as much as the daily limit allows. It frees up over the next 24 hours."],
  // recent withdrawals
  ["the history's count", "historyRows", "Recent withdrawals (1)"],
  ["the history's columns", "historyRows", "DateAmountStatusFee"],
  ["a history row", "historyRows", "300,000Complete$3.004,321"],
  ["no withdrawals yet", "ok", "No withdrawals yet"],
  ["the history failed", "historyFailed", "Couldn't load your withdrawal history."],
];

describe("every fact of the page before slice 3 is still reachable", () => {
  const byState = new Map<string, Array<[string, string]>>();
  for (const [fact, state, shown] of FACTS) byState.set(state, [...(byState.get(state) ?? []), [fact, shown]]);

  for (const [state, facts] of byState) {
    it(`${state}: ${facts.map(([f]) => f).join("; ")}`, async () => {
      await STATES[state].setup();
      await mount();
      await STATES[state].after?.();
      const t = text();
      const missing = facts.filter(([, shown]) => !t.includes(norm(shown))).map(([f, shown]) => `${f}: "${shown}"`);
      expect(missing).toEqual([]);
    });
  }

  it("not vacuous: the inventory covers every state and dozens of facts", () => {
    expect(FACTS.length).toBeGreaterThanOrEqual(45);
    expect(new Set(FACTS.map(([, s]) => s))).toEqual(new Set(Object.keys(STATES)));
  });
});

// ─── R6: the rate ───────────────────────────────────────────────────────────
describe("R6 — the rate's states", () => {
  const sentences = () => text().split(NO_RATE_NOTE).length - 1;
  const upToLines = () => [...host.querySelectorAll("[data-testid='withdraw-answer'] [data-line]")].map((e) => e.getAttribute("data-line"));

  it("loading: no sentence, and the amounts are sats only", async () => {
    stub.getExchangeRate.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(sentences()).toBe(0);
    expect(upToLines()).toEqual(["sats"]);
    expect(host.querySelector(".withdraw-box-usd")).toBeNull();
  });

  for (const [name, setup] of [
    ["the read failed (null)", () => stub.getExchangeRate.mockRejectedValue(new Error("down"))],
    ["state none", () => stub.getExchangeRate.mockResolvedValue({ usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" })],
    ["no usd", () => stub.getExchangeRate.mockResolvedValue({ ...FRESH, usd: null })],
  ] as const) {
    it(`${name}: the sentence exactly once, and sats only`, async () => {
      setup();
      await mount();
      expect(sentences()).toBe(1);
      expect(upToLines()).toEqual(["sats"]);
      expect(text()).not.toContain("Price as of");
    });
  }

  it("stale: 'Price as of …' by the lead, dollars shown, no sentence", async () => {
    stub.getExchangeRate.mockResolvedValue({ ...FRESH, state: "stale", fetched_at: Date.now() - 2 * 3600_000 });
    await mount();
    expect(text()).toContain("Price as of");
    expect(sentences()).toBe(0);
    expect(upToLines()).toEqual(["usd", "sats"]);
  });

  it("fresh: dollars, no note, no sentence", async () => {
    await mount();
    expect(sentences()).toBe(0);
    expect(text()).not.toContain("Price as of");
  });
});

// ─── Member text ────────────────────────────────────────────────────────────
// Each text node joined with a space: textContent glues neighbours ("…the
// channel" + "Why not…" reads "channelWhy"), which a \b guard can't see — the
// negative control caught exactly that.
function spacedText(): string {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue ?? "");
  return norm(parts.join(" "));
}

describe("member text: no 'channel' or 'hub'; 'BitCorn'", () => {
  for (const state of ["ok", "over", "noPrice", "warn", "belowMin", "down", "daily", "noAddress", "historyRows", "historyFailed"] as const) {
    it(state, async () => {
      await STATES[state].setup();
      await mount();
      for (const d of rows()) d.open = true;
      const words = spacedText();
      expect(words, "the scan reads the page").toContain("Goes to:");
      expect(words).not.toMatch(/\bchannels?\b|\bhubs?\b/i);
      expect(words).not.toContain("Bitcorn");
    });
  }
});

// ─── R5: no over-limit amount without the tick ──────────────────────────────
describe("R5 — no control sets the over-limit amount without 'Allow it this once'", () => {
  // The most (500,000) is over the fee limit and equals a preset, so a preset
  // that reached it would bypass the tick.
  beforeEach(() => {
    stub.getSwapOptions.mockResolvedValue(OUT({ over: true, nowAmount: 500_000 }));
  });

  it("there is no Max button", async () => {
    await mount();
    expect(button("Max")).toBeUndefined();
  });

  it("every other control leaves the amount short of the most", async () => {
    await mount();
    const controls = [
      ...[...host.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() !== "Use the most"),
      ...host.querySelectorAll(".withdraw-presets input"),
    ] as HTMLElement[];
    expect(controls.length, "the scan sees the page's controls").toBeGreaterThan(3);
    for (const c of controls) {
      if ((c as HTMLButtonElement).disabled) continue;
      const label = (c.textContent || (c as HTMLInputElement).value || "").trim();
      if (label === "Review withdrawal") continue; // fetches a quote; changes no amount
      if (label === "Copy") continue; // the clipboard, which jsdom lacks; changes no amount
      await act(async () => { c.click(); });
      expect(amountValue(), `after ${label}`).not.toBe("500000");
    }
  });

  it("'Use the most' is off until the tick, then sets the most", async () => {
    await mount();
    expect(button("Use the most")!.disabled).toBe(true);
    await act(async () => { button("Use the most")!.click(); });
    expect(amountValue()).not.toBe("500000");
    const tick = host.querySelector("[data-testid='row-most-now'] input[type='checkbox']") as HTMLInputElement;
    await act(async () => { tick.click(); });
    expect(button("Use the most")!.disabled).toBe(false);
    await act(async () => { button("Use the most")!.click(); });
    expect(amountValue()).toBe("500000");
  });

  // The edge (Ethan's "recs", 2026-11-17): even the minimum is over the fee
  // limit — the over-limit most IS the minimum — so the default (the minimum)
  // would set it with no tick. The box starts empty instead.
  it("even the minimum over the limit: the box starts empty; only 'Withdraw the most now', ticked, reaches it", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT({ over: true, nowAmount: 250_000 }));
    await remount();
    expect(amountValue(), "no default amount").toBe("");
    expect(host.querySelectorAll(".withdraw-presets input").length, "no preset reaches it").toBe(0);
    expect(button("Use the most")!.disabled).toBe(true);
    await act(async () => { (host.querySelector("[data-testid='row-most-now'] input[type='checkbox']") as HTMLInputElement).click(); });
    await act(async () => { button("Use the most")!.click(); });
    expect(amountValue()).toBe("250000");
  });

  it("the advisor's ?amount= at the over-limit most is not kept as a default either", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT({ over: true, nowAmount: 500_000 }));
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(MemoryRouter, { initialEntries: ["/withdraw?amount=500000"] }, React.createElement(WithdrawBitcoin)));
    });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(amountValue()).toBe("");
  });

  it("over the limit, but the minimum is below the most: the minimum stays the default", async () => {
    // beforeEach: the most is 500,000, over the limit; the minimum 250,000 is not it.
    await mount();
    expect(amountValue()).toBe("250000");
  });

  it("not over the limit, the most at the minimum: the minimum stays the default", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT({ nowAmount: 250_000 }));
    await remount();
    expect(amountValue()).toBe("250000");
  });

  it("not over the limit: the preset at the most is offered", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT({ nowAmount: 500_000 }));
    await remount();
    expect(host.querySelector('.withdraw-presets input[value="500000"]')).not.toBeNull();
  });
});
