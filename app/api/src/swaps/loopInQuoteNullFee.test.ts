// Drive-mode P1 item 10 (D1.12): with the clamp gone, a failed HTLC-fee
// estimate reaches createLoopInQuote as null — and is refused with
// miner_fee_unknown (Ruling Z, its §7.1 detail text unchanged) before any
// swap_requests row exists, so no member surface can show it as 0.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-loopin-null-fee-"));

vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    // loopd's −1, as getLoopInQuote now reports it.
    getLoopInQuote: vi.fn(async () => ({
      swap_fee_sat: 250, htlc_publish_fee_sat: null, cltv_delta: 1000, conf_target: 6, total_cost_sats: null,
    })),
  };
});

let db: typeof import("../db").db;
let createLoopInQuote: typeof import("./swapService").createLoopInQuote;

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ createLoopInQuote } = await import("./swapService"));
});

describe("D1.12 — a null HTLC fee is refused before anything is stored", () => {
  it("miner_fee_unknown, with the ruled detail text, and no row", async () => {
    const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM swap_requests").get() as { n: number }).n;
    const before = rows();
    await expect(createLoopInQuote({ nodePubkey: "02aa", role: "member", amountSat: 250_000 })).rejects.toMatchObject({
      code: "miner_fee_unknown",
      message: "The network fee for this refill couldn't be estimated right now. Try again in a few minutes.",
    });
    expect(rows()).toBe(before);
  });
});
