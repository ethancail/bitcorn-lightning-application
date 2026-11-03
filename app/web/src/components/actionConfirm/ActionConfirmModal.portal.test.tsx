// Ruling ll (Polar gate 1, L5): the confirmation modal was clipped by its card.
//
// Mechanism: Refill and Withdraw render the modal inside `.panel.fade-in`.
// `.fade-in`'s `animation-fill-mode: both` leaves `transform: translateY(0)` on
// the panel, and any transform other than `none` makes that element the
// containing block for `position: fixed` descendants — so the "fixed" overlay
// was sized to the panel, and `.panel { overflow: hidden }` cut off the
// centred card's title and buttons. The fix renders the modal through a portal
// to document.body, out of every card, and caps the card at the viewport with
// its own scroll.
//
// jsdom has no layout, so the clip itself cannot be observed here; what is
// asserted is the property that removes it (the dialog is not inside the card)
// and the structure that keeps a tall card's title and buttons on screen: the
// card is capped at the viewport and only its middle scrolls.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library (the
// identifiers.guard.test.tsx idiom).

import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React, { useEffect } from "react";
import ActionConfirmModal, { useActionConfirm } from "./ActionConfirmModal";
import { summarizeLoopIn, summarizeLoopOut, type ActionSummary } from "./confirmAction";
import { declsFor } from "../../styleRules.testutil";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

function Harness({ summary }: { summary: ActionSummary }) {
  const c = useActionConfirm();
  useEffect(() => { c.open(summary); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The page's card, as RefillChannel.tsx / WithdrawBitcoin.tsx place it.
  return React.createElement(
    "div",
    { className: "panel fade-in", "data-testid": "page-card" },
    React.createElement("div", { className: "panel-body" },
      React.createElement(ActionConfirmModal, { controller: c, onConfirm: async () => undefined })),
  );
}

async function openInCard(summary: ActionSummary) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(Harness, { summary })); });
  const card = host.querySelector('[data-testid="page-card"]');
  const dialog = document.querySelector('[role="dialog"]');
  return { card, dialog };
}

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent === label);
}

const CASES: Array<[string, ActionSummary]> = [
  ["Loop In (/refill)", summarizeLoopIn({ amountSats: 250_000, feeSats: 1_200, authorizedMaxSats: 3_400 })],
  ["Loop Out (/withdraw)", summarizeLoopOut({
    amountSats: 300_000, destinationAddress: "bcrt1q" + "x".repeat(38), feeSats: 1_500, authorizedMaxSats: 9_000,
  })],
];

describe("ruling ll: the confirm modal renders outside the page's card", () => {
  for (const [name, summary] of CASES) {
    it(name, async () => {
      const { card, dialog } = await openInCard(summary);
      // Anti-vacuity: both ends exist, so "not contained" cannot pass on a null.
      expect(card).not.toBeNull();
      expect(dialog).not.toBeNull();

      expect(card!.contains(dialog)).toBe(false);
      expect(dialog!.parentElement).toBe(document.body);

      // Title and both buttons are in the document.
      expect(dialog!.querySelector(".dialog-title")?.textContent).toBe(summary.title);
      expect(buttonNamed(summary.confirmLabel)).toBeDefined();
      expect(buttonNamed("Cancel")).toBeDefined();
    });
  }

  it("the portal goes when the modal closes", async () => {
    const { dialog } = await openInCard(CASES[0][1]);
    expect(dialog).not.toBeNull();
    await act(async () => { buttonNamed("Cancel")!.click(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("ruling ll: a tall card scrolls inside the viewport", () => {
  it("the overlay is fixed to the viewport", () => {
    expect(declsFor(".dialog-overlay")).toMatchObject({ position: "fixed", inset: "0" });
  });

  it("the confirm card is capped at the viewport; only its middle scrolls", () => {
    expect(declsFor(".action-confirm-card")).toMatchObject({
      display: "flex", "flex-direction": "column", overflow: "hidden",
    });
    expect(declsFor(".action-confirm-card")["max-height"]).toMatch(/^calc\(100d?vh - \d+px\)$/);
    expect(declsFor(".action-confirm-scroll")).toMatchObject({ "overflow-y": "auto", "min-height": "0" });
  });

  for (const [name, summary] of CASES) {
    it(`${name}: the title and both buttons sit outside the scrolling region`, async () => {
      const { dialog } = await openInCard(summary);
      const card = dialog!.querySelector(".dialog-card.action-confirm-card");
      const scroll = card?.querySelector(".action-confirm-scroll");
      expect(card).not.toBeNull();
      expect(scroll).not.toBeNull();
      // The content does scroll: the rows are inside the region.
      expect(scroll!.querySelector("dl")).not.toBeNull();
      expect(scroll!.contains(card!.querySelector(".dialog-title"))).toBe(false);
      expect(scroll!.contains(buttonNamed(summary.confirmLabel)!)).toBe(false);
      expect(scroll!.contains(buttonNamed("Cancel")!)).toBe(false);
    });
  }
});
