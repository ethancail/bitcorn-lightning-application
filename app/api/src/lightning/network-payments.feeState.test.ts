// Drive-mode P1 item 5 (spec P1 item 5; D1.7; finding 4): a payment's fee
// state is derived from its status, with no schema change — fee_sats stays
// NOT NULL DEFAULT 0 (migration 022), so 0 alone cannot tell "no fee" from
// "not known yet" or "never charged".

import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-fee-state-test-"));

type Mod = typeof import("./network-payments");
let getNetworkPayments: Mod["getNetworkPayments"];

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  const { db } = await import("../db");
  const row = (hash: string, direction: string, status: string, fee: number, at: number) =>
    db.prepare(`
      INSERT INTO network_payments (payment_hash, direction, status, amount_sats, fee_sats, created_at)
      VALUES (?, ?, ?, 1000, ?, ?)
    `).run(hash, direction, status, fee, at);
  row("paid", "send", "succeeded", 3, 6);
  row("zero", "send", "succeeded", 0, 5);
  row("pending", "send", "pending", 0, 4);
  row("failed", "send", "failed", 0, 3);
  row("expired", "send", "expired", 0, 2);
  row("received", "receive", "succeeded", 0, 1);
  ({ getNetworkPayments } = await import("./network-payments"));
});

describe("D1.7 — fee_state tells zero, pending and failed apart", () => {
  it("one state per case, derived from status and direction", () => {
    const byHash = Object.fromEntries(
      getNetworkPayments().map((p: any) => [p.payment_hash, p.fee_state]),
    );
    expect(byHash).toEqual({
      paid: "paid",
      zero: "zero",
      pending: "pending",
      failed: "failed",
      expired: "failed",
      received: "none",
    });
  });
});
