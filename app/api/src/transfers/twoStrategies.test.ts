// R59(4) [RELAYED — drive-mode arc chat, 2026-11-12], from R50(1): two
// answers, "Wait for low fees" (save) and "Move sooner" (open). "Manual
// only" is dropped. A stored "manual" reads as "save" (it always behaved as
// save: swapOptions and the minimum formula treat it so, R21(1)), and a PATCH
// that sends "manual" is a 400 with nothing written. No migration: the row
// keeps what it holds.
//
// Harness: real migrations on a temp-dir DB, driven through handleRequest;
// the rate and loopd stubbed for the options read.

import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-two-strategies-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);

vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 2_000_000 })),
    getLoopInTerms: vi.fn(async () => ({ min_swap_amount: 100_000, max_swap_amount: 3_000_000 })),
    getLoopOutQuote: vi.fn(async (amt: number) => ({ swap_fee_sat: Math.ceil(amt / 100), prepay_amt_sat: 30_000, miner_fee: 3_000, total_cost_sats: 0, conf_target: 6, swap_payment_dest: "" })),
  };
});
vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ pubkey: ME, node_role: "member", membership_status: "active_member" }) };
});
vi.mock("../price/btcUsdCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../price/btcUsdCache")>();
  return { ...actual, getBtcUsd: () => ({ usd: 100_000, source: "coinbase", fetched_at: 1, age_ms: 0, state: "fresh" }) };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

beforeEach(() => {
  db.prepare("DELETE FROM member_transfer_settings").run();
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat, commit_fee_sat, commitment_type, is_initiator)
    VALUES ('800000x1x0', ?, 1000000, 600000, 390000, 1, 0, ?, 10000, 10000, 872, 'anchor', 0)
  `).run(HUB, Date.now());
});

/** A row as a member who chose Manual only before R50(1) would have it. */
function storeManual() {
  db.prepare("INSERT INTO member_transfer_settings (id, strategy) VALUES (1, 'manual')").run();
}
const rows = () => db.prepare("SELECT * FROM member_transfer_settings").all();

async function get(url: string): Promise<any> {
  let out = "";
  const res: any = { setHeader() {}, writeHead() { return res; }, end(c?: string) { if (c) out += c; return res; } };
  await handleRequest({ method: "GET", url, headers: {} } as any, res);
  return JSON.parse(out);
}

async function patch(body: unknown): Promise<{ status: number; json: any }> {
  const req: any = new EventEmitter();
  req.method = "PATCH";
  req.url = "/api/transfers/settings";
  req.headers = { "content-type": "application/json" };
  let status = 0;
  let out = "";
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const res: any = { setHeader() {}, writeHead(s: number) { status = s; return res; }, end(c?: string) { if (c) out += c; done(); return res; } };
  const handled = handleRequest(req, res);
  await new Promise((r) => setImmediate(r));
  req.emit("data", Buffer.from(JSON.stringify(body)));
  req.emit("end");
  await handled;
  await finished;
  return { status, json: JSON.parse(out) };
}

describe("runtime", () => {
  it("runs on Node 20 (the pinned runtime)", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });
});

describe("a stored 'manual' reads as 'save'", () => {
  it("GET: what applies is save; the row itself is left as it is", async () => {
    storeManual();
    const b = await get("/api/transfers/settings");
    expect(b.settings.strategy).toBe("save");
    expect((rows()[0] as any).strategy, "no data change").toBe("manual");
  });

  it("the Withdraw options read save too", async () => {
    storeManual();
    const b = await get("/api/swaps/options?direction=loop_out");
    expect(b.strategy).toBe("save");
  });
});

describe("PATCH refuses 'manual'", () => {
  it("400, and nothing is written", async () => {
    const r = await patch({ strategy: "manual" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_transfer_settings");
    expect(r.json.details).toContain("strategy must be 'save' or 'open'");
    expect(rows()).toEqual([]);
  });

  it("over a stored 'manual' too: the row is unchanged", async () => {
    storeManual();
    const r = await patch({ strategy: "manual", fee_limit_usd_cents: 400 });
    expect(r.status).toBe(400);
    expect(rows()).toMatchObject([{ strategy: "manual", fee_limit_usd_cents: null }]);
  });

  it("'save' and 'open' are accepted (anti-vacuity: the route writes)", async () => {
    expect((await patch({ strategy: "open" })).status).toBe(200);
    expect((rows()[0] as any).strategy).toBe("open");
    expect((await patch({ strategy: "save" })).status).toBe(200);
    expect((rows()[0] as any).strategy).toBe("save");
  });
});
