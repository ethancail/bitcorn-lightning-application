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

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-ceilings-test-"));

const stubs = vi.hoisted(() => ({
  quoteLoopOut: vi.fn(),
  quoteLoopIn: vi.fn(),
  initiateLoopOut: vi.fn(),
  initiateLoopIn: vi.fn(),
  recordSwapEvent: vi.fn(),
}));

vi.mock("./loopProvider", () => ({
  quoteLoopOut: stubs.quoteLoopOut,
  quoteLoopIn: stubs.quoteLoopIn,
  initiateLoopOut: stubs.initiateLoopOut,
  initiateLoopIn: stubs.initiateLoopIn,
  recordSwapEvent: stubs.recordSwapEvent,
  generateDestinationAddress: vi.fn(),
}));

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
  });
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
