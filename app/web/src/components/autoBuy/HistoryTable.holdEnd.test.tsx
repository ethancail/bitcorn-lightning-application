// kraken-autobuy P2: HistoryTable shows the hold end the API reports per run
// (spec §3 P2, ruling S2), not a web mirror of the scheduler's constant.
//
// The fixture's hold_ends_at is DELIBERATELY not filled_at + 72 h: it is a
// Kraken run, filled_at + 7 days. A table that still adds a 72-hour constant
// to filled_at renders the wrong dates, so the positive assertions below go
// red; a table that reads the field renders these.
//
// Dates: filled Monday 2030-01-07 12:00 UTC. The API's hold end is Monday
// 2030-01-14; a 72 h mirror would give Thursday 2030-01-10. With the sweep on
// Sunday (0), the first gives "~Sun Jan 20" and the mirror "~Sun Jan 13". The
// sweep date is formatted in UTC with en-US, so it is asserted literally; the
// hold date is formatted in the runner's locale and time zone, so the expected
// string is built here with the same call the component makes.
//
// No React Testing Library: createRoot inside act(), as StrategyTab's tests do.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import type { AutoBuyRun } from "../../api/client";

const stub = vi.hoisted(() => ({
  getAutoBuyHistory: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import HistoryTable from "./HistoryTable";

const FILLED_AT = 1894017600;          // Mon 2030-01-07 12:00 UTC
const KRAKEN_HOLD_END = FILLED_AT + 604800; // Mon 2030-01-14 12:00 UTC
const MIRROR_HOLD_END = FILLED_AT + 259200; // Thu 2030-01-10: what a 72 h mirror computes

const localDay = (sec: number) => new Date(sec * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function run(over: Partial<AutoBuyRun> = {}): AutoBuyRun {
  return {
    id: 7,
    scheduled_for: FILLED_AT - 600,
    z_score: -0.4,
    zone: "fair_value",
    multiplier: 1,
    base_unit_usd: 100,
    intended_buy_usd: 100,
    status: "awaiting_withdraw_hold",
    filled_btc: 0.001,
    filled_usd: 100,
    filled_at: FILLED_AT,
    provider: "kraken",
    hold_ends_at: KRAKEN_HOLD_END,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactElement): Promise<void> {
  await act(async () => { root.render(node); });
  await act(async () => { await Promise.resolve(); });
}

/** The delivery line under the status badge: its visible text and its title. */
function deliveryLine(): { text: string; title: string } | null {
  const el = host.querySelector("tbody td div.text-dim");
  return el ? { text: el.textContent ?? "", title: el.getAttribute("title") ?? "" } : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("HistoryTable reads each run's hold end from the API", () => {
  it("renders the API's hold end and the sweep date that follows from it", async () => {
    stub.getAutoBuyHistory.mockResolvedValue({ rows: [run()], total: 1, limit: 25, offset: 0 });
    await render(React.createElement(HistoryTable, { sweepDayOfWeek: 0 }));
    const line = deliveryLine();
    expect(line).not.toBeNull();
    expect(line!.text).toBe(`hold ends ${localDay(KRAKEN_HOLD_END)} · → node ~Sun Jan 20 (UTC)`);
    expect(line!.title).toContain(new Date(KRAKEN_HOLD_END * 1000).toLocaleString());
    expect(line!.text).not.toContain(localDay(MIRROR_HOLD_END));
  });

  it("without a sweep day, renders the API's hold end alone", async () => {
    stub.getAutoBuyHistory.mockResolvedValue({ rows: [run()], total: 1, limit: 25, offset: 0 });
    await render(React.createElement(HistoryTable, {}));
    expect(deliveryLine()?.text).toBe(`hold ends ${localDay(KRAKEN_HOLD_END)}`);
  });

  it("an awaiting-hold row with no hold end renders no delivery line, and the row still renders", async () => {
    stub.getAutoBuyHistory.mockResolvedValue({ rows: [run({ hold_ends_at: null })], total: 1, limit: 25, offset: 0 });
    await render(React.createElement(HistoryTable, { sweepDayOfWeek: 0 }));
    expect(host.querySelector("tbody .badge")?.textContent).toBe("AWAITING-WITHDRAW");
    expect(deliveryLine()).toBeNull();
  });
});

// kraken-autobuy P6 (D-P6-2; the spec's P6 control): the hold's NAME and
// LENGTH come from the run and the API too. A Coinbase row still reads
// "72-hour", now worked out from hold_ends_at − filled_at, and a Kraken row
// reads "7-day". A web constant in either direction turns one of them red.
describe("HistoryTable words each run's hold from its exchange and the API (P6)", () => {
  it("a Kraken run: 'Kraken 7-day hold ends …'", async () => {
    stub.getAutoBuyHistory.mockResolvedValue({ rows: [run()], total: 1, limit: 25, offset: 0 });
    await render(React.createElement(HistoryTable, {}));
    expect(deliveryLine()!.title).toBe(`Kraken 7-day hold ends ${new Date(KRAKEN_HOLD_END * 1000).toLocaleString()}.`);
  });

  it("a Coinbase run still shows 72-hour, from the API's hold end", async () => {
    stub.getAutoBuyHistory.mockResolvedValue({
      rows: [run({ provider: "coinbase", hold_ends_at: MIRROR_HOLD_END })], total: 1, limit: 25, offset: 0,
    });
    await render(React.createElement(HistoryTable, { sweepDayOfWeek: 0 }));
    expect(deliveryLine()!.title).toContain(`Coinbase 72-hour hold ends ${new Date(MIRROR_HOLD_END * 1000).toLocaleString()};`);
  });

  it("a run skipped below the exchange minimum gets its own badge", async () => {
    stub.getAutoBuyHistory.mockResolvedValue({
      rows: [run({ status: "skipped_below_minimum", hold_ends_at: null, filled_at: null })], total: 1, limit: 25, offset: 0,
    });
    await render(React.createElement(HistoryTable, {}));
    expect(host.querySelector("tbody .badge")?.textContent).toBe("BELOW MIN");
  });
});
