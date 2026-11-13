// The amount (member-first-run-ui slice 1, ruled 2026-11-13): dollars, with
// the sats ALWAYS directly under them, smaller; nothing behind a tap. With no
// exchange rate, sats only plus the descriptor's one-line note. Formats and
// copy are amountDescriptor.ts's (amount component spec §1 items 3, 4, 6, 8).
//
// The negative control for "both lines in every state": delete the sats line
// from Amount.tsx and that describe goes red.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import type { ExchangeRate } from "../../api/client";
import { declsFor } from "../../styleRules.testutil";
import { Amount, type AmountSize } from "./Amount";
import { NO_RATE_NOTE, formatSats } from "./amountDescriptor";

const rate = (usd: number | null, state: ExchangeRate["state"] = "fresh"): ExchangeRate =>
  ({ usd, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state });

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

async function show(sats: number | null, r: ExchangeRate | null | undefined, size?: AmountSize) {
  await act(async () => { root.render(React.createElement(Amount, { sats, rate: r, size })); });
}

const amount = () => host.querySelector(".amount") as HTMLElement;
/** The component's lines, top to bottom, as [what each holds, its text]. */
const lines = () => [...amount().children].map((c) => [(c as HTMLElement).dataset.line, c.textContent]);

describe("both lines, in every state", () => {
  const RATES: Array<[string, ExchangeRate]> = [["fresh", rate(76_848.88)], ["stale", rate(76_848.88, "stale")]];
  const SATS = [0, 1, 7, 49_619, 1_606_563_000];
  for (const size of ["hero", "inline"] as const) {
    for (const [name, r] of RATES) {
      for (const sats of SATS) {
        it(`${size}, ${name} rate, ${sats} sats: dollars, then the sats directly under them`, async () => {
          await show(sats, r, size);
          const ls = lines();
          expect(ls.map(([line]) => line)).toEqual(["usd", "sats"]);
          expect(ls[1][1]).toBe(formatSats(sats));
          // Directly under: the sats line is the dollars line's next sibling.
          expect(amount().querySelector('[data-line="usd"]')!.nextElementSibling)
            .toBe(amount().querySelector('[data-line="sats"]'));
        });
      }
    }
  }

  it("the sats are always shown: with no rate, and while the rate loads, they are the figure", async () => {
    for (const r of [rate(null, "none"), rate(76_848.88, "none"), rate(null, "fresh"), null, undefined]) {
      await show(49_619, r);
      expect(amount().querySelector('[data-line="sats"]')?.textContent).toBe("49,619 sats");
    }
  });

  it("nothing is behind a tap: no button, nothing focusable, no aria-live", async () => {
    await show(49_619, rate(76_848.88), "hero");
    expect(host.querySelector("button, [role=button], [tabindex], [aria-live]")).toBeNull();
  });
});

describe("no exchange rate", () => {
  for (const [name, r] of [
    ["state none", rate(null, "none")],
    ["state none, a usd left over", rate(76_848.88, "none")],
    ["no usd", rate(null, "fresh")],
    ["unread (null)", null],
  ] as const) {
    it(`${name}: sats only, then the descriptor's one-line note`, async () => {
      await show(49_619, r as ExchangeRate | null);
      expect(lines()).toEqual([["sats", "49,619 sats"], ["note", NO_RATE_NOTE]]);
      expect(host.textContent).not.toContain("$");
    });
  }

  it("the note is the descriptor's, verbatim (spec §1 item 6)", () => {
    expect(NO_RATE_NOTE).toBe("The bitcoin price isn't available right now, so amounts are shown in sats.");
  });

  it("loading (rate undefined): sats alone; the note never shows while the rate loads (R31)", async () => {
    await show(49_619, undefined);
    expect(lines()).toEqual([["sats", "49,619 sats"]]);
  });
});

describe("number formatting", () => {
  const usdOf = async (sats: number, usd: number) => {
    await show(sats, rate(usd));
    return amount().querySelector('[data-line="usd"]')!.textContent;
  };
  it("cents always: 49,619 sats at $76,848.88 is $38.13", async () => {
    expect(await usdOf(49_619, 76_848.88)).toBe("$38.13");
  });
  it("thousands separators, no compact form: $1,234,567.89", async () => {
    expect(await usdOf(1_234_567_890, 100_000)).toBe("$1,234,567.89");
  });
  it("half-up to the cent: 10,000 sats at $150 is $0.015 → $0.02", async () => {
    expect(await usdOf(10_000, 150)).toBe("$0.02");
  });
  it("non-zero under a cent: '< $0.01'", async () => {
    expect(await usdOf(1, 73_700)).toBe("< $0.01");
  });
  it("zero: '$0.00' over '0 sats'", async () => {
    await show(0, rate(73_700));
    expect(lines()).toEqual([["usd", "$0.00"], ["sats", "0 sats"]]);
  });
  it("sats: comma separators and a lowercase unit; singular '1 sat'", async () => {
    await show(49_619, rate(73_700));
    expect(amount().querySelector('[data-line="sats"]')!.textContent).toBe("49,619 sats");
    await show(1, rate(73_700));
    expect(amount().querySelector('[data-line="sats"]')!.textContent).toBe("1 sat");
  });
});

describe("edges", () => {
  it("unknown (null): '—'", async () => {
    await show(null, rate(73_700));
    expect(lines()).toEqual([["unknown", "—"]]);
  });
  it("a negative renders '—' and warns in development (R30(2))", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await show(-5, rate(73_700));
    expect(lines()).toEqual([["unknown", "—"]]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("sizes", () => {
  it("the size is a class: inline by default, hero when asked", async () => {
    await show(49_619, rate(73_700));
    expect(amount().classList.contains("amount-inline")).toBe(true);
    await show(49_619, rate(73_700), "hero");
    expect(amount().classList.contains("amount-hero")).toBe(true);
  });
  it("hero is 35px over 17.5px at text 1.0 (the 14px root)", () => {
    expect(parseFloat(declsFor(".amount-hero .amount-figure")["font-size"]) * 14).toBe(35);
    expect(parseFloat(declsFor(".amount-hero .amount-sub")["font-size"]) * 14).toBe(17.5);
  });
  it("inline: the sats are smaller than the figure, at --t-xs", () => {
    expect(declsFor(".amount-inline .amount-sub")["font-size"]).toBe("0.75rem");
  });
});
