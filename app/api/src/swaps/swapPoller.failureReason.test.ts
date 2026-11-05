// Drive-mode P1 item 9 (spec P1 item 9; D1.11; R18(12)): when a swap fails,
// the poller stores loopd's raw failure code in swap_requests.failure_reason,
// and falls back to "Loop state: FAILED" only when loopd gives none. P1 stores
// the codes; the member-facing sentences are P2's.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-poller-failure-reason-"));

const loop = vi.hoisted(() => ({ swaps: [] as any[] }));
vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return { ...actual, listLoopSwaps: vi.fn(async () => loop.swaps) };
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
    VALUES (?, ?, ?, '02aa', 'member', 'loop_out', 'lightning_to_chain', 'initiated', 250000, ?)
  `).run(id, t, t, t + 3_600_000);
  db.prepare(`
    INSERT INTO swap_executions (id, swap_request_id, provider, provider_swap_id, status, started_at)
    VALUES (?, ?, 'loop', ?, 'initiated', ?)
  `).run(crypto.randomUUID(), id, providerId, t);
  return id;
}

const reason = (id: string) =>
  (db.prepare("SELECT status, failure_reason FROM swap_requests WHERE id = ?").get(id) as any);

const failed = (id: string, failure_reason: string | null) => ({
  id, type: "LOOP_OUT", state: "FAILED", amount: 250_000, cost_server: 0, cost_onchain: 0,
  cost_offchain: 0, initiation_time: 0, last_update_time: 0, failure_reason,
});

describe("D1.11 — the poller stores loopd's failure reason", () => {
  it("a failed swap with a reason stores the raw code", async () => {
    const id = inflight("p-offchain");
    loop.swaps = [failed("p-offchain", "FAILURE_REASON_OFFCHAIN")];
    await pollSwapStatuses();
    expect(reason(id)).toEqual({ status: "failed", failure_reason: "FAILURE_REASON_OFFCHAIN" });
  });

  it("a failed swap with no reason falls back to 'Loop state: FAILED'", async () => {
    const id = inflight("p-none");
    loop.swaps = [failed("p-none", null)];
    await pollSwapStatuses();
    expect(reason(id)).toEqual({ status: "failed", failure_reason: "Loop state: FAILED" });
  });
});
