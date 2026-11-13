// Withdraw's and Top Up's option cards under R59 [RELAYED — drive-mode arc
// chat, 2026-11-12]:
//   R59(2) no price: a card is NOT flagged over the limit (the server sends
//          over_fee_limit false and fee_limit_checked false). Each card whose
//          fee shows carries ONE neutral sentence, "Can't check this against
//          your fee limit right now: the bitcoin price isn't available.", and
//          its fee still shows, in sats. No "Allow it this once" lock.
//   R59(4) the reason line names the strategy as the page does: "Move
//          sooner" / merchant "Top up sooner" (was "Keep room open").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import type { SwapOptions } from "../api/client";
import { OptionCards, reasonText, NO_PRICE_LIMIT_SENTENCE } from "./OptionCards";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

function topUp(o: { checked: boolean }): SwapOptions {
  return {
    direction: "loop_in", state: "ok", strategy: "save", floor_sats: null, room_sats: 140_000, calm: "unknown",
    min_sats: 100_000, trigger_sats: null, quote_state: "ok", fee_limit_checked: o.checked, reason: "enough_ready",
    cards: [
      { key: "now", amount_sats: 260_000, fee_sats: 3_300, over_fee_limit: false, recommended: false },
      { key: "wait_lower", amount_sats: null, fee_sats: null, over_fee_limit: false, recommended: true },
    ],
  };
}

async function show(options: SwapOptions, usd: number | null) {
  await act(async () => {
    root.render(React.createElement(OptionCards, { options, usd, onUse: vi.fn(), onLeave: vi.fn(), onDeposit: vi.fn() }));
  });
}

const card = (k: string) => host.querySelector(`[data-testid="option-card-${k}"]`)!;
const unchecked = () => [...host.querySelectorAll('[data-testid="limit-unchecked"]')];

describe("runtime", () => {
  it("runs on Node 20 (the pinned runtime)", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });
});

describe("R59(2): no price", () => {
  it("the sentence, verbatim", () => {
    expect(NO_PRICE_LIMIT_SENTENCE).toBe("Can't check this against your fee limit right now: the bitcoin price isn't available.");
  });

  it("the card with a fee carries the one neutral sentence, its fee in sats, and no over-limit lock", async () => {
    await show(topUp({ checked: false }), null);
    expect(unchecked().length).toBe(1);
    expect(card("now").contains(unchecked()[0])).toBe(true);
    expect(unchecked()[0].textContent).toBe(NO_PRICE_LIMIT_SENTENCE);
    expect(unchecked()[0].closest(".warn-mark"), "neutral: no warning mark").toBeNull();
    expect(card("now").textContent).toContain("3,300 sats");
    expect(host.querySelector('[data-testid="over-limit"]')).toBeNull();
    expect(host.textContent).not.toContain("Allow it this once");
    const use = [...card("now").querySelectorAll("button")].find((b) => b.textContent === "Use this amount")!;
    expect(use.disabled).toBe(false);
  });

  it("a card with no fee carries no sentence", async () => {
    await show(topUp({ checked: false }), null);
    expect(card("wait_lower").querySelector('[data-testid="limit-unchecked"]')).toBeNull();
  });

  it("with a price (checked), no such sentence", async () => {
    await show(topUp({ checked: true }), 100_000);
    expect(unchecked()).toEqual([]);
  });
});

// R59(4) gave the name; Ethan's "recs" 2026-11-12 (1) dropped the "which…"
// clause, which only repeated the name.
describe("R59(4): the strategy's name in the reason line", () => {
  it("farmer: Move sooner", () => {
    expect(reasonText("keep_room_open", true)).toBe("You're on Move sooner.");
  });
  it("merchant: Top up sooner", () => {
    expect(reasonText("keep_room_open", false)).toBe("You're on Top up sooner.");
  });
  it("no 'Keep room open' left in any reason", () => {
    const reasons = ["room_low", "fees_low", "fees_high", "over_fee_limit", "bigger_share", "keep_room_open", "plenty_ready", "enough_ready", "wallet_low"] as const;
    for (const r of reasons) for (const f of [true, false]) expect(reasonText(r, f)).not.toContain("Keep room open");
  });
});
