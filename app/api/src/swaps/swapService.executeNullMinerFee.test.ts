// Ruling Z at the execute site, for the null a failed estimate now is
// (drive-mode P1 item 10, 4ecbadf; R24 item 2).
//
// getLoopInQuote turns loopd's −1 ("estimation failed") into a null
// htlc_publish_fee_sat and total_fee_sat. loop-fee-ceilings' D12 block covers
// a zero at both sites; this file covers that null where it now arrives at
// execute: the stored quote was priced (900), the fresh quote assertLoopIn-
// Prechecks takes before initiation came back unknown. It must be refused with
// miner_fee_unknown, loopd must not be asked to start the swap, and the row
// must be terminal (expired) — the quote cannot succeed as is.
//
// Drives the real swapService against a temp-dir database built by the real
// migration runner. Only the loopd boundary (./loopProvider) and the LND
// route-probe primitive are mocked.
//
// ⚠ ORDERING: db/index.ts opens its file at module load from DB_DIR. Nothing
// that imports the db singleton is imported statically here; swapService and
// the migration runner are imported in beforeAll, after DB_DIR is set.

import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-execute-null-fee-"));
process.env.DB_DIR = TMP_DB;

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

vi.mock("../lightning/lnd", () => ({
  probeLoopOutPaymentRoute: stubs.probeLoopOutPaymentRoute,
}));

type Svc = typeof import("./swapService");
let svc: Svc;
let db: Database.Database;

const MEMBER = "02" + "11".repeat(32);
// The ceilings the execute body echoes for loopInQuote(900): swap fee 500,
// HTLC fee 900 — written out, not computed by the code under test.
const LOOP_IN_CEILINGS = { max_swap_fee_sat: 500, max_miner_fee_sat: 900 };

function loopInQuote(htlcFeeSat: number) {
  return { amount_sat: 250_000, swap_fee_sat: 500, htlc_publish_fee_sat: htlcFeeSat, total_fee_sat: 500 + htlcFeeSat, conf_target: 6 };
}

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  svc = await import("./swapService");
});

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

beforeEach(() => {
  vi.clearAllMocks();
  stubs.initiateLoopIn.mockResolvedValue({ swapHash: "h", id: "i", serverMessage: "", htlcAddress: "a" });
});

describe("Ruling Z at execute: a fresh HTLC-fee estimate that failed (null) is refused", () => {
  it("rejects with miner_fee_unknown, never calls initiateLoopIn, and leaves the row expired", async () => {
    stubs.quoteLoopIn
      .mockResolvedValueOnce(loopInQuote(900))
      .mockResolvedValueOnce({ ...loopInQuote(900), htlc_publish_fee_sat: null, total_fee_sat: null });

    const { swapRequest } = await svc.createLoopInQuote({ nodePubkey: MEMBER, role: "member", amountSat: 250_000 });
    await expect(svc.initiateSwap(swapRequest.id, undefined, LOOP_IN_CEILINGS))
      .rejects.toMatchObject({ code: "miner_fee_unknown" });

    expect(stubs.quoteLoopIn).toHaveBeenCalledTimes(2);
    expect(stubs.initiateLoopIn).not.toHaveBeenCalled();
    const row = db.prepare("SELECT status FROM swap_requests WHERE id = ?").get(swapRequest.id) as { status: string };
    expect(row.status).toBe("expired");
  });
});
