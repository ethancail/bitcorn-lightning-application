// GET /api/treasury/rebalance/loop-out/quote — the treasury preview's
// `acceptable` flag (loop-fee-ceilings spec §4 "Every site", B7).
//
// "Acceptable" means execute would not refuse at that moment, so the flag runs
// the same pre-checks executeLoopOut runs before any money moves (terms, the
// 15% sanity check, the daily loss cap, the fee-rate check and the route
// probe; the channel checks when a channel_id is given). It no longer reads
// the deleted 20,000-sat miner-fee setting (ruling 12).
//
// Driven through the real handleRequest and the real executeLoopOut
// pre-checks; only loopd and the LND probe/channel reads are replaced.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-loop-preview-test-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const PAYMENT_DEST = "03" + "fb".repeat(32);

const s = vi.hoisted(() => ({
  quotes: [] as any[],
  probe: vi.fn(),
}));

function quote(minerFee = 1_000) {
  return {
    swap_fee_sat: 2_000,
    prepay_amt_sat: 30_000,
    miner_fee: minerFee,
    total_cost_sats: 32_000 + minerFee,
    conf_target: 6,
    swap_payment_dest: PAYMENT_DEST,
  };
}

vi.mock("./utils/role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/role")>()),
  assertTreasury: () => {},
}));
vi.mock("./lightning/loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lightning/loop")>()),
  isLoopAvailable: async () => ({ available: true }),
  getLoopOutTerms: async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 }),
  getLoopOutQuote: async () => s.quotes.shift() ?? quote(),
}));
vi.mock("./lightning/lnd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lightning/lnd")>()),
  probeLoopOutPaymentRoute: s.probe,
}));

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let db: import("better-sqlite3").Database;
const RAISED_CAP = 10_000_000;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("./index"));
  const { runMigrations } = await import("./db/migrate");
  runMigrations();
  // The shipped default daily loss cap (5,000 sats) is below a quote's
  // total_cost_sats, which counts the ~30k prepay — so the loss cap alone
  // would make every preview here unacceptable. Raise it on this temp DB so
  // the other pre-checks are what each case exercises; the loss-cap case
  // below lowers it again.
  const { getCapitalPolicy } = await import("./api/treasury-capital-policy");
  getCapitalPolicy();
  ({ db } = await import("./db"));
  db.prepare("UPDATE treasury_capital_policy SET max_daily_loss_sats = ?").run(RAISED_CAP);
});

beforeEach(() => {
  s.quotes = [];
  s.probe.mockReset();
  s.probe.mockResolvedValue({ routable: true, feeSat: 3 });
});

function get(url: string): Promise<{ status: number; body: any }> {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = "GET";
  (req as any).url = url;
  (req as any).headers = {};
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let status = 0;
    let chunks = "";
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(st: number) { status = st; return res; },
      write(c: any) { if (c) chunks += c.toString(); return true; },
      end(c?: any) {
        if (c) chunks += c.toString();
        let parsed: any = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = null; }
        resolve({ status, body: parsed });
      },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    (req as unknown as PassThrough).end();
  });
}

const PREVIEW = "/api/treasury/rebalance/loop-out/quote?amount_sats=500000";

describe("the preview's acceptable flag runs execute's pre-checks", () => {
  it("everything passes → acceptable", async () => {
    const r = await get(PREVIEW);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ swap_fee_sat: 2_000, acceptable: true, refusal: null });
  });

  it("a probed route over the cap → not acceptable, with execute's refusal code", async () => {
    s.probe.mockImplementation(async (_d: string, amt: number) => ({ routable: true, feeSat: amt === 500_000 ? 5_001 : 3 }));
    const r = await get(PREVIEW);
    expect(r.body).toMatchObject({ acceptable: false, refusal: { code: "route_fee_over_cap" } });
  });

  it("no route → not acceptable, route_not_found", async () => {
    s.probe.mockResolvedValue({ routable: false });
    const r = await get(PREVIEW);
    expect(r.body).toMatchObject({ acceptable: false, refusal: { code: "route_not_found" } });
  });

  it("a fresh miner fee above the quote + 50% → not acceptable, fee_rate_over_quote", async () => {
    // The preview's displayed quote, the pre-check's in-call quote, then the fresh one.
    s.quotes = [quote(1_000), quote(1_000), quote(1_501)];
    const r = await get(PREVIEW);
    expect(r.body).toMatchObject({ acceptable: false, refusal: { code: "fee_rate_over_quote" } });
  });

  it("the daily loss cap → not acceptable, daily_loss_cap", async () => {
    db.prepare("UPDATE treasury_capital_policy SET max_daily_loss_sats = ?").run(5_000);
    try {
      const r = await get(PREVIEW);
      expect(r.body).toMatchObject({ acceptable: false, refusal: { code: "daily_loss_cap" } });
    } finally {
      db.prepare("UPDATE treasury_capital_policy SET max_daily_loss_sats = ?").run(RAISED_CAP);
    }
  });

  it("a miner fee above the deleted 20,000 constant, stable and routable → acceptable", async () => {
    s.quotes = [quote(25_000), quote(25_000), quote(25_000)];
    const r = await get(PREVIEW);
    expect(r.body).toMatchObject({ miner_fee: 25_000, acceptable: true });
  });
});
