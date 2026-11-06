// Drive-mode P3, plan item 2: the Automatic transfers page.
//   D3.2   no "Turn on" renders
//   R40(3) no on/off badge; "Automatic transfers aren't switched on yet."
//   R19(6) one minimum size — the strategy the member is on
//   R21(1) Manual only: Save on fees' size, as advice
//   R21(2) Keep room open below its size: unavailable, its sentence names its size
//   D3.4   the fee-limit label bounds the cost before a transfer starts
//          (R15(9)); the merchant text makes no 20% claim
//   R16(4) "Daily limits reset at midnight US Central time."
//   R14    no "refuel" anywhere a member reads
//   Saving sends only the fields the member changed (NULL = default).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getExchangeRate: vi.fn(),
  getTransferSettings: vi.fn(),
  patchTransferSettings: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: { ...(actual as any).api, getExchangeRate: stub.getExchangeRate },
    transfersApi: { getTransferSettings: stub.getTransferSettings, patchTransferSettings: stub.patchTransferSettings },
  };
});

import AutomaticTransfers from "./AutomaticTransfers";

const DEFAULTS = { strategy: "save", fee_limit_pct_bps: 200, fee_limit_usd_cents: 300, daily_fee_budget_usd_cents: 1_000, max_moved_per_day_usd_cents: 50_000 };
const b = (sats: number) => ({ sats, F: 0, S_min: 0, K: 0, Q: 0, H: 0, C: 0, r: 0.01 });

function settings(o: { role?: string; strategy?: string; cap?: number | null; save?: number | null; open?: number | null } = {}) {
  return {
    settings: { ...DEFAULTS, strategy: o.strategy ?? "save" },
    stored: { strategy: null, fee_limit_pct_bps: null, fee_limit_usd_cents: null, daily_fee_budget_usd_cents: null, max_moved_per_day_usd_cents: null, updated_at: null },
    defaults: DEFAULTS,
    floors_usd_cents: { farmer: { save: 7_000, open: 14_000 }, merchant: { save: 20_000, open: 40_000 } },
    day_boundary_tz: "America/Chicago",
    member: {
      role: o.role ?? "farmer",
      capacity_sats: o.cap === undefined ? 450_000 : o.cap,
      hub_active: true,
      save: o.save === null ? null : b(o.save ?? 406_055),
      open: o.open === null ? null : b(o.open ?? 499_002),
    },
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getExchangeRate.mockResolvedValue({ usd: 100_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const minLine = () => host.querySelector('[data-testid="min-line"]');
const amounts = (el: Element | null) => [...(el?.querySelectorAll('[data-testid="amount"]') ?? [])].map((a) => Number(a.getAttribute("data-sats")));

async function mount(s: ReturnType<typeof settings>) {
  stub.getTransferSettings.mockResolvedValue(s);
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(AutomaticTransfers))); });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function choose(key: string) {
  const radio = host.querySelector(`input[type="radio"][value="${key}"]`) as HTMLInputElement;
  await act(async () => { radio.click(); });
}

describe("nothing is switched on (D3.2, R40(3))", () => {
  it("no 'Turn on', no on/off badge; the not-on sentence shows", async () => {
    await mount(settings());
    expect(text()).not.toMatch(/turn on/i);
    expect(text()).not.toMatch(/Auto-transfer (on|off|paused)|Auto top-up (on|off|paused)/);
    expect(host.querySelector('[data-testid="not-on"]')?.textContent).toBe("Automatic transfers aren't switched on yet.");
  });

  it("the merchant page too", async () => {
    await mount(settings({ role: "merchant", save: 370_605, open: 636_167 }));
    expect(text()).not.toMatch(/turn on/i);
    expect(text()).toContain("Automatic transfers aren't switched on yet.");
    expect(text()).toContain("Auto top-up");
  });
});

describe("one minimum size (R19(6), R21)", () => {
  it("Save on fees: the line names Save on fees' size and the connection, and only those", async () => {
    await mount(settings({ cap: 450_000 }));
    expect(minLine()?.textContent).toMatch(/^Save on fees needs a connection of at least/);
    expect(amounts(minLine())).toEqual([406_055, 450_000]);
    // 450,000 < Keep room open's 499,002, so its row is unavailable and names its size (R21(2)).
    expect(amounts(host)).toEqual([499_002, 406_055, 450_000]);
  });

  it("Keep room open: its size alone; no second size anywhere", async () => {
    await mount(settings({ strategy: "open", cap: 600_000 }));
    expect(minLine()?.textContent).toMatch(/^Keep room open needs a connection of at least/);
    expect(amounts(host)).toEqual([499_002, 600_000]);
  });

  it("switching the choice switches the one size shown", async () => {
    await mount(settings({ cap: 600_000 }));
    expect(amounts(minLine())).toEqual([406_055, 600_000]);
    await choose("open");
    expect(amounts(minLine())).toEqual([499_002, 600_000]);
  });

  it("Manual only: Save on fees' size, as advice, gating nothing (R21(1))", async () => {
    await mount(settings({ strategy: "manual", cap: 350_000 }));
    expect(minLine()?.textContent).toMatch(/^Advice: to move on its own, Save on fees needs a connection of at least/);
    expect(minLine()?.textContent).toContain("Nothing is held back by this under Manual only.");
    expect(amounts(minLine())).toEqual([406_055, 350_000]);
  });

  it("below Keep room open's size: unavailable, not choosable, and its sentence names its own size (R21(2))", async () => {
    await mount(settings({ cap: 450_000 }));
    const open = host.querySelector('input[type="radio"][value="open"]') as HTMLInputElement;
    expect(open.disabled).toBe(true);
    const na = host.querySelector('[data-testid="open-unavailable"]');
    expect(na?.textContent).toMatch(/^Unavailable: Keep room open needs a connection of at least/);
    expect(amounts(na)).toEqual([499_002]);
  });

  it("at or above Keep room open's size: no unavailable sentence", async () => {
    await mount(settings({ cap: 600_000 }));
    expect(host.querySelector('[data-testid="open-unavailable"]')).toBeNull();
  });

  it("below the strategy's size: says it couldn't run yet", async () => {
    await mount(settings({ cap: 350_000 }));
    expect(minLine()?.textContent).toContain("so it couldn't run on its own yet. A bigger connection lets it start.");
  });

  it("amounts: dollars, with sats beneath (the interim)", async () => {
    await mount(settings({ cap: 450_000 }));
    // 450,000 sats at $100,000 = $450.00.
    expect(minLine()?.textContent).toContain("$450.00");
    expect(minLine()?.textContent).toContain("450,000 sats");
  });
});

describe("the rails' copy (D3.4, R15(9), R16(4))", () => {
  it("the fee-limit label says it is checked before the transfer starts", async () => {
    await mount(settings());
    expect(host.querySelector('[data-testid="fee-limit-label"]')?.textContent).toBe("Fee limit per transfer, checked before it starts");
  });

  it("farmer: Loop's 20% cap is stated", async () => {
    await mount(settings());
    expect(host.querySelector('[data-testid="fee-limit-help"]')?.textContent).toContain("20% of the amount");
  });

  it("merchant: no 20% claim", async () => {
    await mount(settings({ role: "merchant", save: 370_605, open: 636_167 }));
    expect(host.querySelector('[data-testid="fee-limit-help"]')?.textContent).not.toContain("20%");
  });

  it("US Central midnight is stated beside the daily rails", async () => {
    await mount(settings());
    expect(host.querySelector('[data-testid="day-boundary"]')?.textContent).toBe("Daily limits reset at midnight US Central time.");
  });

  it("the defaults show: 2% and $3.00; $10.00; $500.00", async () => {
    await mount(settings());
    const v = (label: string) => (host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement).value;
    expect([v("Maximum fee percent"), v("Maximum fee dollars"), v("Daily fee budget"), v("Most moved per day")]).toEqual(["2", "3.00", "10.00", "500.00"]);
  });

  it("'Your wallet' is shown as fixed (R7)", async () => {
    await mount(settings());
    expect(text()).toContain("Earnings go to");
    expect(text()).toContain("This is fixed.");
    expect(text()).toContain("Your wallet");
  });
});

describe("R14 terms", () => {
  for (const role of ["farmer", "merchant"]) {
    it(`no 'refuel' on the ${role} page`, async () => {
      await mount(settings({ role }));
      expect(text()).not.toMatch(/refuel/i);
    });
  }
});

describe("saving (NULL = default)", () => {
  it("sends only what changed", async () => {
    await mount(settings({ cap: 600_000 }));
    stub.patchTransferSettings.mockResolvedValue(settings({ strategy: "open", cap: 600_000 }));
    await choose("open");
    const save = [...host.querySelectorAll("button")].find((x) => x.textContent === "Save")!;
    await act(async () => { save.click(); });
    expect(stub.patchTransferSettings).toHaveBeenCalledWith({ strategy: "open" });
    expect(host.querySelector('[data-testid="save-msg"]')?.textContent).toBe("Saved.");
  });

  it("nothing changed: nothing is sent", async () => {
    await mount(settings());
    const save = [...host.querySelectorAll("button")].find((x) => x.textContent === "Save")!;
    await act(async () => { save.click(); });
    expect(stub.patchTransferSettings).not.toHaveBeenCalled();
  });
});
