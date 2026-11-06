// Drive-mode P3 (R40(5); R18(9)): a completed swap's fee is stored in dollars
// as of completion — swap_requests.actual_fee_usd_cents — ONLY when the
// cached rate is fresh. Stale or no rate: NULL, so the record shows sats and
// never today's price.
//
// Harness: swapPoller.failureReason.test.ts's (real migrations on a temp-dir
// DB; loopd's swap list and the cached rate stubbed).

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-poller-fee-usd-"));

const live = vi.hoisted(() => ({ swaps: [] as any[], rate: { usd: 100_000 as number | null, state: "fresh" as string } }));
vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return { ...actual, listLoopSwaps: vi.fn(async () => live.swaps) };
});
vi.mock("../price/btcUsdCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../price/btcUsdCache")>();
  return { ...actual, getBtcUsd: () => ({ usd: live.rate.usd, source: "coinbase", fetched_at: 1, age_ms: 0, state: live.rate.state }) };
});

let db: typeof import("../db").db;
let pollSwapStatuses: typeof import("./swapPoller").pollSwapStatuses;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ pollSwapStatuses } = await import("./swapPoller"));
});

function inflight(providerId: string): string {
  const id = crypto.randomUUID();
  const t = Date.now();
  db.prepare(`
    INSERT INTO swap_requests (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status, amount_sat, quote_expires_at)
    VALUES (?, ?, ?, '02aa', 'member', 'loop_out', 'lightning_to_chain', 'initiated', 500000, ?)
  `).run(id, t, t, t + 3_600_000);
  db.prepare(`
    INSERT INTO swap_executions (id, swap_request_id, provider, provider_swap_id, status, started_at)
    VALUES (?, ?, 'loop', ?, 'initiated', ?)
  `).run(crypto.randomUUID(), id, providerId, t);
  return id;
}

// Fees 2,500 + 1,800 + 200 = 4,500 sats; at $100,000/BTC that is $4.50.
const completed = (id: string) => ({
  id, type: "LOOP_OUT", state: "SUCCESS", amount: 500_000, cost_server: 2_500, cost_onchain: 1_800,
  cost_offchain: 200, initiation_time: 0, last_update_time: 0, failure_reason: null,
});

const row = (id: string) =>
  db.prepare("SELECT status, actual_fee_sat, actual_fee_usd_cents FROM swap_requests WHERE id = ?").get(id) as any;

describe("the completed fee in dollars, stored only with a fresh rate", () => {
  it("fresh rate: 4,500 sats at $100,000 → 450 cents", async () => {
    live.rate = { usd: 100_000, state: "fresh" };
    const id = inflight("p-fresh");
    live.swaps = [completed("p-fresh")];
    await pollSwapStatuses();
    expect(row(id)).toEqual({ status: "completed", actual_fee_sat: 4_500, actual_fee_usd_cents: 450 });
  });

  it("stale rate: NULL (the record shows sats)", async () => {
    live.rate = { usd: 100_000, state: "stale" };
    const id = inflight("p-stale");
    live.swaps = [completed("p-stale")];
    await pollSwapStatuses();
    expect(row(id)).toEqual({ status: "completed", actual_fee_sat: 4_500, actual_fee_usd_cents: null });
  });

  it("no rate: NULL", async () => {
    live.rate = { usd: null, state: "none" };
    const id = inflight("p-none");
    live.swaps = [completed("p-none")];
    await pollSwapStatuses();
    expect(row(id).actual_fee_usd_cents).toBeNull();
  });
});
