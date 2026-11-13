// The Automatic transfers page, redesigned (R48, R50, R51; built under R59
// [RELAYED — drive-mode arc chat, 2026-11-12]). Each describe names its rule.
//   R59(4) two answers, "Wait for low fees" (Recommended) and "Move sooner" /
//          merchant "Top up sooner"; no "Manual only" / "Only when I say"
//   R59(5) no "Turn on"; the status line says nothing is switched on; no
//          string claims transfers happen
//   R59(6) radio cards (native radios); the choice is committed ONLY by the
//          one Save; Save shows only when the form differs from the server;
//          "Saving…", "Saved.", "Couldn't save: {details}."
//          no "What can I do?"; limits collapsed and expanded, with one-line
//          hints; "How this works" as an aria-expanded toggle; tap-for-sats
//          amounts; no price: the rate sentence once, sats, no minimum
//          sentence; the heading "Automatic transfers" for both roles
//   R21(2) "Move sooner" below its size: disabled, unless it is the member's
//          current strategy
//   R59(1) no percent anywhere
//   R14    no "refuel"
// Rate $100,000/BTC, so 1,000 sats = $1.00.

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
import { RATE_NONE_SENTENCE } from "../api/rate";
import { cssRules, declsFor } from "../styleRules.testutil";

const b = (sats: number) => ({ sats, F: 0, S_min: 0, K: 0, Q: 0, H: 0, C: 0, r: 0.01 });

type Opts = { role?: string; strategy?: string; cap?: number | null; save?: number | null; open?: number | null; fee?: number; active?: boolean };

function settings(o: Opts = {}) {
  const role = o.role ?? "farmer";
  const fee = o.fee ?? (role === "merchant" ? 500 : 300);
  const values = { strategy: o.strategy ?? "save", fee_limit_usd_cents: fee, daily_fee_budget_usd_cents: 1_000, max_moved_per_day_usd_cents: 50_000 };
  return {
    settings: values,
    stored: { strategy: null, fee_limit_usd_cents: null, daily_fee_budget_usd_cents: null, max_moved_per_day_usd_cents: null, updated_at: null },
    defaults: { ...values, strategy: "save" },
    floors_usd_cents: { farmer: { save: 7_000, open: 14_000 }, merchant: { save: 20_000, open: 40_000 } },
    day_boundary_tz: "America/Chicago",
    member: {
      role,
      capacity_sats: o.cap === undefined ? 1_000_000 : o.cap,
      hub_active: o.active ?? true,
      save: o.save === null ? null : b(o.save ?? 406_055),
      open: o.open === null ? null : b(o.open ?? 499_002),
    },
  };
}

const FRESH = { usd: 100_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" };
const NONE = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getExchangeRate.mockResolvedValue(FRESH);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

/** A fresh page each time: a second mount in one test starts from scratch. */
async function mount(s: ReturnType<typeof settings>) {
  stub.getTransferSettings.mockResolvedValue(s);
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(AutomaticTransfers))); });
  await flush();
}

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const radio = (v: string) => host.querySelector(`input[type="radio"][value="${v}"]`) as HTMLInputElement;
const card = (v: string) => radio(v).closest("label")!;
const buttons = () => [...host.querySelectorAll("button")];
const button = (name: RegExp | string) => buttons().find((x) => (typeof name === "string" ? x.textContent === name : name.test(x.textContent ?? "")));
const saveButton = () => button("Save") ?? button("Saving…");
const field = (label: string) => {
  const l = [...host.querySelectorAll("label")].find((x) => x.textContent === label);
  return l ? (document.getElementById(l.htmlFor) as HTMLInputElement | null) : null;
};
const tooSmall = () => [...host.querySelectorAll(".radio-card-meta")].filter((m) => /too small/.test(m.textContent ?? ""));

async function choose(key: string) {
  await act(async () => { radio(key).click(); });
}
async function click(el: Element | undefined) {
  await act(async () => { (el as HTMLElement).click(); });
}
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("runtime", () => {
  it("runs on Node 20 (the pinned runtime)", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });
});

describe("the heading, lede, status and question, by role (R59(5), R59(6))", () => {
  it("farmer", async () => {
    await mount(settings());
    expect(host.querySelector("h1")?.textContent).toBe("Automatic transfers");
    expect(text()).toContain("Bitcorn can move your earnings to your wallet for you, so there's always room to get paid.");
    expect(host.querySelector('[data-testid="not-on"]')?.textContent).toBe("Automatic transfers aren't switched on yet.");
    expect(host.querySelector("h2")?.textContent).toBe("How should Bitcorn move your earnings?");
  });

  it("merchant: the same heading, merchant words", async () => {
    await mount(settings({ role: "merchant", save: 370_605, open: 636_167 }));
    expect(host.querySelector("h1")?.textContent).toBe("Automatic transfers");
    expect(text()).toContain("Bitcorn can top up your connection from your wallet for you, so you always have room to pay.");
    expect(host.querySelector('[data-testid="not-on"]')?.textContent).toBe("Auto top-up isn't switched on yet.");
    expect(host.querySelector("h2")?.textContent).toBe("How should Bitcorn top up your connection?");
  });
});

describe("two answers (R59(4))", () => {
  it("farmer: Wait for low fees (Recommended) and Move sooner, as native radios", async () => {
    await mount(settings());
    expect([...host.querySelectorAll('input[type="radio"]')].map((r) => (r as HTMLInputElement).value)).toEqual(["save", "open"]);
    expect(card("save").textContent).toContain("Wait for low fees");
    expect(card("save").querySelector(".badge")?.textContent).toBe("Recommended");
    expect(card("save").textContent).toContain("Moves bigger amounts when fees are low. Cheapest.");
    expect(card("open").textContent).toContain("Move sooner");
    expect(card("open").textContent).toContain("Smaller, more frequent moves. Costs a little more.");
  });

  it("merchant: Top up sooner", async () => {
    await mount(settings({ role: "merchant", save: 370_605, open: 636_167 }));
    expect(card("save").textContent).toContain("Adds bigger amounts when fees are low. Cheapest.");
    expect(card("open").textContent).toContain("Top up sooner");
    expect(card("open").textContent).toContain("Smaller, more frequent top-ups. Costs a little more.");
  });

  it("no Manual only, no Only when I say, no What can I do?, no percent", async () => {
    for (const role of ["farmer", "merchant"]) {
      await mount(settings({ role, cap: 350_000 }));
      await click(button(/How this works/));
      await click(button(/Change limits/));
      expect(text()).not.toMatch(/Manual only|Only when I say|What can I do|whichever is lower|%/);
      expect(host.querySelector('input[type="radio"][value="manual"]')).toBeNull();
    }
  });
});

describe("nothing claims transfers happen (R59(5))", () => {
  for (const role of ["farmer", "merchant"]) {
    it(`${role}: no 'Turn on', 'will move' or 'are on', with everything open`, async () => {
      await mount(settings({ role }));
      await click(button(/How this works/));
      await click(button(/Change limits/));
      expect(text()).not.toMatch(/turn on|will move|are on\b|is on\b/i);
      expect(buttons().some((x) => /turn on/i.test(x.textContent ?? ""))).toBe(false);
    });
  }
});

describe("the minimum: one sentence, where it blocks (R51; R21(2))", () => {
  it("(a) big enough: no sentence, both answers open", async () => {
    await mount(settings({ cap: 1_000_000 }));
    expect(tooSmall()).toEqual([]);
    expect(radio("open").disabled).toBe(false);
  });

  it("(b) below Wait for low fees' size: the sentence sits in the chosen card, marked; Move sooner needs a bigger connection", async () => {
    await mount(settings({ cap: 350_000 }));
    const s = tooSmall();
    expect(s.length).toBe(1);
    expect(card("save").contains(s[0])).toBe(true);
    expect(s[0].textContent).toBe("Your connection is too small for this yet: it holds $350.00, and this needs $406.06.");
    expect(s[0].querySelector(".warn-mark")).not.toBeNull();
    expect(radio("open").disabled).toBe(true);
    expect(card("open").textContent).toContain("Needs a bigger connection");
  });

  it("(c) Move sooner unavailable: disabled, and its card carries the sentence, unmarked", async () => {
    await mount(settings({ cap: 450_000 }));
    const s = tooSmall();
    expect(s.length).toBe(1);
    expect(card("open").contains(s[0])).toBe(true);
    expect(s[0].textContent).toBe("Your connection is too small for this yet: it holds $450.00, and this needs $499.00.");
    expect(s[0].querySelector(".warn-mark")).toBeNull();
    expect(radio("open").disabled).toBe(true);
    expect(card("open").textContent).toContain("Needs a bigger connection");
  });

  it("R21(2): Move sooner below its size stays choosable when it is the member's current strategy", async () => {
    await mount(settings({ strategy: "open", cap: 450_000 }));
    expect(radio("open").disabled).toBe(false);
    expect(radio("open").checked).toBe(true);
    const s = tooSmall();
    expect(s.length).toBe(1);
    expect(card("open").contains(s[0])).toBe(true);
    expect(s[0].textContent).toContain("this needs $499.00");
  });

  it("the amounts are tap-for-sats: a button named with both values, tapping shows sats", async () => {
    await mount(settings({ cap: 350_000 }));
    const amt = tooSmall()[0].querySelector("button.tap-amount") as HTMLButtonElement;
    expect(amt.getAttribute("aria-label")).toBe("$350.00, 350,000 sats");
    await click(amt);
    expect(amt.textContent).toBe("350,000 sats");
  });
});

describe("Save: one, only when something changed (R51; R59(6))", () => {
  it("hidden until a change; hidden again when the change is undone", async () => {
    await mount(settings());
    expect(saveButton()).toBeUndefined();
    await choose("open");
    expect(saveButton()).toBeDefined();
    await choose("save");
    expect(saveButton()).toBeUndefined();
  });

  it("a limit edit shows it; typing the same figure back hides it ('3' is $3.00)", async () => {
    await mount(settings());
    await click(button(/Change limits/));
    await type(field("Most you'll pay per transfer")!, "4");
    expect(saveButton()).toBeDefined();
    await type(field("Most you'll pay per transfer")!, "3");
    expect(saveButton()).toBeUndefined();
  });

  it("the choice is committed ONLY by Save: choosing sends nothing", async () => {
    await mount(settings());
    await choose("open");
    expect(stub.patchTransferSettings).not.toHaveBeenCalled();
  });

  it("Save sends only what changed, shows 'Saving…', then 'Saved.', and goes away", async () => {
    await mount(settings());
    let resolve!: (v: unknown) => void;
    stub.patchTransferSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    await choose("open");
    await click(saveButton());
    expect(stub.patchTransferSettings).toHaveBeenCalledWith({ strategy: "open" });
    expect(saveButton()?.textContent).toBe("Saving…");
    expect(radio("save").disabled, "the choice is held while saving").toBe(true);
    await act(async () => { resolve(settings({ strategy: "open" })); });
    await flush();
    expect(host.querySelector('[data-testid="save-msg"]')?.textContent).toBe("Saved.");
    expect(saveButton()).toBeUndefined();
  });

  it("a failed save: 'Couldn't save: {details}.', and Save stays", async () => {
    await mount(settings());
    stub.patchTransferSettings.mockRejectedValue(Object.assign(new Error("400"), { body: { details: ["fee_limit_usd_cents must be a positive whole number of cents"] } }));
    await click(button(/Change limits/));
    await type(field("Most you'll pay per transfer")!, "0");
    await click(saveButton());
    await flush();
    expect(host.querySelector('[data-testid="save-msg"]')?.textContent).toBe("Couldn't save: fee_limit_usd_cents must be a positive whole number of cents.");
    expect(saveButton()?.textContent).toBe("Save");
  });
});

describe("limits, collapsed and expanded (R48, R51)", () => {
  it("collapsed: the one number and 'Change limits ▸'; no fields, no hints", async () => {
    await mount(settings());
    expect(host.querySelector('[data-testid="limits-summary"]')?.textContent).toBe("Most you'll pay per transfer: $3");
    const t = button(/Change limits/)!;
    expect(t.textContent).toBe("Change limits ▸");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll("input.form-input").length).toBe(0);
    expect(host.querySelectorAll(".at-field-hint").length).toBe(0);
  });

  it("expanded: three fields at the defaults, each with its one-line hint, and the day boundary", async () => {
    await mount(settings());
    await click(button(/Change limits/));
    const t = button(/Hide limits/)!;
    expect(t.textContent).toBe("Hide limits ▾");
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-testid="limits-summary"]'), "the $3 is not shown twice").toBeNull();
    expect([field("Most you'll pay per transfer")!.value, field("Daily fee budget")!.value, field("Most moved per day")!.value]).toEqual(["3.00", "10.00", "500.00"]);
    expect([...host.querySelectorAll(".at-field-hint")].map((h) => h.textContent)).toEqual([
      "Checked against the quote before a move starts. A move that costs more waits.",
      "Moves stop for the day once their fees reach this.",
      "A bigger move is cut to fit, or waits until tomorrow.",
    ]);
    expect(host.querySelector('[data-testid="day-boundary"]')?.textContent).toBe("Daily limits reset at midnight US Central time.");
  });

  it("each hint describes its field", async () => {
    await mount(settings());
    await click(button(/Change limits/));
    const f = field("Daily fee budget")!;
    expect(document.getElementById(f.getAttribute("aria-describedby")!)?.textContent).toBe("Moves stop for the day once their fees reach this.");
  });

  it("collapsing again hides the hints", async () => {
    await mount(settings());
    await click(button(/Change limits/));
    await click(button(/Hide limits/));
    expect(host.querySelectorAll(".at-field-hint").length).toBe(0);
  });

  it("the hints sit at --d-label (0.8125rem), not the 0.6875rem badge size", () => {
    expect(declsFor(".at-field-hint")["font-size"]).toBe("var(--d-label)");
    expect(cssRules().some((r) => r.decls["--d-label"] === "0.8125rem"), "anti-vacuity: the token is 0.8125rem").toBe(true);
  });

  it("merchant: $5, per top-up, and 'Most added per day'", async () => {
    await mount(settings({ role: "merchant", save: 370_605, open: 636_167 }));
    expect(host.querySelector('[data-testid="limits-summary"]')?.textContent).toBe("Most you'll pay per top-up: $5");
    await click(button(/Change limits/));
    expect(field("Most you'll pay per top-up")!.value).toBe("5.00");
    expect(field("Most added per day")).not.toBeNull();
    expect([...host.querySelectorAll(".at-field-hint")].map((h) => h.textContent)).toEqual([
      "Checked against the quote before a top-up starts. A top-up that costs more waits.",
      "Top-ups stop for the day once their fees reach this.",
      "A bigger top-up is cut to fit, or waits until tomorrow.",
    ]);
  });
});

describe("How this works (R50(2), R50(3), R59(6))", () => {
  const FARMER = [
    "Your earnings build up in your connection to Bitcorn. To make room, Bitcorn sends a batch out through Loop, a swap service, and it lands in your node's wallet as regular bitcoin.",
    "A move of $250.00 costs about $1, including Bitcorn's fee.",
    "If a move would cost more than your limit, it waits until fees come down.",
    "Once a move has started, its network fee can rise with the market, up to Loop's own limit.",
  ];
  const MERCHANT = [
    "Every payment you make uses up room in your connection to Bitcorn. When room runs low, Bitcorn sends bitcoin from your node's wallet back into it through Loop, a swap service.",
    "A top-up of $250.00 costs about $2–3.",
    "If a top-up would cost more than your limit, it waits until fees come down.",
    "Once a top-up has started, its network fee follows the market.",
  ];
  const helpParas = () => [...host.querySelectorAll('[data-testid="help"] p')].map((p) => p.textContent);

  it("a toggle: aria-expanded false and nothing shown, then true and the farmer's four sentences", async () => {
    await mount(settings());
    const t = button(/How this works/)!;
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(helpParas()).toEqual([]);
    await click(t);
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(t.getAttribute("aria-controls")!)?.hidden).toBe(false);
    expect(helpParas()).toEqual(FARMER);
  });

  it("merchant: its own four, with no Loop-limit claim", async () => {
    await mount(settings({ role: "merchant", save: 370_605, open: 636_167 }));
    await click(button(/How this works/));
    expect(helpParas()).toEqual(MERCHANT);
    expect(text()).not.toContain("Loop's own limit");
  });

  it("its amount is tap-for-sats", async () => {
    await mount(settings());
    await click(button(/How this works/));
    expect((host.querySelector('[data-testid="help"] button.tap-amount') as HTMLButtonElement).getAttribute("aria-label")).toBe("$250.00, 250,000 sats");
  });
});

describe("no price (R59(6))", () => {
  it("the rate sentence once; amounts in sats, not tappable; no minimum sentence, nothing disabled", async () => {
    stub.getExchangeRate.mockResolvedValue(NONE);
    await mount(settings({ cap: 350_000, save: null, open: null }));
    await click(button(/How this works/));
    expect(text().split(RATE_NONE_SENTENCE).length - 1).toBe(1);
    expect(host.querySelectorAll("button.tap-amount").length).toBe(0);
    expect(host.querySelector('[data-testid="help"]')?.textContent).toContain("A move of 250,000 sats costs about $1");
    expect(tooSmall()).toEqual([]);
    expect(radio("open").disabled).toBe(false);
    expect(host.querySelector('[data-testid="limits-summary"]')?.textContent, "the limits are dollar settings").toBe("Most you'll pay per transfer: $3");
  });

  it("while the rate is loading: no sentence, and amounts are not tappable", async () => {
    stub.getExchangeRate.mockReturnValue(new Promise(() => {}));
    await mount(settings({ cap: 350_000 }));
    await click(button(/How this works/));
    expect(text()).not.toContain(RATE_NONE_SENTENCE);
    expect(host.querySelectorAll("button.tap-amount").length).toBe(0);
  });
});

describe("other states, kept", () => {
  it("connection down: nothing new on this page", async () => {
    await mount(settings({ active: false, cap: 1_000_000 }));
    expect(text()).not.toMatch(/connection is down|offline|reconnect/i);
    expect(host.querySelector("h2")?.textContent).toBe("How should Bitcorn move your earnings?");
  });

  it("no role: the not-on sentence and the role sentence; no answers", async () => {
    await mount(settings({ role: "unknown", save: null, open: null }));
    expect(host.querySelector('[data-testid="not-on"]')?.textContent).toBe("Automatic transfers aren't switched on yet.");
    expect(text()).toContain("Set your channel role in Settings to see what automatic transfers would do for your connection.");
    expect(host.querySelector('input[type="radio"]')).toBeNull();
  });

  it("a load error", async () => {
    stub.getTransferSettings.mockRejectedValue(new Error("Request failed"));
    await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(AutomaticTransfers))); });
    await flush();
    expect(text()).toContain("Couldn't load your settings: Request failed.");
  });

  for (const role of ["farmer", "merchant"]) {
    it(`R14: no 'refuel' on the ${role} page`, async () => {
      await mount(settings({ role }));
      await click(button(/How this works/));
      await click(button(/Change limits/));
      expect(text()).not.toMatch(/refuel/i);
    });
  }
});

describe("where it goes", () => {
  it("farmer: 'Where it goes: Your node's wallet'; merchant: 'Where it comes from: …'", async () => {
    await mount(settings());
    expect(host.querySelector('[data-testid="where"]')?.textContent).toBe("Where it goes: Your node's wallet");
    await mount(settings({ role: "merchant" }));
    expect(host.querySelector('[data-testid="where"]')?.textContent).toBe("Where it comes from: Your node's wallet");
  });
});
