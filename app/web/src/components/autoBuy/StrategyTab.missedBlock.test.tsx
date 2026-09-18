// Controls for the "Missed buys" block — spec §4 A1–A3 and §5's accepted strings.
//
// Authority: bitcorn-research/specs/2026-09-14-autobuy-scheduler-catchup-clamp-spec.md
// (blob 63d8840 @ vault bec59fe, eleven correction waves — R-bal accepted in
// the eleventh; the nine-wave blob 7beb628 this file first cited predates it).
//
// ─── WHY THIS FILE IS .tsx AND WHY THAT IS NEW ──────────────────────────────
// `vitest.config.ts` collected only `*.test.ts` until 2026-09-18; the block's
// claims were "read-verified, not test-pinnable" by the spec's own §7. The
// config was broadened (and the React plugin added) so these can be collected
// at all. No React Testing Library — `createRoot` inside `act()`, asserting on
// the real DOM, which is the approach the R3 fallback probe proved on this repo.
//
// ─── WHAT THESE ASSERT, AND WHY EACH SHAPE ──────────────────────────────────
// · CONTENT, not the absence of wrong content. `expect(html).not.toContain(…)`
//   passes on an empty render, so every assertion here names the string that
//   MUST be present.
// · The CHALLENGE TARGET, not the challenge's existence. A test asserting a
//   challenge exists passes on `{ kind: "phrase", text: "" }` — so the target's
//   exact two-decimal form is asserted, and asserted to equal the amount the
//   body shows in value.
// · The GATE, not the import. `wiring.test.ts` proves a page imports the
//   machinery; it cannot prove the button is disabled until the challenge is
//   satisfied. That is proven here by typing a wrong value, a right one, and
//   reading `disabled` in each state.
// · THE PERMITTING DIRECTION. A suite that only forbids wrong copy passes a
//   collapsed model — the vault's demonstration is
//   `deltas/2026-09-02-farmer-loop-copy-arc-deltas.md`, where collapsing the
//   discriminator left every refusal-direction test green and only the
//   permission-direction tests went red. So the block MUST render, the button
//   MUST enable, and the confirm MUST fire the request.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import type { AutoBuyStatus, AutoBuyMissed } from "../../api/client";

const stub = vi.hoisted(() => ({
  catchUpAutoBuy: vi.fn(),
  executeAutoBuyNow: vi.fn(),
  getAutoBuyHistory: vi.fn(async () => ({ rows: [], total: 0, limit: 25, offset: 0 })),
  enableAutoBuy: vi.fn(),
  pauseAutoBuy: vi.fn(),
  updateAutoBuyConfig: vi.fn(),
  getAutoBuyCredentialsStatus: vi.fn(async () => null),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

vi.mock("./CoinbaseCard", () => ({ default: () => React.createElement("div", null, "coinbase-card-stub") }));
vi.mock("./HistoryTable", () => ({ default: () => React.createElement("div", null, "history-stub") }));

import StrategyTab from "./StrategyTab";

const WEEK = 7 * 86400;
const NOW = 1789646400;

function cfg(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    base_unit_usd: 100,
    frequency: "weekly",
    zone_multipliers: { extreme_buy: 3, undervalued: 2, fair_value: 1, elevated: 0.5, overvalued: 0.25, extreme_sell: 0 },
    currency_preference: "usdc_preferred",
    withdraw_address: "bc1qstub",
    withdraw_address_whitelisted_at: NOW - 10 * WEEK,
    sweep_day_of_week: 0,
    consecutive_failures: 0,
    paused_reason: null,
    last_run_at: NOW - WEEK,
    next_run_at: NOW + WEEK,
    ...over,
  };
}

/** The whole, nothing withheld: 11 × $100 at 1×. */
const MISSED_FULL: AutoBuyMissed = {
  intervals: 11,
  base_unit_usd: 100,
  oldest_slot: NOW - 11 * WEEK,
  newest_slot: NOW - 1 * WEEK,
  multiplier: 1,
  zone: "fair_value",
  valuation_updated_at: new Date(NOW * 1000).toISOString(),
  estimated_usd: 1100,
  fits_now: { intervals: 11, estimated_usd: 1100 },
  remainder: null,
};

/** The caps bind: 10 of 11 fit the 7-day window, one remains. */
const MISSED_PARTIAL: AutoBuyMissed = {
  ...MISSED_FULL,
  fits_now: { intervals: 10, estimated_usd: 1000 },
  remainder: { intervals: 1, estimated_usd: 100, binding_window: "7d" },
};

/** No valuation: count and slots survive, every amount is null. */
const MISSED_DEGRADED: AutoBuyMissed = {
  intervals: 11,
  base_unit_usd: 100,
  oldest_slot: NOW - 11 * WEEK,
  newest_slot: NOW - 1 * WEEK,
  multiplier: null,
  zone: null,
  valuation_updated_at: null,
  estimated_usd: null,
  fits_now: null,
  remainder: null,
};

const status = (missed: AutoBuyMissed | null, over: Record<string, unknown> = {}): AutoBuyStatus =>
  ({ config: cfg(over), credentials: null, in_flight: [], recent: [], missed }) as unknown as AutoBuyStatus;

const valuation = { z_score: -0.4, zone: "fair_value", price_usd: 60000, updated_at: new Date(NOW * 1000).toISOString() } as any;

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactElement): Promise<void> {
  await act(async () => { root.render(node); });
  await act(async () => { await Promise.resolve(); });
}

/** Find a button by its exact visible text. */
const btn = (text: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

/**
 * The Missed-buys panel's own text, scoped.
 *
 * Scoping keeps a block-level claim about the block, so a change to a
 * neighbouring panel cannot turn one of these assertions green or red for the
 * wrong reason.
 *
 * ⚠ It was originally introduced for a narrower reason that no longer holds:
 * StrategyTab's summary banner used to render the raw zone token, so a
 * page-wide `not.toContain("fair_value")` failed on copy this arc had not
 * written. Ethan later ruled that banner in, it now renders the label through
 * `zoneLabelFor`, and the page-wide assertion lives in the last describe below.
 */
function block(): string {
  const panel = Array.from(host.querySelectorAll(".panel")).find(
    (p) => p.querySelector(".panel-header")?.textContent?.trim() === "Missed buys",
  );
  return panel?.textContent ?? "";
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

/** Type into the modal's challenge input the way React's onChange sees it. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.catchUpAutoBuy.mockResolvedValue({ ok: true, intervals: 11, usd: 1100, remainder_intervals: 0 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

// ─────────────────────────────────────────────────────────────────────────────
// A1 / B-full — the block renders, with the accepted words and REAL values.
// ─────────────────────────────────────────────────────────────────────────────
describe("the Missed buys block renders real values", () => {
  it("renders the header and B-full verbatim, with the amounts filled in", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_FULL), valuation, onRefresh: async () => {} }));
    const text = host.textContent ?? "";

    expect(text).toContain("Missed buys");
    // The accepted body, with every placeholder resolved. Asserting the whole
    // sentence — not a fragment — is what makes a reworded string fail here.
    expect(text).toContain(
      "11 weekly buys were missed between",
    );
    expect(text).toContain(
      ". Buying them now would place one order of about $1,100.00 (11 × $100.00 × 1× Fair Value) at today's price. The final amount is set when you confirm.",
    );
    // ZONE-LABEL (sixth wave item 8): the LABEL, never the wire token —
    // asserted over THE BLOCK, for the reason given at `block()`.
    expect(block()).toContain("Fair Value");
    expect(block()).not.toContain("fair_value");
  });

  it("renders the button (BTN), so the block is actionable — the permitting direction", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_FULL), valuation, onRefresh: async () => {} }));
    expect(btn("Buy missed intervals")).toBeDefined();
  });

  it("renders NOTHING when there are no unclaimed intervals — no empty state, no '0 missed' (A1)", async () => {
    await render(React.createElement(StrategyTab, { status: status(null), valuation, onRefresh: async () => {} }));
    expect(host.textContent ?? "").not.toContain("Missed buys");
    expect(btn("Buy missed intervals")).toBeUndefined();
  });

  it("renders the block while enabled = 0 (sixth wave, item 7 — it renders, carrying NS)", async () => {
    await render(React.createElement(StrategyTab, {
      status: status(MISSED_FULL, { enabled: false, paused_reason: "user_paused" }),
      valuation, onRefresh: async () => {},
    }));
    expect(host.textContent ?? "").toContain("Missed buys");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B-partial — the caps bind. Ruling 6: the window is named as rolling days.
// ─────────────────────────────────────────────────────────────────────────────
describe("the partial offer names the binding window", () => {
  it("renders B-partial with the fitting portion, the remainder, and the 7-day window", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_PARTIAL), valuation, onRefresh: async () => {} }));
    const text = host.textContent ?? "";

    expect(text).toContain(
      "10 of 11 missed buys fit within this 7-day limit: about $1,000.00. 1 missed buy (about $100.00) remains and can be bought once the limit frees up.",
    );
    // Ruling 6 — the windows are ROLLING, not calendar.
    expect(text).not.toContain("this week's limit");
    expect(text).not.toContain("this month's limit");
  });

  it("names the 30-day window when THAT is the one that binds — not a hardcoded 7", async () => {
    const thirty: AutoBuyMissed = {
      ...MISSED_PARTIAL,
      remainder: { intervals: 1, estimated_usd: 100, binding_window: "30d" },
    };
    await render(React.createElement(StrategyTab, { status: status(thirty), valuation, onRefresh: async () => {} }));
    expect(host.textContent ?? "").toContain("fit within this 30-day limit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B-degraded — the state the customer's node was actually in.
// ─────────────────────────────────────────────────────────────────────────────
describe("the degraded body renders when the valuation is null", () => {
  it("states count and dates, claims NO amount and NO cause (B-degraded verbatim)", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_DEGRADED), valuation: null, onRefresh: async () => {} }));
    const text = host.textContent ?? "";

    expect(text).toContain("Missed buys");
    expect(text).toContain("11 weekly buys were missed between");
    expect(text).toContain(". The amount can't be calculated right now — see the notice above.");
    // No amount is claimed anywhere in the block.
    expect(text).not.toContain("Buying them now would place one order");
  });

  it("offers NO button in the degraded state — nothing claims a number the code does not have", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_DEGRADED), valuation: null, onRefresh: async () => {} }));
    expect(btn("Buy missed intervals")).toBeUndefined();
  });

  // ⚠ B-degraded's "see the notice above" REFERENT is proven in
  // AutoBuy.valuationNotice.test.tsx, not here. The notice is the PAGE's
  // banner (AutoBuy.tsx), so rendering StrategyTab alone can never show it —
  // a check written at this level would have been vacuous whichever way the
  // gate was set. The pointer and its referent live on different components
  // and the test that proves they meet has to render both.
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CHALLENGE AND THE GATE — the two the prompt singles out.
// ─────────────────────────────────────────────────────────────────────────────
describe("the confirm modal's challenge is the two-decimal amount, and it GATES", () => {
  it("shows the FORMATTED amount as a row value and demands the BARE two-decimal target", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_FULL), valuation, onRefresh: async () => {} }));
    await click(btn("Buy missed intervals")!);
    const text = host.textContent ?? "";

    // CH-FMT: the row shows the formatted amount…
    expect(text).toContain("$1,100.00");
    // …and the prompt states the bare target, character for character (CH-DEC:
    // always two decimals, even on a whole amount).
    expect(text).toContain("Type 1100.00 to confirm");
    // The target is NOT the formatted string — that is the accepted cost of
    // CH-FMT, asserted so a "helpful" reformat is caught.
    expect(text).not.toContain("Type $1,100.00 to confirm");
  });

  it("the target is a NON-EMPTY two-decimal form — an empty challenge would pass a weaker test", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_FULL), valuation, onRefresh: async () => {} }));
    await click(btn("Buy missed intervals")!);
    const label = host.querySelector("label[for='action-confirm-challenge']");
    expect(label?.textContent).toBe("Type 1100.00 to confirm");
  });

  it("GATES: the confirm button is disabled until the exact target is typed", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_FULL), valuation, onRefresh: async () => {} }));
    await click(btn("Buy missed intervals")!);

    const confirm = btn("Buy now")!;
    const input = host.querySelector("#action-confirm-challenge") as HTMLInputElement;
    expect(confirm.disabled, "untouched").toBe(true);

    await type(input, "1100");
    expect(btn("Buy now")!.disabled, "'1100' is a DIFFERENT challenge under a branch that strips nothing").toBe(true);

    await type(input, "$1,100.00");
    expect(btn("Buy now")!.disabled, "the formatted form must not satisfy the bare target").toBe(true);

    await type(input, "1100.00");
    // THE PERMITTING DIRECTION: it must actually open. A suite that only proved
    // the wrong values are refused would pass a button wired permanently shut.
    expect(btn("Buy now")!.disabled, "the exact target must enable it").toBe(false);
  });

  it("and the gate is load-bearing: no request goes out until the challenge is satisfied", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_FULL), valuation, onRefresh: async () => {} }));
    await click(btn("Buy missed intervals")!);

    const input = host.querySelector("#action-confirm-challenge") as HTMLInputElement;
    await click(btn("Buy now")!);
    expect(stub.catchUpAutoBuy, "fired on a disabled button").not.toHaveBeenCalled();

    await type(input, "1100.00");
    await click(btn("Buy now")!);
    // Permitting: it DOES fire, with the figures the member was shown.
    expect(stub.catchUpAutoBuy).toHaveBeenCalledTimes(1);
    expect(stub.catchUpAutoBuy).toHaveBeenCalledWith({ expected_intervals: 11, expected_usd: 1100 });
  });

  it("the PARTIAL modal challenges on the fitting portion, not the whole", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_PARTIAL), valuation, onRefresh: async () => {} }));
    await click(btn("Buy missed intervals")!);
    const text = host.textContent ?? "";

    expect(text).toContain("Buy 10 of 11 missed intervals now?");
    expect(text).toContain("Type 1000.00 to confirm");
    expect(text).toContain("1 missed buy remains and can be bought once the limit frees up.");
    // M-full/M-partial both carry the persistence clause (fourth wave).
    expect(text).toContain("This is a one-time action; it does not change your schedule.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-bal — the balance refusal, accepted 2026-09-18 (eleventh wave). TWO forms,
// selected on `funds.considered.length`, because one string cannot serve both
// cases honestly: `selectCurrency` tests INDEPENDENT coverage only, so under a
// *_preferred preference a refusal means neither balance alone covered it, and
// any combined figure would be false.
// ─────────────────────────────────────────────────────────────────────────────

/** The two-decimal target for whatever portion this fixture offers. */
const catchUpTarget = (m: AutoBuyMissed): string => (m.fits_now?.estimated_usd ?? 0).toFixed(2);

/** Drive the block to a refusal and return the block's text. */
async function refuse(body: unknown, missed: AutoBuyMissed = MISSED_FULL): Promise<string> {
  stub.catchUpAutoBuy.mockRejectedValue(Object.assign(new Error("refused"), { body }));
  await render(React.createElement(StrategyTab, { status: status(missed), valuation, onRefresh: async () => {} }));
  await click(btn("Buy missed intervals")!);
  const input = host.querySelector("#action-confirm-challenge") as HTMLInputElement;
  await type(input, catchUpTarget(missed));
  await click(btn("Buy now")!);
  return block();
}

describe("R-bal · one currency considered", () => {
  const ONE = {
    error: "insufficient_funds",
    reason: "usd_balance=12.5;usdc_balance=0;need=1100",
    funds: { needed_usd: 1100, considered: ["USD"], usd_balance: 12.5, usdc_balance: null },
  };

  it("renders the ONE-CURRENCY form, verbatim", async () => {
    // Anti-vacuity partner for the negative below: this asserts the RIGHT
    // content, so an empty render cannot pass the pair.
    expect(await refuse(ONE)).toContain(
      "Not placed: your Coinbase USD balance is $12.50, below the $1,100.00 needed. Fund the account and try again; nothing was bought and the missed intervals are still listed.",
    );
  });

  it("never names the balance that was NOT considered", async () => {
    // `usdc_balance: null` means the preference excluded USDC — naming it would
    // let the copy claim something the node would never have spent.
    const text = await refuse(ONE);
    expect(text).not.toContain("USDC");
    expect(text).not.toContain("neither balance");
  });

  it("names USDC when USDC is the considered one — the currency is read, not assumed", async () => {
    const text = await refuse({
      error: "insufficient_funds",
      reason: "x",
      funds: { needed_usd: 1100, considered: ["USDC"], usd_balance: null, usdc_balance: 3 },
    });
    expect(text).toContain("your Coinbase USDC balance is $3.00, below the $1,100.00 needed.");
  });
});

describe("R-bal · both currencies considered", () => {
  it("renders the NEITHER-COVERS form with both balances and the one-currency sentence", async () => {
    const text = await refuse({
      error: "insufficient_funds",
      reason: "x",
      funds: { needed_usd: 1100, considered: ["USD", "USDC"], usd_balance: 600, usdc_balance: 600 },
    });
    expect(text).toContain(
      "Not placed: neither balance covers the $1,100.00 needed — USD $600.00, USDC $600.00. A single buy is paid from one currency, not both. Fund either account and try again; nothing was bought and the missed intervals are still listed.",
    );
  });

  it("a 0 balance is a REAL zero, not a not-considered — it is named", async () => {
    // A missing Coinbase account reads 0, and null is reserved for "not
    // considered". Under a *_preferred preference the member must see the 0.
    const text = await refuse({
      error: "insufficient_funds",
      reason: "x",
      funds: { needed_usd: 1100, considered: ["USD", "USDC"], usd_balance: 50, usdc_balance: 0 },
    });
    expect(text).toContain("USD $50.00, USDC $0.00.");
  });

  it("and insufficient_funds NO LONGER falls through to the generic frame", async () => {
    const text = await refuse({
      error: "insufficient_funds",
      reason: "x",
      funds: { needed_usd: 1100, considered: ["USD", "USDC"], usd_balance: 600, usdc_balance: 600 },
    });
    expect(text).not.toContain("Not placed (insufficient_funds)");
  });

  it("a refusal with NO funds field still takes the generic frame — the branch is guarded", async () => {
    // The permitting direction's mirror: the new branch must not swallow
    // refusals it cannot render. GEN is accepted copy and stays the fallback.
    const text = await refuse({ error: "no_credentials", reason: "no_credentials" });
    expect(text).toContain("Not placed (no_credentials). Nothing was bought; the missed intervals are still listed.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The cadence word is READ, not assumed.
// ─────────────────────────────────────────────────────────────────────────────
describe("the frequency is interpolated, not hardcoded weekly", () => {
  it("a daily config says daily — and does NOT say weekly", async () => {
    await render(React.createElement(StrategyTab, {
      status: status(MISSED_FULL, { frequency: "daily" }), valuation, onRefresh: async () => {},
    }));
    // Assert the WORD, both directions: the positive alone would pass a render
    // that said "daily weekly", the negative alone would pass an empty block.
    expect(block()).toContain("11 daily buys were missed between");
    expect(block()).not.toContain("weekly buys");
  });

  it("a monthly config says monthly", async () => {
    await render(React.createElement(StrategyTab, {
      status: status(MISSED_FULL, { frequency: "monthly" }), valuation, onRefresh: async () => {},
    }));
    expect(block()).toContain("11 monthly buys were missed between");
  });

  it("the DEGRADED body reads the cadence too — both bodies share one lead", async () => {
    await render(React.createElement(StrategyTab, {
      status: status(MISSED_DEGRADED, { frequency: "biweekly" }), valuation: null, onRefresh: async () => {},
    }));
    expect(block()).toContain("11 biweekly buys were missed between");
    expect(block()).toContain("The amount can't be calculated right now — see the notice above.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Singular and plural, BOTH directions. A suite asserting only the plural
// passes an implementation that never inflects.
// ─────────────────────────────────────────────────────────────────────────────
const ONE_MISSED: AutoBuyMissed = {
  ...MISSED_FULL,
  intervals: 1,
  estimated_usd: 100,
  fits_now: { intervals: 1, estimated_usd: 100 },
  remainder: null,
};

/** 3 missed, 1 fits, 2 remain — exercises "1 of 3 … fits" and a plural remainder. */
const ONE_FITS_OF_THREE: AutoBuyMissed = {
  ...MISSED_FULL,
  intervals: 3,
  estimated_usd: 300,
  fits_now: { intervals: 1, estimated_usd: 100 },
  remainder: { intervals: 2, estimated_usd: 200, binding_window: "7d" },
};

/** 3 missed, 2 fit, 1 remains — exercises a plural "fit" and a singular "remains". */
const TWO_FIT_OF_THREE: AutoBuyMissed = {
  ...MISSED_FULL,
  intervals: 3,
  estimated_usd: 300,
  fits_now: { intervals: 2, estimated_usd: 200 },
  remainder: { intervals: 1, estimated_usd: 100, binding_window: "7d" },
};

describe("singular and plural both render correctly", () => {
  it("one missed interval: singular noun and verb in the lead", async () => {
    await render(React.createElement(StrategyTab, { status: status(ONE_MISSED), valuation, onRefresh: async () => {} }));
    expect(block()).toContain("1 weekly buy was missed between");
  });

  it("one missed interval: the modal title is singular", async () => {
    await render(React.createElement(StrategyTab, { status: status(ONE_MISSED), valuation, onRefresh: async () => {} }));
    await click(btn("Buy missed intervals")!);
    expect(host.textContent ?? "").toContain("Buy 1 missed interval?");
    expect(host.textContent ?? "").not.toContain("Buy 1 missed intervals?");
  });

  it("many missed intervals: the modal title stays plural — the other direction", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_FULL), valuation, onRefresh: async () => {} }));
    await click(btn("Buy missed intervals")!);
    expect(host.textContent ?? "").toContain("Buy 11 missed intervals?");
  });

  it("one of three fits: the verb agrees with the ONE, and the remainder is plural", async () => {
    await render(React.createElement(StrategyTab, { status: status(ONE_FITS_OF_THREE), valuation, onRefresh: async () => {} }));
    expect(block()).toContain("1 of 3 missed buys fits within this 7-day limit: about $100.00.");
    expect(block()).toContain("2 missed buys (about $200.00) remain and can be bought once the limit frees up.");
  });

  it("two of three fit: plural verb, singular remainder — both inflections in one render", async () => {
    await render(React.createElement(StrategyTab, { status: status(TWO_FIT_OF_THREE), valuation, onRefresh: async () => {} }));
    expect(block()).toContain("2 of 3 missed buys fit within this 7-day limit: about $200.00.");
    expect(block()).toContain("1 missed buy (about $100.00) remains and can be bought once the limit frees up.");
  });

  it("the partial modal inflects its remainder sentence too", async () => {
    await render(React.createElement(StrategyTab, { status: status(TWO_FIT_OF_THREE), valuation, onRefresh: async () => {} }));
    await click(btn("Buy missed intervals")!);
    expect(host.textContent ?? "").toContain("1 missed buy remains and can be bought once the limit frees up.");
  });

  it("the success toast inflects its remainder clause", async () => {
    stub.catchUpAutoBuy.mockResolvedValue({ ok: true, intervals: 2, usd: 200, remainder_intervals: 1 });
    await render(React.createElement(StrategyTab, { status: status(TWO_FIT_OF_THREE), valuation, onRefresh: async () => {} }));
    await click(btn("Buy missed intervals")!);
    const input = host.querySelector("#action-confirm-challenge") as HTMLInputElement;
    await type(input, "200.00");
    await click(btn("Buy now")!);
    expect(block()).toContain("Order placed for $200.00. 1 missed buy remains and can be bought once the limit frees up. Check history.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The zone LABEL, everywhere on this tab — not only inside the block.
// ─────────────────────────────────────────────────────────────────────────────
describe("no raw zone token survives anywhere on the Strategy tab", () => {
  it("the summary banner one panel above the block reads the label too", async () => {
    await render(React.createElement(StrategyTab, { status: status(MISSED_FULL), valuation, onRefresh: async () => {} }));
    const text = host.textContent ?? "";
    expect(text).toContain("Fair Value");
    // Page-wide now: the block was already correct, the pre-existing summary
    // banner one panel above it was not.
    expect(text).not.toContain("fair_value");
  });
});
