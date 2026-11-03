// P12 p (loop-fee-ceilings spec §1.6, §7): the Withdraw panel's prepay copy.
// Polar gate 1's L3 found the prepay to be an advance on the principal —
// counted toward the amount withdrawn — not a fee.
// The label and the sentence are ruled verbatim; this pins them as rendered.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { QuoteFeeDetails } from "./WithdrawBitcoin";

const LABEL = "Prepay (part of your withdrawal)";
const SENTENCE =
  "Paid to the swap service up front and counted toward the amount you withdraw — not an extra fee. " +
  "If the withdrawal fails after it starts, the prepay may not be refunded.";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(prepay: number) {
  act(() => root.render(<QuoteFeeDetails swapFee={25} minerFee={3_793} prepay={prepay} />));
  // One space for every run of whitespace, as a reader sees it.
  return (host.textContent ?? "").replace(/\s+/g, " ");
}

describe("p: the Withdraw panel's prepay row and sentence", () => {
  it("the prepay row is labelled exactly 'Prepay (part of your withdrawal)', with its amount", () => {
    render(1_337);
    const labels = Array.from(host.querySelectorAll("details span")).map((s) => s.textContent);
    expect(labels).toContain(LABEL);
    const row = Array.from(host.querySelectorAll("details > div > div")).find(
      (d) => d.firstElementChild?.textContent === LABEL,
    );
    expect(row?.textContent).toContain("1,337");
  });

  it("the sentence is exactly the ruled one", () => {
    const text = render(1_337);
    expect(text).toContain(SENTENCE);
  });

  it("no returned-hold wording remains", () => {
    const text = render(1_337);
    expect(text).not.toMatch(/held temporarily|returned with your funds|Prepay hold/i);
  });

  it("no prepay, no row and no sentence", () => {
    const text = render(0);
    expect(text).not.toContain(LABEL);
    expect(text).not.toContain("Paid to the swap service");
  });
});
