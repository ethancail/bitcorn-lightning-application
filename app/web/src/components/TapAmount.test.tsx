// R59(6) [RELAYED — drive-mode arc chat, 2026-11-12]: the interim
// tap-for-sats amount on the Automatic transfers page, per the amount
// component spec §1 items 3–8 (specs/2026-11-04-drive-mode-amount-component-
// behaviour.md, R29/R30/R31), until member-first-run-ui ships the component.
//   3 DOLLARS — cents always; "< $0.01" under a cent; "$0.00" at zero;
//     half-up to the cent; a negative renders "—" and warns in development
//   4 SATS    — "49,619 sats", "1 sat"
//   5 TAP     — fresh/stale: a button toggling dollars ↔ sats, one face at a
//     time; its accessible name carries both ("$38.13, 49,619 sats";
//     "less than $0.01, <n> sats"); no aria-live. none: sats, not a button.
//     A toggled instance stays toggled as its value changes (R30(5)); a
//     recovered "none" shows dollars, no earlier toggle carried over (R31)
//   8 EDGES   — unknown (null): "—", not interactive
//   item 1    — loading (rate undefined): sats, not interactive (R30(3))
// Items 6 and 7 are the page's: AutomaticTransfers.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import type { ExchangeRate } from "../api/client";
import { TapAmount } from "./TapAmount";

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

async function show(sats: number | null, r: ExchangeRate | null | undefined) {
  await act(async () => { root.render(React.createElement(TapAmount, { sats, rate: r })); });
}

const btn = () => host.querySelector("button");
const face = () => (host.textContent ?? "").trim();

describe("runtime", () => {
  it("runs on Node 20 (the pinned runtime)", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });
});

describe("3 — dollars", () => {
  it("cents always: 49,619 sats at $76,848.88 is $38.13", async () => {
    await show(49_619, rate(76_848.88));
    expect(face()).toBe("$38.13");
  });

  it("thousands separators, no compact form: $1,234,567.89", async () => {
    await show(1_234_567_890, rate(100_000));
    expect(face()).toBe("$1,234,567.89");
  });

  it("half-up to the cent: 10,000 sats at $150 is $0.015 → $0.02", async () => {
    await show(10_000, rate(150));
    expect(face()).toBe("$0.02");
  });

  it("non-zero under a cent: '< $0.01'", async () => {
    await show(1, rate(73_700));
    expect(face()).toBe("< $0.01");
  });

  it("zero: '$0.00', and tappable", async () => {
    await show(0, rate(73_700));
    expect(face()).toBe("$0.00");
    expect(btn()).not.toBeNull();
  });

  it("a negative renders '—' and warns in development", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await show(-5, rate(73_700));
    expect(face()).toBe("—");
    expect(btn()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("4 — sats", () => {
  it("comma separators and a lowercase unit: '49,619 sats'", async () => {
    await show(49_619, rate(null, "none"));
    expect(face()).toBe("49,619 sats");
  });

  it("singular: '1 sat'", async () => {
    await show(1, rate(null, "none"));
    expect(face()).toBe("1 sat");
  });

  it("zero with no rate: '0 sats'", async () => {
    await show(0, rate(null, "none"));
    expect(face()).toBe("0 sats");
  });
});

describe("5 — tap", () => {
  it("a button whose accessible name carries both values", async () => {
    await show(49_619, rate(76_848.88));
    expect(btn()!.getAttribute("type")).toBe("button");
    expect(btn()!.getAttribute("aria-label")).toBe("$38.13, 49,619 sats");
  });

  it("'< $0.01' is named 'less than $0.01, 1 sat'", async () => {
    await show(1, rate(73_700));
    expect(btn()!.getAttribute("aria-label")).toBe("less than $0.01, 1 sat");
  });

  it("a tap toggles dollars ↔ sats, one face at a time", async () => {
    await show(49_619, rate(76_848.88));
    await act(async () => { btn()!.click(); });
    expect(face()).toBe("49,619 sats");
    await act(async () => { btn()!.click(); });
    expect(face()).toBe("$38.13");
  });

  it("stale: still dollars and tappable", async () => {
    await show(49_619, rate(76_848.88, "stale"));
    expect(face()).toBe("$38.13");
    expect(btn()).not.toBeNull();
  });

  it("none: sats only, not a button", async () => {
    await show(49_619, rate(null, "none"));
    expect(btn()).toBeNull();
    expect(host.querySelector('[role="button"]')).toBeNull();
  });

  it("no aria-live anywhere", async () => {
    await show(49_619, rate(76_848.88));
    await act(async () => { btn()!.click(); });
    expect(host.querySelector("[aria-live]")).toBeNull();
  });

  it("R30(5): a toggled instance stays toggled as its value changes", async () => {
    await show(49_619, rate(76_848.88));
    await act(async () => { btn()!.click(); });
    await show(60_000, rate(76_848.88));
    expect(face()).toBe("60,000 sats");
  });

  it("R31: a recovered 'none' rate shows dollars, with no earlier toggle carried over", async () => {
    await show(49_619, rate(76_848.88));
    await act(async () => { btn()!.click(); });
    expect(face()).toBe("49,619 sats");
    await show(49_619, rate(null, "none"));
    expect(face()).toBe("49,619 sats");
    await show(49_619, rate(76_848.88));
    expect(face()).toBe("$38.13");
  });
});

describe("8 — edges, and item 1's loading", () => {
  it("unknown (null): '—', not interactive", async () => {
    await show(null, rate(76_848.88));
    expect(face()).toBe("—");
    expect(btn()).toBeNull();
  });

  it("loading (rate undefined): sats, not interactive", async () => {
    await show(49_619, undefined);
    expect(face()).toBe("49,619 sats");
    expect(btn()).toBeNull();
  });

  it("no rate read at all (null): sats, not interactive", async () => {
    await show(49_619, null);
    expect(face()).toBe("49,619 sats");
    expect(btn()).toBeNull();
  });
});
