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
    await svc.initiateSwap(swapRequest.id, DEST);
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
  return { id: swapRequest.id, run: () => svc.initiateSwap(swapRequest.id, DEST) };
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

describe("D8: a pre-migration row requires a requote", () => {
  it.each(["loop_out", "loop_in"] as const)(
    "%s with null quote components is refused before any loopd call",
    async (swapType) => {
      const id = insertPreMigrationRow(swapType);
      await expect(svc.initiateSwap(id, swapType === "loop_out" ? DEST : undefined))
        .rejects.toMatchObject({ code: "requote_required" });
      expect(stubs.initiateLoopOut).not.toHaveBeenCalled();
      expect(stubs.initiateLoopIn).not.toHaveBeenCalled();
    },
  );
});
