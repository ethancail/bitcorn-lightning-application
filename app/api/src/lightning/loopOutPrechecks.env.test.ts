// code-audit-2, Loop and money-path env parses (the F02 follow-up): the Loop
// Out pre-checks and the ceilings still enforce when their env value is
// malformed. Before the fix:
//   LOOP_MINER_FEE_MARGIN_PCT="abc" → NaN: `fresh*100 > quoted*NaN` is false,
//     so the fee-rate check never refused;
//   LOOP_ROUTING_FEE_CAP_PPM="abc" → NaN: the route probe's `fee > NaN` is
//     false (the cap off); the stored ceilings were NaN, which JSON turns into
//     null, so every execute failed ceiling_mismatch; and loopd received 0 —
//     only zero-fee routes (Phase 1 report).
// Each ⚠ case was red on that code.

import { afterEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ probe: vi.fn() }));

vi.mock("./lnd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lnd")>()),
  probeLoopOutPaymentRoute: s.probe,
}));

const VARS = ["LOOP_MINER_FEE_MARGIN_PCT", "LOOP_ROUTING_FEE_CAP_PPM"] as const;

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  vi.restoreAllMocks();
  s.probe.mockReset();
});

async function load(env: Partial<Record<(typeof VARS)[number], string>>) {
  vi.resetModules();
  for (const v of VARS) {
    if (env[v] === undefined) delete process.env[v];
    else process.env[v] = env[v];
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const prechecks = await import("./loopOutPrechecks");
  const loop = await import("./loop");
  const ceilings = await import("../swaps/swapCeilings");
  return { ...prechecks, ...loop, ...ceilings };
}

describe("LOOP_MINER_FEE_MARGIN_PCT — the fee-rate check (default 50%)", () => {
  it("⚠ \"abc\": a fresh miner fee 51% over the quote is refused; 50% passes", async () => {
    const { minerFeeExceedsMargin } = await load({ LOOP_MINER_FEE_MARGIN_PCT: "abc" });
    expect(minerFeeExceedsMargin(151, 100)).toBe(true);
    expect(minerFeeExceedsMargin(150, 100)).toBe(false);
  });

  it("⚠ empty: the margin is the default 50%, not 0 (150 against 100 passes)", async () => {
    const { minerFeeExceedsMargin } = await load({ LOOP_MINER_FEE_MARGIN_PCT: "" });
    expect(minerFeeExceedsMargin(150, 100)).toBe(false);
  });

  it("control: a configured 0 is kept — any rise refuses, no rise passes", async () => {
    const { minerFeeExceedsMargin } = await load({ LOOP_MINER_FEE_MARGIN_PCT: "0" });
    expect(minerFeeExceedsMargin(101, 100)).toBe(true);
    expect(minerFeeExceedsMargin(100, 100)).toBe(false);
  });

  it("control: a configured 12.5 — the boundary is exact", async () => {
    const { minerFeeExceedsMargin } = await load({ LOOP_MINER_FEE_MARGIN_PCT: "12.5" });
    expect(minerFeeExceedsMargin(1125, 1000)).toBe(false);
    expect(minerFeeExceedsMargin(1126, 1000)).toBe(true);
  });
});

describe("LOOP_ROUTING_FEE_CAP_PPM — the routing-fee cap (default 10,000 ppm = 1%)", () => {
  const AMOUNT = 1_000_000;
  const PREPAY = 30_000;
  const DEST = "03" + "fb".repeat(32);

  it("⚠ \"abc\": the ceiling for 1,000,000 sats is 10,000, a number", async () => {
    const { routingFeeCeilingSat } = await load({ LOOP_ROUTING_FEE_CAP_PPM: "abc" });
    expect(routingFeeCeilingSat(AMOUNT)).toBe(10_000);
    expect(routingFeeCeilingSat(PREPAY)).toBe(300);
  });

  it("⚠ \"abc\": a probed route over 1% is refused over_cap", async () => {
    const { checkLoopOutRoutes } = await load({ LOOP_ROUTING_FEE_CAP_PPM: "abc" });
    s.probe.mockImplementation(async (_pk: string, amt: number) => ({ routable: true, feeSat: amt === AMOUNT ? 10_001 : 1 }));
    expect(await checkLoopOutRoutes({ swapPaymentDest: DEST, amountSat: AMOUNT, prepaySat: PREPAY }))
      .toMatchObject({ ok: false, reason: "over_cap", swapCapSat: 10_000 });
  });

  it("⚠ \"abc\": the stored ceilings survive the JSON round trip the confirmation makes", async () => {
    const { ceilingsFor, ceilingsMatch } = await load({ LOOP_ROUTING_FEE_CAP_PPM: "abc" });
    const expected = ceilingsFor({
      swap_type: "loop_out",
      amount_sat: AMOUNT,
      quoted_swap_fee_sat: 2_000,
      quoted_prepay_sat: PREPAY,
      quoted_miner_fee_sat: 1_000,
    })!;
    expect(expected.max_swap_routing_fee_sat).toBe(10_000);
    const echoed = JSON.parse(JSON.stringify(expected));
    expect(ceilingsMatch(expected, echoed)).toBe(true);
  });

  it("⚠ empty: the cap is the default, not 0 (a 1-sat route passes)", async () => {
    const { checkLoopOutRoutes } = await load({ LOOP_ROUTING_FEE_CAP_PPM: "" });
    s.probe.mockResolvedValue({ routable: true, feeSat: 1 });
    expect(await checkLoopOutRoutes({ swapPaymentDest: DEST, amountSat: AMOUNT, prepaySat: PREPAY }))
      .toMatchObject({ ok: true });
  });

  it("control: a configured 5,000 ppm halves the ceiling and refuses a 0.6% route", async () => {
    const { routingFeeCeilingSat, checkLoopOutRoutes } = await load({ LOOP_ROUTING_FEE_CAP_PPM: "5000" });
    expect(routingFeeCeilingSat(AMOUNT)).toBe(5_000);
    s.probe.mockImplementation(async (_pk: string, amt: number) => ({ routable: true, feeSat: amt === AMOUNT ? 6_000 : 1 }));
    expect(await checkLoopOutRoutes({ swapPaymentDest: DEST, amountSat: AMOUNT, prepaySat: PREPAY }))
      .toMatchObject({ ok: false, reason: "over_cap" });
  });
});
