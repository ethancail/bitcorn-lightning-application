// R50(4), ruled by R59(1) [RELAYED — drive-mode arc chat, 2026-11-12]: the
// per-transfer fee limit is ONE dollar figure (R48). The percent limit is
// REMOVED from code and API; the fee_limit_pct_bps column (migration 076)
// stays in the table, unread, with no migration.
//   (a) a percent stored straight into the row (1 bp) changes nothing: not
//       the option cards, not Q
//   (b) $50k, farmer: a 5,544-sat fee ($2.77) is inside $3 (2% flagged it)
//   (c) $73,700, merchant: a 100,000-sat top-up's 2,500-sat fee ($1.84) is
//       inside the limit (2% of 100,000 = 2,000 flagged it)
//   (d) no price: the cards are NOT flagged (R59(2)), and the server says the
//       limit could not be checked; with a price it says it was
//   (e) GET carries no percent anywhere; a PATCH that sends one is a 400
//       "unknown field" and writes nothing
//   (f) no fee_limit_pct_bps / feeLimitPct* reference in app/api/src outside
//       the migrations, their tests, and THIS file (which must name the
//       column to store it)
//
// Harness: swapOptions.route.test.ts's (real migrations on a temp-dir DB;
// loopd, lnd's wallet, node info and the cached rate stubbed), with the rate
// a variable.

import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-no-fee-percent-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);

const live = vi.hoisted(() => ({ usd: 100_000 as number | null }));
vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 2_000_000 })),
    getLoopInTerms: vi.fn(async () => ({ min_swap_amount: 100_000, max_swap_amount: 3_000_000 })),
    // swapOptions.route.test.ts's quotes: 1% + a 3,000 sweep out; 0.5% + 2,000 in.
    getLoopOutQuote: vi.fn(async (amt: number) => ({ swap_fee_sat: Math.ceil(amt / 100), prepay_amt_sat: 30_000, miner_fee: 3_000, total_cost_sats: 0, conf_target: 6, swap_payment_dest: "" })),
    getLoopInQuote: vi.fn(async (amt: number) => ({ swap_fee_sat: Math.ceil(amt / 200), htlc_publish_fee_sat: 2_000, cltv_delta: 0, conf_target: 6, total_cost_sats: 0 })),
  };
});
vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndChainBalance: vi.fn(async () => ({ chain_balance: 100_000_000 })),
    getLndChainFeeRate: vi.fn(async () => ({ tokens_per_vbyte: 2 })),
  };
});
vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ pubkey: ME, node_role: "member", membership_status: "active_member" }) };
});
vi.mock("../price/btcUsdCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../price/btcUsdCache")>();
  return {
    ...actual,
    getBtcUsd: () => ({ usd: live.usd, source: "coinbase", fetched_at: 1, age_ms: 0, state: live.usd == null ? "none" : "fresh" }),
  };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { clearSwapOptionsQuoteCache } = await import("../swaps/swapOptions");
const { usdCentsToSats } = await import("./minimumConnection");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

/** A non-funder hub channel: room to send = local − 10,000, room to receive =
 *  remote − 10,000. Commit fee 872 on an anchor channel (the golden inputs). */
function hub(local: number, remote: number) {
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat, commit_fee_sat, commitment_type, is_initiator)
    VALUES ('800000x1x0', ?, 1000000, ?, ?, 1, 0, ?, 10000, 10000, 872, 'anchor', 0)
  `).run(HUB, local, remote, Date.now());
}

/** (a)'s row: a 1 bp percent written straight into the column, as a member
 *  who saved one before this change would have it. */
function storeOneBasisPoint(feeUsdCents: number | null = null) {
  db.prepare("DELETE FROM member_transfer_settings").run();
  db.prepare("INSERT INTO member_transfer_settings (id, fee_limit_pct_bps, fee_limit_usd_cents) VALUES (1, 1, ?)").run(feeUsdCents);
}

function role(r: "farmer" | "merchant" | "unknown") {
  db.prepare("UPDATE member_liquidity_advisor_config SET channel_role = ? WHERE id = 1").run(r);
}

beforeEach(() => {
  clearSwapOptionsQuoteCache();
  live.usd = 100_000;
  db.prepare("DELETE FROM member_transfer_settings").run();
  db.prepare("DELETE FROM fee_estimate_samples").run();
  role("unknown");
});

async function get(url: string): Promise<{ status: number; body: any }> {
  let status = 0;
  let out = "";
  const res: any = { setHeader() {}, writeHead(s: number) { status = s; return res; }, end(c?: string) { if (c) out += c; return res; } };
  await handleRequest({ method: "GET", url, headers: {} } as any, res);
  return { status, body: JSON.parse(out) };
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

const nowCard = (b: any) => b.cards.find((c: any) => c.key === "now");

describe("runtime", () => {
  it("runs on Node 20 (the pinned runtime)", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });
});

describe("(a) a stored 1 bp percent changes nothing", () => {
  it("the Withdraw card: inside a $50 limit, not flagged (1 bp of 531,600 would be 53 sats)", async () => {
    hub(600_000, 390_000);
    storeOneBasisPoint(5_000);
    const { body } = await get("/api/swaps/options?direction=loop_out");
    expect(nowCard(body).fee_sats).toBe(8_316);
    expect(nowCard(body).over_fee_limit).toBe(false);
    expect(body.reason).not.toBe("over_fee_limit");
  });

  it("Q: still the dollar figure ($3 at $100,000 = 3,000 sats), not 1 bp of 250,000 (25)", async () => {
    hub(600_000, 390_000);
    role("farmer");
    storeOneBasisPoint();
    const { body } = await get("/api/transfers/settings");
    expect(body.member.save.Q).toBe(3_000);
    expect(body.member.open.Q).toBe(3_000);
  });
});

describe("(b) $50,000, farmer: the dollar figure alone decides", () => {
  it("a 5,544-sat fee ($2.77) on 254,400 is inside $3 (6,000 sats); 2% (5,088) flagged it", async () => {
    live.usd = 50_000;
    hub(320_000, 670_000); // room to send 310,000 → spendable 260,000
    const { body } = await get("/api/swaps/options?direction=loop_out");
    expect(nowCard(body).amount_sats).toBe(254_400);
    expect(nowCard(body).fee_sats).toBe(5_544);
    expect(usdCentsToSats(300, 50_000)).toBe(6_000);
    expect(nowCard(body).over_fee_limit).toBe(false);
  });
});

describe("(c) $73,700, merchant: Loop In's smallest top-up", () => {
  it("100,000 sats, fee 2,500 ($1.84): inside the limit; 2% (2,000) flagged it", async () => {
    live.usd = 73_700;
    hub(500_000, 490_000);
    const { body } = await get("/api/swaps/options?direction=loop_in");
    expect(nowCard(body).amount_sats).toBe(100_000);
    expect(nowCard(body).fee_sats).toBe(2_500);
    expect(nowCard(body).over_fee_limit).toBe(false);
  });
});

describe("(d) no price (R59(2)): not flagged, and said to be unchecked", () => {
  it("Top Up with no rate: the card carries its fee in sats and is not flagged; the limit is unchecked", async () => {
    live.usd = null;
    hub(500_000, 490_000);
    const { body } = await get("/api/swaps/options?direction=loop_in");
    expect(nowCard(body).fee_sats).toBe(2_500);
    expect(nowCard(body).over_fee_limit).toBe(false);
    expect(body.reason).not.toBe("over_fee_limit");
    expect(body.fee_limit_checked).toBe(false);
  });

  it("with a rate the limit is checked", async () => {
    hub(500_000, 490_000);
    const { body } = await get("/api/swaps/options?direction=loop_in");
    expect(body.fee_limit_checked).toBe(true);
  });
});

describe("(e) the API carries no percent", () => {
  it("GET: no key or value names a percent anywhere in the body", async () => {
    storeOneBasisPoint();
    const { status, body } = await get("/api/transfers/settings");
    expect(status).toBe(200);
    expect(JSON.stringify(body)).not.toMatch(/pct/i);
    expect(body.stored.fee_limit_usd_cents, "anti-vacuity: the settings body was read").toBeNull();
  });

  it("PATCH with the percent: 400 'unknown field', and nothing is written", async () => {
    const r = await patch({ fee_limit_pct_bps: 150 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_transfer_settings");
    expect(r.json.details).toContain("unknown field: fee_limit_pct_bps");
    expect(db.prepare("SELECT * FROM member_transfer_settings").all()).toEqual([]);
  });
});

describe("(f) static: nothing in app/api/src reads the percent", () => {
  const SRC = path.resolve(__dirname, "..");
  const PATTERN = /fee_limit_pct_bps|feeLimitPct/;
  const SELF = path.relative(SRC, __filename);
  const allowed = (rel: string) =>
    rel.startsWith(`db${path.sep}migrations${path.sep}`) || /^db[\\/]migrate\.[^\\/]+\.test\.ts$/.test(rel) || rel === SELF;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|sql)$/.test(name)) out.push(p);
    }
    return out;
  }

  it("no reference outside the migrations, their tests and this file", () => {
    const files = walk(SRC);
    const hits = files
      .map((p) => path.relative(SRC, p))
      .filter((rel) => !allowed(rel) && PATTERN.test(fs.readFileSync(path.join(SRC, rel), "utf8")));
    expect(hits).toEqual([]);
  });

  it("anti-vacuity: the scan reads the tree and would find the column (076 names it)", () => {
    const files = walk(SRC).map((p) => path.relative(SRC, p));
    expect(files.length).toBeGreaterThan(100);
    const m076 = files.find((f) => /076_.*\.sql$/.test(f));
    expect(m076).toBeDefined();
    expect(PATTERN.test(fs.readFileSync(path.join(SRC, m076!), "utf8"))).toBe(true);
  });
});
