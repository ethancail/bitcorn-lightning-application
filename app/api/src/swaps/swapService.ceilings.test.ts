// Execute-time ceilings on the member/admin swap path (sites A, B and D) —
// loop-fee-ceilings spec §4–§5, done-whens D8 onward.
//
// Drives the real swapService against a temp-dir database built by the real
// migration runner. Only the loopd boundary (./loopProvider) is mocked, so what
// is asserted is what swapService would hand loopd, and whether it calls loopd
// at all.
//
// ⚠ ORDERING: db/index.ts opens its file at module load from DB_DIR. Nothing
// that imports the db singleton is imported statically here; swapService and
// the migration runner are imported in beforeAll, after DB_DIR is set.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import type Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../config/env";
// Pure (no db import), so a static import is safe here.
import { SwapRefusalError } from "./swapRefusal";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-ceilings-test-"));

const stubs = vi.hoisted(() => ({
  quoteLoopOut: vi.fn(),
  quoteLoopIn: vi.fn(),
  initiateLoopOut: vi.fn(),
  initiateLoopIn: vi.fn(),
  recordSwapEvent: vi.fn(),
  probeLoopOutPaymentRoute: vi.fn(),
}));

vi.mock("./loopProvider", () => ({
  quoteLoopOut: stubs.quoteLoopOut,
  quoteLoopIn: stubs.quoteLoopIn,
  initiateLoopOut: stubs.initiateLoopOut,
  initiateLoopIn: stubs.initiateLoopIn,
  recordSwapEvent: stubs.recordSwapEvent,
  generateDestinationAddress: vi.fn(),
}));

// The LND route-probe primitive. Everything above it — the three-step order,
// the cap check and the refusal — runs for real.
vi.mock("../lightning/lnd", () => ({
  probeLoopOutPaymentRoute: stubs.probeLoopOutPaymentRoute,
}));

// The quote's swap_payment_dest, and the configured Loop server (the
// fallback). Neither is the other.
const PAYMENT_DEST = "03" + "fb".repeat(32);
const LOOP_SERVER = ENV.loopServerPubkeys[0];

type Svc = typeof import("./swapService");
let svc: Svc;
let db: Database.Database;

const MEMBER = "02" + "11".repeat(32);
const DEST = "bcrt1qexampleexampleexampleexampleexample0";

// The ceilings the quote response carries and the execute body echoes (F4),
// for the default stub quotes below — written out, not computed by the code
// under test. Routing: 1% of 250,000 and 1% of 30,000.
const LOOP_OUT_CEILINGS = {
  max_swap_fee_sat: 835,
  max_prepay_amt_sat: 30_000,
  max_miner_fee_sat: 1_200,
  max_swap_routing_fee_sat: 2_500,
  max_prepay_routing_fee_sat: 300,
};
const LOOP_IN_CEILINGS = { max_swap_fee_sat: 500, max_miner_fee_sat: 900 };

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  svc = await import("./swapService");
});

beforeEach(() => {
  vi.clearAllMocks();
  stubs.quoteLoopOut.mockResolvedValue({
    amount_sat: 250_000,
    swap_fee_sat: 835,
    prepay_sat: 30_000,
    miner_fee_sat: 1_200,
    total_fee_sat: 32_035,
    conf_target: 6,
    swap_payment_dest: PAYMENT_DEST,
  });
  // Default: the quote's destination routes, cheaply, for both payments.
  stubs.probeLoopOutPaymentRoute.mockResolvedValue({ routable: true, feeSat: 3 });
  stubs.quoteLoopIn.mockResolvedValue({
    amount_sat: 250_000,
    swap_fee_sat: 500,
    htlc_publish_fee_sat: 900,
    total_fee_sat: 1_400,
    conf_target: 6,
  });
  stubs.initiateLoopOut.mockResolvedValue({ swapHash: "h", id: "i", serverMessage: "" });
  stubs.initiateLoopIn.mockResolvedValue({ swapHash: "h", id: "i", serverMessage: "", htlcAddress: "a" });
});

/** A row as a pre-migration build wrote it: no quote components. */
function insertPreMigrationRow(swapType: "loop_out" | "loop_in"): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO swap_requests
      (id, created_at, updated_at, node_pubkey, role, swap_type, direction,
       status, amount_sat, max_fee_sat, quoted_fee_sat, destination_address,
       channel_id, quote_expires_at)
    VALUES (?, ?, ?, ?, 'member', ?, ?, 'quote_created', 250000, NULL, 2035, ?, NULL, ?)
  `).run(
    id, now, now, MEMBER, swapType,
    swapType === "loop_out" ? "lightning_to_chain" : "chain_to_lightning",
    swapType === "loop_out" ? DEST : null,
    now + 300_000,
  );
  return id;
}

describe("quote components are stored (§5)", () => {
  it("Loop Out stores the quote's swap fee, prepay and miner fee", async () => {
    const { swapRequest } = await svc.createLoopOutQuote({
      nodePubkey: MEMBER, role: "member", amountSat: 250_000, destinationAddress: DEST,
    });
    expect(swapRequest).toMatchObject({
      quoted_swap_fee_sat: 835,
      quoted_prepay_sat: 30_000,
      quoted_miner_fee_sat: 1_200,
    });
  });

  it("Loop In stores the quoted swap fee alone and the HTLC fee as its miner fee; no prepay", async () => {
    const { swapRequest } = await svc.createLoopInQuote({
      nodePubkey: MEMBER, role: "member", amountSat: 250_000,
    });
    expect(swapRequest).toMatchObject({
      quoted_swap_fee_sat: 500,
      quoted_prepay_sat: null,
      quoted_miner_fee_sat: 900,
    });
  });
});

// D1 for A and B: the ceilings handed to loopd are the stored quote's
// components. B (admin) shares initiateSwap with A; both roles are driven.
// One test per component, so each of B10's three controls has its own red:
// (i) the 15% swap-fee formula, (ii) the fixed 50,000 prepay, (iii) the
// constant miner fee.
describe.each([
  { site: "A", role: "member" as const },
  { site: "B", role: "treasury" as const },
])("D1 ($site): Loop Out ceilings are the stored quote's components", ({ role }) => {
  async function initiate() {
    const { swapRequest } = await svc.createLoopOutQuote({
      nodePubkey: MEMBER, role, amountSat: 250_000, destinationAddress: DEST,
    });
    await svc.initiateSwap(swapRequest.id, DEST, LOOP_OUT_CEILINGS);
    expect(stubs.initiateLoopOut).toHaveBeenCalledTimes(1);
    return stubs.initiateLoopOut.mock.calls[0][0];
  }

  it("max_swap_fee is the quoted swap fee, with no margin", async () => {
    expect((await initiate()).maxSwapFee).toBe(835);
  });

  it("max_prepay_amt is the quoted prepay", async () => {
    expect((await initiate()).maxPrepay).toBe(30_000);
  });

  it("max_miner_fee is the quoted miner fee", async () => {
    expect((await initiate()).maxMinerFee).toBe(1_200);
  });
});

// ─── Pre-initiation checks on A and B (spec §4 A and B) ─────────────────────

async function quoteAndInitiate(role: "member" | "treasury" = "member") {
  const { swapRequest } = await svc.createLoopOutQuote({
    nodePubkey: MEMBER, role, amountSat: 250_000, destinationAddress: DEST,
  });
  return { id: swapRequest.id, run: () => svc.initiateSwap(swapRequest.id, DEST, LOOP_OUT_CEILINGS) };
}

/** Route the probe by destination: what each pubkey answers, for any amount. */
function routes(answers: Record<string, { routable: boolean; feeSat?: number } | ((amt: number) => any)>) {
  stubs.probeLoopOutPaymentRoute.mockImplementation(async (dest: string, amt: number) => {
    const a = answers[dest] ?? { routable: false };
    return typeof a === "function" ? a(amt) : a;
  });
}

function probedTargets(): string[] {
  return stubs.probeLoopOutPaymentRoute.mock.calls.map((c) => `${c[0]}@${c[1]}`);
}

describe.each(["member", "treasury"] as const)("D2 (%s): a probed route fee above the 1% cap refuses", (role) => {
  it("swap payment's route over cap (2,501 > 2,500) → route_fee_over_cap, no loopd initiation", async () => {
    routes({ [PAYMENT_DEST]: (amt) => ({ routable: true, feeSat: amt === 250_000 ? 2_501 : 3 }) });
    const { run } = await quoteAndInitiate(role);
    await expect(run()).rejects.toMatchObject({ code: "route_fee_over_cap" });
    expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
  });

  it("prepay's route over cap (301 > 300) → route_fee_over_cap, no loopd initiation", async () => {
    routes({ [PAYMENT_DEST]: (amt) => ({ routable: true, feeSat: amt === 30_000 ? 301 : 3 }) });
    const { run } = await quoteAndInitiate(role);
    await expect(run()).rejects.toMatchObject({ code: "route_fee_over_cap" });
    expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
  });

  it("both routes at the cap exactly proceed", async () => {
    routes({ [PAYMENT_DEST]: (amt) => ({ routable: true, feeSat: amt === 250_000 ? 2_500 : 300 }) });
    const { run } = await quoteAndInitiate(role);
    await run();
    expect(stubs.initiateLoopOut).toHaveBeenCalledTimes(1);
  });
});

describe.each(["member", "treasury"] as const)("D3 (%s): the fee-rate refusal fires before initiation", (role) => {
  // Stored miner fee 1,200; margin 50% → a fresh estimate above 1,800 refuses.
  function freshMinerFee(sat: number) {
    stubs.quoteLoopOut
      .mockResolvedValueOnce({ amount_sat: 250_000, swap_fee_sat: 835, prepay_sat: 30_000, miner_fee_sat: 1_200, total_fee_sat: 32_035, conf_target: 6, swap_payment_dest: PAYMENT_DEST })
      .mockResolvedValueOnce({ amount_sat: 250_000, swap_fee_sat: 835, prepay_sat: 30_000, miner_fee_sat: sat, total_fee_sat: 0, conf_target: 6, swap_payment_dest: PAYMENT_DEST });
  }

  it("fresh miner fee 1,801 > 1,200 + 50% → fee_rate_over_quote, no loopd initiation", async () => {
    freshMinerFee(1_801);
    const { run } = await quoteAndInitiate(role);
    await expect(run()).rejects.toMatchObject({ code: "fee_rate_over_quote" });
    expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
  });

  it("fresh miner fee 1,800 (exactly quote + 50%) proceeds", async () => {
    freshMinerFee(1_800);
    const { run } = await quoteAndInitiate(role);
    await run();
    expect(stubs.initiateLoopOut).toHaveBeenCalledTimes(1);
  });
});

describe("D21: the probe's three branches", () => {
  it("(a) direct: the quote's swap_payment_dest routes; it alone is probed, for both amounts", async () => {
    routes({ [PAYMENT_DEST]: { routable: true, feeSat: 3 }, [LOOP_SERVER]: { routable: true, feeSat: 3 } });
    const { id, run } = await quoteAndInitiate();
    await run();
    expect(probedTargets()).toEqual([`${PAYMENT_DEST}@250000`, `${PAYMENT_DEST}@30000`]);
    expect(stubs.recordSwapEvent).toHaveBeenCalledWith(id, "route_probed",
      expect.objectContaining({ branch: "direct", target: PAYMENT_DEST }));
    expect(stubs.initiateLoopOut).toHaveBeenCalledTimes(1);
  });

  it("(b) fallback: swap_payment_dest finds no route; the Loop server routes and the swap proceeds", async () => {
    routes({ [PAYMENT_DEST]: { routable: false }, [LOOP_SERVER]: { routable: true, feeSat: 5 } });
    const { id, run } = await quoteAndInitiate();
    await run();
    expect(probedTargets()).toEqual(expect.arrayContaining([`${LOOP_SERVER}@250000`, `${LOOP_SERVER}@30000`]));
    expect(stubs.recordSwapEvent).toHaveBeenCalledWith(id, "route_probed",
      expect.objectContaining({ branch: "fallback", target: LOOP_SERVER }));
    expect(stubs.initiateLoopOut).toHaveBeenCalledTimes(1);
  });

  it("(b) fallback: the cap applies to the fallback route's fee", async () => {
    routes({ [PAYMENT_DEST]: { routable: false }, [LOOP_SERVER]: { routable: true, feeSat: 2_501 } });
    const { run } = await quoteAndInitiate();
    await expect(run()).rejects.toMatchObject({ code: "route_fee_over_cap" });
    expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
  });

  it("(c) neither routes → route_not_found before initiation, no loopd initiation", async () => {
    routes({});
    const { run } = await quoteAndInitiate();
    await expect(run()).rejects.toMatchObject({ code: "route_not_found" });
    expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
  });
});

// ─── F4: the echoed ceilings must match the stored quote (spec §6) ──────────

describe("F4: a ceiling echoed differently from the stored quote is refused", () => {
  it.each(Object.keys(LOOP_OUT_CEILINGS))("Loop Out: %s altered → ceiling_mismatch, no loopd call", async (key) => {
    const { swapRequest } = await svc.createLoopOutQuote({
      nodePubkey: MEMBER, role: "member", amountSat: 250_000, destinationAddress: DEST,
    });
    const altered = { ...LOOP_OUT_CEILINGS, [key]: (LOOP_OUT_CEILINGS as any)[key] + 1 };
    await expect(svc.initiateSwap(swapRequest.id, DEST, altered)).rejects.toMatchObject({ code: "ceiling_mismatch" });
    expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
    expect(stubs.probeLoopOutPaymentRoute).not.toHaveBeenCalled();
  });

  it.each(Object.keys(LOOP_IN_CEILINGS))("Loop In: %s altered → ceiling_mismatch, no loopd call", async (key) => {
    const { swapRequest } = await svc.createLoopInQuote({ nodePubkey: MEMBER, role: "member", amountSat: 250_000 });
    const altered = { ...LOOP_IN_CEILINGS, [key]: (LOOP_IN_CEILINGS as any)[key] - 1 };
    await expect(svc.initiateSwap(swapRequest.id, undefined, altered)).rejects.toMatchObject({ code: "ceiling_mismatch" });
    expect(stubs.initiateLoopIn).not.toHaveBeenCalled();
  });

  it("a missing echo is refused the same way", async () => {
    const { swapRequest } = await svc.createLoopOutQuote({
      nodePubkey: MEMBER, role: "member", amountSat: 250_000, destinationAddress: DEST,
    });
    const { max_miner_fee_sat: _omitted, ...partial } = LOOP_OUT_CEILINGS;
    await expect(svc.initiateSwap(swapRequest.id, DEST, partial)).rejects.toMatchObject({ code: "ceiling_mismatch" });
    expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
  });
});

// ─── The claim: one execute per quote (Ethan's ruling, double-initiation race) ─
//
// initiateSwap claims the row atomically (status → 'initiating', only from an
// executable state) before any loopd call, and proceeds only if it changed
// exactly one row. Every refusal AFTER the claim either RELEASES the row to
// its prior status (the same quote may be retried) or marks it TERMINAL
// (expired, with the code as failure_reason). Pinned per refusal below.

const statusOf = (id: string) => db.prepare("SELECT status, failure_reason FROM swap_requests WHERE id = ?").get(id) as
  { status: string; failure_reason: string | null };

describe("the claim: two concurrent executes of one quote reach loopd once", () => {
  it("Loop Out: one initiation; the loser gets swap_in_progress; the row ends initiated", async () => {
    const { id, run } = await quoteAndInitiate();
    const results = await Promise.allSettled([run(), run()]);
    expect(stubs.initiateLoopOut).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(lost?.reason).toMatchObject({ code: "swap_in_progress" });
    expect(statusOf(id).status).toBe("initiated");
  });

  it("Loop In: one initiation; the loser gets swap_in_progress", async () => {
    const { run } = await quoteAndInitiateLoopIn();
    const results = await Promise.allSettled([run(), run()]);
    expect(stubs.initiateLoopIn).toHaveBeenCalledTimes(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(lost?.reason).toMatchObject({ code: "swap_in_progress" });
  });
});

// Ruling g: any non-executable status (initiated included) is its own 409
// refusal, swap_not_executable; swap_in_progress stays for 'initiating'.
describe("ruling g: a late execute of a used quote is refused with its own code", () => {
  it.each(["initiated", "expired", "failed", "completed"])(
    "status %s → swap_not_executable, a SwapRefusalError, no loopd call",
    async (status) => {
      const { id, run } = await quoteAndInitiate();
      db.prepare("UPDATE swap_requests SET status = ? WHERE id = ?").run(status, id);
      const err = await run().then(() => null, (e) => e);
      expect(err).toBeInstanceOf(SwapRefusalError);
      expect(err).toMatchObject({ code: "swap_not_executable" });
      expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
      expect(statusOf(id).status).toBe(status); // the row is not touched
    },
  );

  it("a late loser, arriving after the winner finished, gets it too", async () => {
    const { run } = await quoteAndInitiate();
    await run();
    await expect(run()).rejects.toMatchObject({ code: "swap_not_executable" });
    expect(stubs.initiateLoopOut).toHaveBeenCalledTimes(1);
  });

  it("'initiating' itself still gets swap_in_progress", async () => {
    const { id, run } = await quoteAndInitiate();
    db.prepare("UPDATE swap_requests SET status = 'initiating' WHERE id = ?").run(id);
    await expect(run()).rejects.toMatchObject({ code: "swap_in_progress" });
  });
});

describe("the claim: every refusal after it releases or terminally marks the row", () => {
  // RELEASED → back to the prior status, and the same quote can be retried.
  it("ceiling_mismatch → released; a correct retry then succeeds", async () => {
    const { swapRequest } = await svc.createLoopOutQuote({
      nodePubkey: MEMBER, role: "member", amountSat: 250_000, destinationAddress: DEST,
    });
    await expect(svc.initiateSwap(swapRequest.id, DEST, { ...LOOP_OUT_CEILINGS, max_swap_fee_sat: 1 }))
      .rejects.toMatchObject({ code: "ceiling_mismatch" });
    expect(statusOf(swapRequest.id).status).toBe("quote_created");
    await svc.initiateSwap(swapRequest.id, DEST, LOOP_OUT_CEILINGS);
    expect(statusOf(swapRequest.id).status).toBe("initiated");
  });

  it("route_fee_over_cap → released", async () => {
    routes({ [PAYMENT_DEST]: { routable: true, feeSat: 9_999 } });
    const { id, run } = await quoteAndInitiate();
    await expect(run()).rejects.toMatchObject({ code: "route_fee_over_cap" });
    expect(statusOf(id).status).toBe("quote_created");
  });

  it("route_not_found → released", async () => {
    routes({});
    const { id, run } = await quoteAndInitiate();
    await expect(run()).rejects.toMatchObject({ code: "route_not_found" });
    expect(statusOf(id).status).toBe("quote_created");
  });

  it("a loopd error in the pre-checks (the fresh quote fails) → released, error propagates", async () => {
    stubs.quoteLoopOut
      .mockResolvedValueOnce({ amount_sat: 250_000, swap_fee_sat: 835, prepay_sat: 30_000, miner_fee_sat: 1_200, total_fee_sat: 32_035, conf_target: 6, swap_payment_dest: PAYMENT_DEST })
      .mockRejectedValueOnce(new Error("Loop RPC LoopOutQuote failed: unavailable (code 14)"));
    const { id, run } = await quoteAndInitiate();
    await expect(run()).rejects.toThrow("LoopOutQuote failed");
    expect(statusOf(id).status).toBe("quote_created");
  });

  // TERMINAL → expired, failure_reason = the code. The quote cannot succeed as is.
  it("fee_rate_over_quote (Loop Out) → expired", async () => {
    stubs.quoteLoopOut
      .mockResolvedValueOnce({ amount_sat: 250_000, swap_fee_sat: 835, prepay_sat: 30_000, miner_fee_sat: 1_200, total_fee_sat: 32_035, conf_target: 6, swap_payment_dest: PAYMENT_DEST })
      .mockResolvedValueOnce({ amount_sat: 250_000, swap_fee_sat: 835, prepay_sat: 30_000, miner_fee_sat: 5_000, total_fee_sat: 0, conf_target: 6, swap_payment_dest: PAYMENT_DEST });
    const { id, run } = await quoteAndInitiate();
    await expect(run()).rejects.toMatchObject({ code: "fee_rate_over_quote" });
    expect(statusOf(id)).toEqual({ status: "expired", failure_reason: "fee_rate_over_quote" });
  });

  it("fee_rate_over_quote (Loop In) → expired", async () => {
    stubs.quoteLoopIn.mockResolvedValueOnce(loopInQuote(900)).mockResolvedValueOnce(loopInQuote(5_000));
    const { id, run } = await quoteAndInitiateLoopIn();
    await expect(run()).rejects.toMatchObject({ code: "fee_rate_over_quote" });
    expect(statusOf(id)).toEqual({ status: "expired", failure_reason: "fee_rate_over_quote" });
  });

  it("miner_fee_unknown at execute → expired", async () => {
    stubs.quoteLoopIn.mockResolvedValueOnce(loopInQuote(900)).mockResolvedValueOnce(loopInQuote(0));
    const { id, run } = await quoteAndInitiateLoopIn();
    await expect(run()).rejects.toMatchObject({ code: "miner_fee_unknown" });
    expect(statusOf(id)).toEqual({ status: "expired", failure_reason: "miner_fee_unknown" });
  });

  it("requote_required → expired", async () => {
    const id = insertPreMigrationRow("loop_out");
    await expect(svc.initiateSwap(id, DEST, {})).rejects.toMatchObject({ code: "requote_required" });
    expect(statusOf(id)).toEqual({ status: "expired", failure_reason: "requote_required" });
  });

  // Ruling i: a 409 with its own code, quote_expired (a SwapRefusalError, so
  // the execute handlers answer it as 409 { error, detail }), instead of the
  // plain Error the dispatcher turned into a 500. Row handling unchanged.
  it("a quote past its expiry → quote_expired refusal; the row is expired (as before), never left initiating", async () => {
    const { swapRequest } = await svc.createLoopOutQuote({
      nodePubkey: MEMBER, role: "member", amountSat: 250_000, destinationAddress: DEST,
    });
    db.prepare("UPDATE swap_requests SET quote_expires_at = ? WHERE id = ?").run(Date.now() - 1, swapRequest.id);
    const err = await svc.initiateSwap(swapRequest.id, DEST, LOOP_OUT_CEILINGS).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(SwapRefusalError);
    expect(err).toMatchObject({ code: "quote_expired" });
    expect(statusOf(swapRequest.id)).toEqual({ status: "expired", failure_reason: null });
    expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
  });
});

// ─── D (member Loop In), spec §4 D ──────────────────────────────────────────

async function quoteAndInitiateLoopIn() {
  const { swapRequest } = await svc.createLoopInQuote({ nodePubkey: MEMBER, role: "member", amountSat: 250_000 });
  return { id: swapRequest.id, run: () => svc.initiateSwap(swapRequest.id, undefined, LOOP_IN_CEILINGS) };
}

function loopInQuote(htlcFeeSat: number) {
  return { amount_sat: 250_000, swap_fee_sat: 500, htlc_publish_fee_sat: htlcFeeSat, total_fee_sat: 500 + Math.max(0, htlcFeeSat), conf_target: 6 };
}

describe("D16 and §4 D: Loop In ceilings", () => {
  it("D16: max_swap_fee is the quoted swap fee alone, without the HTLC fee", async () => {
    const { run } = await quoteAndInitiateLoopIn();
    await run();
    expect(stubs.initiateLoopIn.mock.calls[0][0].maxSwapFee).toBe(500);
  });

  it("max_miner_fee is the quoted HTLC fee", async () => {
    const { run } = await quoteAndInitiateLoopIn();
    await run();
    expect(stubs.initiateLoopIn.mock.calls[0][0].maxMinerFee).toBe(900);
  });
});

describe("D3 (D): the fee-rate refusal fires before Loop In initiation", () => {
  // Stored HTLC fee 900; margin 50% → a fresh estimate above 1,350 refuses.
  it("fresh HTLC fee 1,351 → fee_rate_over_quote, no loopd initiation", async () => {
    stubs.quoteLoopIn.mockResolvedValueOnce(loopInQuote(900)).mockResolvedValueOnce(loopInQuote(1_351));
    const { run } = await quoteAndInitiateLoopIn();
    await expect(run()).rejects.toMatchObject({ code: "fee_rate_over_quote" });
    expect(stubs.initiateLoopIn).not.toHaveBeenCalled();
  });

  it("fresh HTLC fee 1,350 (exactly quote + 50%) proceeds", async () => {
    stubs.quoteLoopIn.mockResolvedValueOnce(loopInQuote(900)).mockResolvedValueOnce(loopInQuote(1_350));
    const { run } = await quoteAndInitiateLoopIn();
    await run();
    expect(stubs.initiateLoopIn).toHaveBeenCalledTimes(1);
  });
});

describe("D12 (Ruling Z): a failed or zero HTLC-fee estimate is unknown, and refused", () => {
  // In getLoopInQuote loopd's −1 ("estimation failed") becomes null, not 0
  // (the null at execute: swapService.executeNullMinerFee.test.ts); the 0 here
  // is a genuine zero estimate, refused the same way.
  it("a quote with a zero HTLC fee is refused with miner_fee_unknown, and no quote is stored", async () => {
    stubs.quoteLoopIn.mockResolvedValueOnce(loopInQuote(0));
    const before = (db.prepare("SELECT COUNT(*) AS n FROM swap_requests").get() as { n: number }).n;
    await expect(svc.createLoopInQuote({ nodePubkey: MEMBER, role: "member", amountSat: 250_000 }))
      .rejects.toMatchObject({ code: "miner_fee_unknown" });
    const after = (db.prepare("SELECT COUNT(*) AS n FROM swap_requests").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("a fresh estimate that fails at execute is refused with miner_fee_unknown before initiation", async () => {
    stubs.quoteLoopIn.mockResolvedValueOnce(loopInQuote(900)).mockResolvedValueOnce(loopInQuote(0));
    const { run } = await quoteAndInitiateLoopIn();
    await expect(run()).rejects.toMatchObject({ code: "miner_fee_unknown" });
    expect(stubs.initiateLoopIn).not.toHaveBeenCalled();
  });
});

// D19 (item 30): no swap_request response carries max_fee_sat; the column
// stays in the database, unread. Every swap_request a route returns comes from
// getSwapRequest or listSwapRequests (createLoopOutQuote, createLoopInQuote
// and initiateSwap all return getSwapRequest's row), so those two are the
// boundary. The row needs a NON-NULL max_fee_sat, as a pre-fix row can have —
// otherwise a restored echo of a null would be all this could catch.
describe("D19: max_fee_sat is never in a swap_request", () => {
  function insertRowWithMaxFee(): string {
    const id = insertPreMigrationRow("loop_out");
    db.prepare("UPDATE swap_requests SET max_fee_sat = 12345 WHERE id = ?").run(id);
    return id;
  }

  it("getSwapRequest omits it", () => {
    const id = insertRowWithMaxFee();
    const row = svc.getSwapRequest(id)!;
    expect(row.id).toBe(id);
    expect(row).not.toHaveProperty("max_fee_sat");
  });

  it("listSwapRequests omits it", () => {
    const id = insertRowWithMaxFee();
    const rows = svc.listSwapRequests({ nodePubkey: MEMBER });
    expect(rows.some((r) => r.id === id)).toBe(true);
    for (const r of rows) expect(r).not.toHaveProperty("max_fee_sat");
  });

  it("the column itself stays in the database", () => {
    const cols = (db.prepare("PRAGMA table_info(swap_requests)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("max_fee_sat");
  });
});

describe("D8: a pre-migration row requires a requote", () => {
  it.each(["loop_out", "loop_in"] as const)(
    "%s with null quote components is refused before any loopd call",
    async (swapType) => {
      const id = insertPreMigrationRow(swapType);
      await expect(svc.initiateSwap(id, swapType === "loop_out" ? DEST : undefined, {}))
        .rejects.toMatchObject({ code: "requote_required" });
      expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
      expect(stubs.initiateLoopIn).not.toHaveBeenCalled();
    },
  );
});
