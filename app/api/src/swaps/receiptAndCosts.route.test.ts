// drive-mode P2 item 14 (D2.6), the server half:
//   GET /api/swaps/:id gains `receipt` — for a completed swap, the fee summary
//     and its three parts from loopd's own costs, stored in the provider_update
//     event (swapPoller.ts). The parts sum to the summary, which is the
//     actual_fee_sat the poller stored (swapPoller.ts :86). No migration.
//   GET /api/member/costs — the last 30 days: payment fees (succeeded sends)
//     and swap fees (completed swaps), per direction. No subscription line and
//     no treasury call (R27(9)).
//
// Harness: swapLimits.route.test.ts's (the real router over a migrated DB).

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-receipt-costs-route-"));
process.env.DB_DIR = TMP_DB;
const ME = "02" + "11".repeat(32);
const OTHER = "02" + "22".repeat(32);
const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ pubkey: ME, node_role: "member", membership_status: "active" }) };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { recordSwapEvent } = await import("./loopProvider");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  for (const t of ["swap_events", "swap_requests", "network_payments"]) db.prepare(`DELETE FROM ${t}`).run();
});

async function get(url: string): Promise<{ status: number | null; body: any }> {
  let status: number | null = null;
  let body = "";
  const res: any = { setHeader() {}, writeHead(s: number) { status = s; return res; }, end(c?: string) { if (c) body += c; return res; } };
  await handleRequest({ method: "GET", url, headers: {} } as any, res);
  return { status, body: JSON.parse(body) };
}

function swap(id: string, o: { type?: "loop_out" | "loop_in"; status?: string; fee?: number | null; at?: number; pubkey?: string } = {}) {
  const type = o.type ?? "loop_out";
  db.prepare(`
    INSERT INTO swap_requests (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status, amount_sat, actual_fee_sat)
    VALUES (?, ?, ?, ?, 'member', ?, ?, ?, 500000, ?)
  `).run(id, o.at ?? NOW, o.at ?? NOW, o.pubkey ?? ME, type,
    type === "loop_out" ? "lightning_to_chain" : "chain_to_lightning", o.status ?? "completed", o.fee ?? null);
}

/** The poller's event, exactly as swapPoller.ts writes it. */
function providerUpdate(id: string, new_status: string, costs: { server: number; onchain: number; offchain: number }) {
  recordSwapEvent(id, "provider_update", {
    old_status: "confirming", new_status, loop_state: new_status === "completed" ? "SUCCESS" : "INITIATED",
    cost_server: costs.server, cost_onchain: costs.onchain, cost_offchain: costs.offchain,
  });
}

function payment(o: { status: string; fee: number; settled_at: number | null; direction?: "send" | "receive" }) {
  db.prepare(`
    INSERT INTO network_payments (payment_hash, direction, status, amount_sats, fee_sats, created_at, settled_at)
    VALUES (?, ?, ?, 10000, ?, ?, ?)
  `).run(Math.random().toString(36), o.direction ?? "send", o.status, o.fee, o.settled_at ?? NOW, o.settled_at);
}

describe("GET /api/swaps/:id — the receipt", () => {
  it("a completed swap: the summary and its three parts, which sum to it", async () => {
    swap("s1", { fee: 4_321 });
    providerUpdate("s1", "executing", { server: 0, onchain: 0, offchain: 0 });
    providerUpdate("s1", "completed", { server: 2_500, onchain: 1_800, offchain: 21 });
    const r = await get("/api/swaps/s1");
    expect(r.status).toBe(200);
    expect(r.body.receipt).toEqual({ total_sat: 4_321, swap_fee_sat: 2_500, network_fee_sat: 1_800, routing_fee_sat: 21 });
    const { total_sat, swap_fee_sat, network_fee_sat, routing_fee_sat } = r.body.receipt;
    expect(swap_fee_sat + network_fee_sat + routing_fee_sat).toBe(total_sat);
    expect(total_sat).toBe(r.body.swap_request.actual_fee_sat);
  });

  it("not completed: no receipt", async () => {
    swap("s2", { status: "executing", fee: null });
    providerUpdate("s2", "executing", { server: 0, onchain: 0, offchain: 0 });
    expect((await get("/api/swaps/s2")).body.receipt).toBeNull();
  });

  it("completed with no stored costs (a row from before the poller's event): no receipt", async () => {
    swap("s3", { fee: 4_000 });
    expect((await get("/api/swaps/s3")).body.receipt).toBeNull();
  });
});

describe("GET /api/member/costs — the last 30 days", () => {
  it("payment fees from succeeded sends; swap fees from completed swaps, per direction", async () => {
    payment({ status: "succeeded", fee: 12, settled_at: NOW - DAY });
    payment({ status: "succeeded", fee: 30, settled_at: NOW - 29 * DAY });
    payment({ status: "succeeded", fee: 0, settled_at: NOW - DAY }); // P1's "zero" state
    payment({ status: "failed", fee: 99, settled_at: null }); // pays no fee
    payment({ status: "pending", fee: 77, settled_at: null });
    payment({ status: "succeeded", fee: 500, settled_at: NOW - 31 * DAY }); // outside the window
    payment({ status: "succeeded", fee: 400, settled_at: NOW - DAY, direction: "receive" });
    swap("o1", { type: "loop_out", fee: 4_000, at: NOW - 2 * DAY });
    swap("o2", { type: "loop_out", fee: 1_000, at: NOW - 40 * DAY }); // outside
    swap("o3", { type: "loop_out", status: "failed", fee: 900, at: NOW - DAY }); // not completed
    swap("i1", { type: "loop_in", fee: 2_200, at: NOW - 3 * DAY });
    swap("x1", { type: "loop_out", fee: 8_000, at: NOW - DAY, pubkey: OTHER }); // another node's
    const r = await get("/api/member/costs");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      since_ms: NOW - 30 * DAY,
      payment_fees_sat: 42,
      withdraw_fees_sat: 4_000,
      topup_fees_sat: 2_200,
      total_sat: 6_242,
    });
  });

  it("nothing in the window: zeros, not absences", async () => {
    const r = await get("/api/member/costs");
    expect(r.body).toEqual({ since_ms: NOW - 30 * DAY, payment_fees_sat: 0, withdraw_fees_sat: 0, topup_fees_sat: 0, total_sat: 0 });
  });
});
