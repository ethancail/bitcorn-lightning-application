// The member layout of the confirm dialog (member-first-run-ui slice 5,
// rulings (2), (3) and (8); vault decisions/2026-11-23-member-first-run-ui-
// slice-5-rulings-dialogs-payment-window-earnings-warning.md).
//
//   Withdraw: "Withdraw to your node's wallet"; the amount as dollars over
//     sats; "What it costs: about $X (N sats)"; a closed "Details" with the fee
//     limit and the 20% rule; "Goes to: Your node's bitcoin wallet" and no
//     address; "Can't be undone" as an icon line; "To confirm, type the sats
//     amount: N" with a "sats" label in the field; the main button on the RIGHT.
//   Top Up: "Top up your connection"; the same, with the plain line "The fee
//     is spent even if the top-up doesn't finish." in place of "Can't be undone".
//   Scoping (8): every summary without `member` — Kevin's treasury dialogs,
//     Payments, the Auto-Buy catch-up — renders as before: the old prompt, the
//     main button first, no member block.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library (the
// identifiers.guard.test.tsx idiom).

import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React, { useEffect } from "react";
import ActionConfirmModal, { useActionConfirm } from "./ActionConfirmModal";
import {
  summarizeCatchUp, summarizeCloseChannel, summarizeLoopIn, summarizeLoopOut,
  summarizeOpenMemberChannel, summarizePayInvoice, summarizeTreasuryOpenChannel, type ActionSummary,
} from "./confirmAction";
import { declsFor } from "../../styleRules.testutil";

const FRESH = { usd: 60_000, source: "coinbase", fetched_at: 1, age_ms: 0, state: "fresh" as const };
const NONE = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" as const };

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

function Harness({ summary, fail }: { summary: ActionSummary; fail?: boolean }) {
  const c = useActionConfirm();
  useEffect(() => { c.open(summary); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return React.createElement(ActionConfirmModal, {
    controller: c,
    onConfirm: async () => { if (fail) throw Object.assign(new Error("boom"), { status: 500 }); },
  });
}

async function open(summary: ActionSummary, fail = false): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(Harness, { summary, fail })); });
  const d = document.querySelector('[role="dialog"]') as HTMLElement | null;
  expect(d, "the dialog renders").not.toBeNull();
  return d!;
}

/** Each text node joined with a space, so neighbours don't glue ("…channel" +
 *  "Details" reading "channelDetails" would hide from a \b guard). */
function spaced(el: Element): string {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.nodeValue ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (d: Element) => [...d.querySelectorAll("button")].map((b) => text(b));

async function typeInto(d: Element, value: string) {
  const input = d.querySelector("#action-confirm-challenge") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const WITHDRAW = () => summarizeLoopOut({ amountSats: 300_000, feeSats: 1_500, authorizedMaxSats: 9_000, rate: FRESH });
const TOP_UP = () => summarizeLoopIn({ amountSats: 250_000, feeSats: 1_200, authorizedMaxSats: 3_400, rate: FRESH });

describe("slice 5 (2): Withdraw's confirm dialog", () => {
  it("the title is the action", async () => {
    const d = await open(WITHDRAW());
    expect(text(d.querySelector(".dialog-title"))).toBe("Withdraw to your node's wallet");
    expect(d.getAttribute("aria-label")).toBe("Withdraw to your node's wallet");
  });

  it("the amount is dollars over sats", async () => {
    const d = await open(WITHDRAW());
    const lines = [...d.querySelectorAll(".action-confirm-amount [data-line]")].map((l) => `${l.getAttribute("data-line")}:${l.textContent}`);
    expect(lines).toEqual(["usd:$180.00", "sats:300,000 sats"]);
  });

  it("one 'What it costs' line, about $X (N sats), from the estimate", async () => {
    const d = await open(WITHDRAW());
    const costs = [...d.querySelectorAll(".action-confirm-line")].map(text).filter((t) => t.startsWith("What it costs"));
    expect(costs).toEqual(["What it costs: about $0.90 (1,500 sats)"]);
  });

  it("'Goes to: Your node's bitcoin wallet', and no address or wrong-address sentence anywhere", async () => {
    const d = await open(WITHDRAW());
    const all = spaced(d);
    expect(all).toContain("Goes to: Your node's bitcoin wallet");
    expect(all).not.toMatch(/address/i);
    expect(d.querySelector(".ident")).toBeNull();
  });

  it("'Can't be undone' is an icon line, not a box", async () => {
    const d = await open(WITHDRAW());
    const final = d.querySelector(".action-confirm-final");
    expect(text(final)).toBe("Can't be undone");
    expect(final!.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(final!.closest(".alert")).toBeNull();
  });

  it("a closed Details holds the fee limit and the 20% rule", async () => {
    const d = await open(WITHDRAW());
    const details = d.querySelector("details.action-confirm-details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(text(details.querySelector("summary"))).toBe("Details");
    const inside = spaced(details);
    expect(inside).toContain("Most you allow in fees $5.40 (9,000 sats)");
    expect(inside).toContain("Once the withdrawal starts, the Bitcoin network fee follows the market, capped at 20% of the amount.");
    // Neither sits outside Details.
    const outside = spaced(d).replace(inside, "");
    expect(outside).not.toContain("Most you allow");
    expect(outside).not.toContain("20%");
  });

  it("'To confirm, type the sats amount: N', with a 'sats' label in the field", async () => {
    const d = await open(WITHDRAW());
    expect(text(d.querySelector("label[for='action-confirm-challenge']"))).toBe("To confirm, type the sats amount: 300,000");
    const input = d.querySelector("#action-confirm-challenge")!;
    const wrap = input.parentElement!;
    expect(wrap.classList.contains("action-confirm-sats")).toBe(true);
    expect(text(wrap.querySelector(".action-confirm-sats-unit"))).toBe("sats");
    // The input keeps both classes (confirmInput.test.ts) and stays in the scroll.
    expect(input.classList.contains("form-input") && input.classList.contains("action-confirm-input")).toBe(true);
    expect(input.closest(".action-confirm-scroll")).not.toBeNull();
  });

  it("the main button is on the RIGHT, and turns on only when the amount is typed", async () => {
    const d = await open(WITHDRAW());
    expect(buttons(d)).toEqual(["Cancel", "Withdraw"]);
    const main = [...d.querySelectorAll("button")].at(-1)!;
    expect(main.classList.contains("btn-primary")).toBe(true);
    expect(main.disabled).toBe(true);
    await typeInto(d, "300,000");
    expect(main.disabled).toBe(false);
  });

  it("after a failure, the main button ('Try again') is on the right too", async () => {
    const d = await open(WITHDRAW(), true);
    await typeInto(d, "300000");
    await act(async () => { [...d.querySelectorAll("button")].at(-1)!.click(); });
    expect(buttons(document.querySelector('[role="dialog"]')!)).toEqual(["Close", "Try again"]);
  });

  it("with no price: sats alone, and the cost in sats", async () => {
    const d = await open(summarizeLoopOut({ amountSats: 300_000, feeSats: 1_500, authorizedMaxSats: 9_000, rate: NONE }));
    expect([...d.querySelectorAll(".action-confirm-amount [data-line]")].map((l) => l.getAttribute("data-line"))).toEqual(["sats"]);
    expect(spaced(d)).toContain("What it costs: about 1,500 sats");
    expect(spaced(d)).toContain("Most you allow in fees 9,000 sats");
  });
});

describe("slice 5 (3): Top Up's confirm dialog", () => {
  it("'Top up your connection', the same layout, and the plain fee line instead of 'Can't be undone'", async () => {
    const d = await open(TOP_UP());
    expect(text(d.querySelector(".dialog-title"))).toBe("Top up your connection");
    expect([...d.querySelectorAll(".action-confirm-amount [data-line]")].map((l) => l.textContent)).toEqual(["$150.00", "250,000 sats"]);
    expect(spaced(d)).toContain("What it costs: about $0.72 (1,200 sats)");
    const final = d.querySelector(".action-confirm-final");
    expect(text(final)).toBe("The fee is spent even if the top-up doesn't finish.");
    expect(final!.querySelector("svg")).toBeNull();
    expect(spaced(d)).not.toContain("Can't be undone");
    const details = d.querySelector("details.action-confirm-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(spaced(details)).toContain("Most you allow in fees $2.04 (3,400 sats)");
    expect(text(d.querySelector("label[for='action-confirm-challenge']"))).toBe("To confirm, type the sats amount: 250,000");
    expect(d.querySelector(".action-confirm-sats-unit")).not.toBeNull();
    expect(buttons(d)).toEqual(["Cancel", "Top up"]);
  });
});

const CONNECT = () => summarizeOpenMemberChannel({
  capacitySats: 1_000_000, partnerSocket: "203.0.113.5:9735", fee: { label: "Economy", rate: 1 }, feeSats: 155, rate: FRESH,
});

describe("slice 5 (4): the member open-channel dialog, option C", () => {
  it("'Connect to BitCorn'; the size as dollars over sats; the network fee as 'What it costs'", async () => {
    const d = await open(CONNECT());
    expect(text(d.querySelector(".dialog-title"))).toBe("Connect to BitCorn");
    expect([...d.querySelectorAll(".action-confirm-amount [data-line]")].map((l) => l.textContent)).toEqual(["$600.00", "1,000,000 sats"]);
    expect(spaced(d)).toContain("What it costs: about $0.09 (155 sats)");
  });

  it("the Speed row is KEPT, visible, outside Details", async () => {
    const d = await open(CONNECT());
    const speed = [...d.querySelectorAll("dt")].find((t) => t.textContent === "Speed");
    expect(speed?.nextElementSibling?.textContent).toBe("Economy (about 1 sat/vB)");
    expect(speed!.closest("details")).toBeNull();
  });

  it("the plain line, no 'Can't be undone'; the address under Details, as an identifier", async () => {
    const d = await open(CONNECT());
    expect(text(d.querySelector(".action-confirm-final"))).toBe("The network fee is spent even if you close the connection later.");
    expect(d.querySelector(".action-confirm-final svg")).toBeNull();
    const details = d.querySelector("details.action-confirm-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const addr = [...details.querySelectorAll("dt")].find((t) => t.textContent === "Address")?.nextElementSibling;
    expect(addr?.textContent).toBe("203.0.113.5:9735");
    expect(addr?.classList.contains("ident")).toBe(true);
  });

  it("the typed-sats prompt with its label, and the main button on the right", async () => {
    const d = await open(CONNECT());
    expect(text(d.querySelector("label[for='action-confirm-challenge']"))).toBe("To confirm, type the sats amount: 1,000,000");
    expect(d.querySelector(".action-confirm-sats-unit")).not.toBeNull();
    expect(buttons(d)).toEqual(["Cancel", "Connect"]);
  });

  it("with no address there is no Details", async () => {
    const d = await open(summarizeOpenMemberChannel({ capacitySats: 1_000_000, fee: { label: "Economy", rate: 1 }, feeSats: 155, rate: FRESH }));
    expect(d.querySelector("details")).toBeNull();
  });
});

describe("slice 5: member text in the member dialogs", () => {
  for (const [name, make] of [["Withdraw", WITHDRAW], ["Top Up", TOP_UP], ["Connect", CONNECT]] as const) {
    it(`${name}: no "channel", "hub" or "operator"; "BitCorn" spelled so`, async () => {
      const d = await open(make());
      (d.querySelector("details") as HTMLDetailsElement).open = true;
      const words = `${spaced(d)} ${d.getAttribute("aria-label")}`;
      expect(words, "the scan reads the dialog").toContain("What it costs");
      expect(words).not.toMatch(/\bchannels?\b|\bhubs?\b|\boperators?\b/i);
      expect(words).not.toContain("Bitcorn");
    });
  }

  it("negative control: the guard catches a planted word", () => {
    expect("Refill this channel").toMatch(/\bchannels?\b|\bhubs?\b|\boperators?\b/i);
    expect("the Bitcorn treasury hub").toMatch(/\bchannels?\b|\bhubs?\b|\boperators?\b/i);
  });
});

// ─── (8) Scoping: every other summary is left as it is ──────────────────────
describe("slice 5 (8): the dialogs without the member layout are unchanged", () => {
  const OTHERS: Array<[string, ActionSummary, string]> = [
    ["Kevin's treasury open", summarizeTreasuryOpenChannel({ peerPubkey: "02" + "ab".repeat(32), capacitySats: 2_000_000, fee: { label: "Economy", rate: 1 } }), "Type the amount to confirm: 2,000,000"],
    ["Kevin's close", summarizeCloseChannel({ channelId: "842391119757312" }), "Type CLOSE to confirm"],
    ["Payments", summarizePayInvoice({ amountSats: 25_000, destination: "02abcdef1234567890", maxFeeSats: 30 }), "Type the amount to confirm: 25,000"],
    ["Auto-Buy catch-up", summarizeCatchUp({ intervals: 2, fitsIntervals: 2, fitsUsd: 1100, remainderIntervals: 0 }), "Type 1100.00 to confirm"],
  ];
  for (const [name, summary, prompt] of OTHERS) {
    it(`${name}: no member block, the old prompt, no sats label, the main button first`, async () => {
      expect(summary.member).toBeUndefined();
      const d = await open(summary);
      expect(d.querySelector(".action-confirm-member")).toBeNull();
      expect(d.querySelector(".action-confirm-sats")).toBeNull();
      expect(text(d.querySelector("label[for='action-confirm-challenge']"))).toBe(prompt);
      expect(buttons(d)).toEqual([summary.confirmLabel, "Cancel"]);
      // The input's parent is the challenge block itself, as before.
      expect(d.querySelector("#action-confirm-challenge")!.parentElement!.querySelector("label")).not.toBeNull();
      expect(d.querySelector("dl")!.children.length).toBe(summary.rows.length);
    });
  }
});

describe("slice 5: the member layout's styles add nothing to the shared input", () => {
  it(".action-confirm-input still sets only its 44px; the sats room is on the wrapper", () => {
    expect(declsFor(".action-confirm-input")).toEqual({ "min-height": "44px" });
    expect(declsFor(".action-confirm-sats .form-input")["padding-right"]).toBe("42px");
    expect(declsFor(".action-confirm-sats-unit")).toMatchObject({ position: "absolute", "pointer-events": "none" });
  });
});
