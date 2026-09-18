// Controls for POST /api/autobuy/catch-up, driven through the real exported
// handleRequest — spec §7 K-3 leg 2, K-4 (all legs), K-5.
//
// ─── WHY A ROUTE TEST AND NOT A runTick TEST ────────────────────────────────
// The spec's §2 settled "test the CLAMP through runTick", and scheduler.clamp
// .test.ts does exactly that. But K-3 leg 2, K-4 and K-5 are controls on a
// ROUTE — POST /api/autobuy/catch-up — which lives in index.ts and is
// UNREACHABLE FROM A TICK. No amount of runTick driving can exercise a
// dispatch block. So these use the repo's existing *.route.test.ts harness
// (utils/action-confirmation.route.test.ts, utils/open-recommended-channel-
// removed.route.test.ts): a synthetic request through the real handleRequest,
// against a temp-dir DB the migration runner builds on import.
//
// That is a finding against the spec's §2, not a deviation from it: §2's
// recommendation was only ever about the clamp.
//
// ─── THE CONFIRMATION GATE IS IN FRONT OF THIS ROUTE ────────────────────────
// handleRequest classifies every non-GET BEFORE dispatch, so each call here
// carries a correct x-bitcorn-confirm header. The canonical string is
// `expected_intervals=<n>&expected_usd=<n>` — field order is the order declared
// in CONFIRMED_ROUTES, not alphabetical.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PassThrough } from "stream";
import type http from "http";
import Database from "better-sqlite3";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-catchup-test-"));

vi.hoisted(() => {
  process.env.AUTOBUY_ENABLED = "true";
  process.env.AUTOBUY_MAX_SINGLE_BUY_USD = "1000";
  process.env.AUTOBUY_MAX_7D_USD = "2000";
  process.env.AUTOBUY_MAX_30D_USD = "5000";
  process.env.AUTOBUY_STALE_DATA_MAX_HOURS = "48";
  process.env.AUTOBUY_FAILURE_PAUSE_THRESHOLD = "3";
});
process.env.DB_DIR = TMP_DB;

const stubs = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  listAccounts: vi.fn(),
  placeMarketBuy: vi.fn(),
  pollOrder: vi.fn(),
  placeWithdraw: vi.fn(),
  pollWithdraw: vi.fn(),
}));

vi.mock("./valuationClient", () => ({ getCurrent: stubs.getCurrent }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: stubs.listAccounts,
  placeMarketBuy: stubs.placeMarketBuy,
  pollOrder: stubs.pollOrder,
  placeWithdraw: stubs.placeWithdraw,
  pollWithdraw: stubs.pollWithdraw,
}));
vi.mock("./credentials", () => ({
  decrypt: () => "-----BEGIN EC PRIVATE KEY-----\nstub\n-----END EC PRIVATE KEY-----",
  encrypt: (s: string) => ({ ciphertext: Buffer.from(s), nonce: Buffer.from("n") }),
}));

// action-confirmation is a pure module and touches no db, so a static import is
// safe. ./scheduler is NOT: it pulls in the db singleton, and a static import
// would hoist above the DB_DIR assignment above and bind the REAL /data/db
// path. It is imported dynamically in beforeAll, beside ../index, for that
// reason alone — the same ordering the sibling *.route.test.ts files rely on.
import { CONFIRMATION_HEADER } from "../utils/action-confirmation";

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let runTick: (db: Database.Database) => Promise<void>;
let db: Database.Database;

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const WEEK = 7 * 86400;
const NOW = 1789646400;

type Captured = { status: number; body: any; raw: string };

function call(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Captured> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { "content-type": "application/json", ...headers };
  (req as any).socket = { remoteAddress: "127.0.0.1" };

  return new Promise((resolve) => {
    let status = 0;
    let chunks = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let parsed: any = null;
      try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = null; }
      resolve({ status, body: parsed, raw: chunks });
    };
    const res = {
      setHeader() {}, getHeader() {},
      writeHead(s: number) { status = s; return res; },
      end(c?: any) { if (c) chunks += c.toString(); finish(); },
      write(c: any) { if (c) chunks += c.toString(); return true; },
    } as unknown as http.ServerResponse;

    void handleRequest(req, res);
    setImmediate(() => { (req as unknown as PassThrough).end(raw); });
    setTimeout(() => { if (!done) { status = -1; chunks = ""; finish(); } }, 6000);
  });
}

/** POST the catch-up with a CORRECT confirmation for the figures being sent. */
const catchUp = (intervals: number, usd: number) =>
  call("POST", "/api/autobuy/catch-up", { expected_intervals: intervals, expected_usd: usd }, {
    [CONFIRMATION_HEADER]: sha(`expected_intervals=${intervals}&expected_usd=${usd}`),
  });

beforeAll(async () => {
  ({ handleRequest } = await import("../index"));
  ({ runTick } = await import("./scheduler"));
  // index.ts applies migrations from main(), behind its require.main guard —
  // importing it deliberately has NO side effects (see bootSideEffects). So the
  // schema has to be built here, or every query below hits a missing table.
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  db = new Database(path.join(TMP_DB, "bitcorn.sqlite"));
  // assertNonEmpty(node?.node_role) gates this route; without a node row every
  // call is a 403 and nothing below would be testing the catch-up at all.
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info (id, pubkey, alias, network, updated_at, node_role)
     VALUES (1, 'pk', 'test', 'regtest', ?, 'member')`,
  ).run(NOW);
});

afterAll(() => {
  db?.close();
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

/** Wipe run state and reseed config to a known shape between cases. */
function reset(over: Record<string, unknown> = {}): void {
  db.prepare(`DELETE FROM autobuy_runs`).run();
  db.prepare(`DELETE FROM autobuy_alerts`).run();
  const row = {
    enabled: 1, base_unit_usd: 100, frequency: "weekly",
    withdraw_address: "bcrt1qstub", withdraw_address_whitelisted_at: NOW - 10 * WEEK,
    next_run_at: NOW + WEEK, paused_reason: null, consecutive_failures: 0,
    currency_preference: "usdc_preferred",
    ...over,
  };
  db.prepare(
    `UPDATE autobuy_config
        SET enabled = ?, base_unit_usd = ?, frequency = ?, withdraw_address = ?,
            withdraw_address_whitelisted_at = ?, next_run_at = ?, paused_reason = ?,
            consecutive_failures = ?, currency_preference = ?
      WHERE id = 1`,
  ).run(
    row.enabled, row.base_unit_usd, row.frequency, row.withdraw_address,
    row.withdraw_address_whitelisted_at, row.next_run_at, row.paused_reason,
    row.consecutive_failures, row.currency_preference,
  );
  db.prepare(
    `INSERT OR REPLACE INTO coinbase_credentials
       (id, key_name, encrypted_private_key, nonce, connected_at)
     VALUES (1, 'stub-key', ?, ?, ?)`,
  ).run(Buffer.from("x"), Buffer.from("y"), NOW - WEEK);
}

/** n unclaimed passed-over intervals, oldest first. */
function seedMissed(n: number): void {
  const ins = db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, base_unit_usd, intended_buy_usd, status, error_code, created_at, updated_at)
     VALUES (?, 100, 100, 'skipped_missed_interval', 'clamped_past_interval', ?, ?)`,
  );
  for (let i = n; i >= 1; i--) ins.run(NOW - i * WEEK, NOW, NOW);
}

/** Filled spend inside the 7-day window, so the rolling caps bind. */
function seedFilledSpend(usd: number): void {
  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, base_unit_usd, intended_buy_usd, status, filled_usd, filled_btc, filled_at, created_at, updated_at)
     VALUES (?, 100, ?, 'buy_filled', ?, 0.01, ?, ?, ?)`,
  ).run(NOW - 86400, usd, usd, Math.floor(Date.now() / 1000) - 86400, NOW, NOW);
}

const unclaimed = () =>
  db.prepare(
    `SELECT id, scheduled_for FROM autobuy_runs
      WHERE status = 'skipped_missed_interval' AND claimed_by_run_id IS NULL
      ORDER BY scheduled_for ASC`,
  ).all() as Array<{ id: number; scheduled_for: number }>;

const buysPlaced = () =>
  db.prepare(`SELECT * FROM autobuy_runs WHERE status = 'buy_placed' ORDER BY id ASC`).all() as any[];

beforeEach(() => {
  vi.clearAllMocks();
  stubs.getCurrent.mockResolvedValue({
    ok: true,
    value: { z_score: -0.4, zone: "fair_value", updated_at: new Date().toISOString() },
  });
  stubs.listAccounts.mockResolvedValue({
    ok: true,
    data: { accounts: [{ currency: "USDC", available_balance: { value: "100000" } }] },
  });
  let seq = 0;
  stubs.placeMarketBuy.mockImplementation(async () => ({ ok: true, order_id: `cu-order-${++seq}` }));
  stubs.pollOrder.mockResolvedValue({ ok: true, order: { status: "OPEN" } });
  stubs.placeWithdraw.mockResolvedValue({ ok: false, status: 0, error: "stub" });
  stubs.pollWithdraw.mockResolvedValue({ ok: false, status: 0, error: "stub" });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-3 leg 2 — THE PERMITTING CONTROL for the route. A suite that only proves
// refusals passes an implementation that never buys anything at all.
// ─────────────────────────────────────────────────────────────────────────────
describe("K-3 leg 2 · the catch-up actually BUYS, and claims exactly what it bought", () => {
  it("under all caps: one order, exactly those rows claimed, nothing left over", async () => {
    reset();
    seedMissed(4);
    const before = unclaimed().map((r) => r.id);

    const r = await catchUp(4, 400);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, intervals: 4, usd: 400, remainder_intervals: 0 });
    expect(stubs.placeMarketBuy).toHaveBeenCalledTimes(1);
    expect(stubs.placeMarketBuy.mock.calls[0][1]).toBe(400);

    const placed = buysPlaced();
    expect(placed).toHaveLength(1);
    expect(placed[0].intended_buy_usd).toBe(400);

    // Claimed by the run that bought them — not merely deleted or flipped.
    const claims = db.prepare(
      `SELECT id, claimed_by_run_id FROM autobuy_runs WHERE status = 'skipped_missed_interval'`,
    ).all() as Array<{ id: number; claimed_by_run_id: number | null }>;
    expect(claims.map((c) => c.id).sort()).toEqual(before.sort());
    expect(claims.every((c) => c.claimed_by_run_id === placed[0].id)).toBe(true);
    expect(unclaimed()).toHaveLength(0);
  });

  it("a second catch-up with nothing left to claim refuses and places nothing", async () => {
    reset();
    seedMissed(2);
    expect((await catchUp(2, 200)).status).toBe(200);

    const again = await catchUp(2, 200);
    expect(again.status).toBe(400);
    expect(again.body?.error).toBe("nothing_to_claim");
    expect(stubs.placeMarketBuy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-4 — the caps. This leg has been INVERTED TWICE in one day by D4 then D5;
// each leg states which decision it encodes.
// ─────────────────────────────────────────────────────────────────────────────
describe("K-4 · the caps, as D4 and D5 left them", () => {
  it("leg 1 (D4) · the SINGLE-BUY cap does NOT bind: 11 x $100 places $1,100 over a $1,000 cap", async () => {
    reset();
    seedMissed(11);

    const r = await catchUp(11, 1100);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, intervals: 11, usd: 1100 });
    expect(stubs.placeMarketBuy.mock.calls[0][1]).toBe(1100);
    expect(unclaimed()).toHaveLength(0);
  });

  it("leg 2a (D5) · a rolling bind places the FITTING portion — 10 of 11, $1,000", async () => {
    reset();
    seedMissed(11);
    seedFilledSpend(1000); // 7d cap 2000, so $1,000 of headroom remains

    const r = await catchUp(10, 1000);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, intervals: 10, usd: 1000, remainder_intervals: 1 });
    expect(stubs.placeMarketBuy.mock.calls[0][1]).toBe(1000);
  });

  it("leg 2b (D5) · THE ONE THAT MATTERS — the remainder is STILL CLAIMABLE afterwards", async () => {
    reset();
    seedMissed(11);
    seedFilledSpend(1000);
    const oldest = unclaimed()[0].id;

    expect((await catchUp(10, 1000)).status).toBe(200);

    // Proving only the placement above would pass PARTIAL-AND-DROP, the
    // rejected alternative. The eleventh row must survive, unclaimed.
    const left = unclaimed();
    expect(left).toHaveLength(1);
    expect(left[0].id).not.toBe(oldest); // the OLDEST ten were the ones claimed

    // …and once the window frees up, a second claim places it.
    db.prepare(`DELETE FROM autobuy_runs WHERE status = 'buy_filled'`).run();
    const second = await catchUp(1, 100);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, intervals: 1, usd: 100 });
    expect(unclaimed()).toHaveLength(0);
    expect(stubs.placeMarketBuy).toHaveBeenCalledTimes(2);
  });

  it("leg 3 (D5) · k = 0 · $50 of headroom against a $100 unit refuses, claims nothing", async () => {
    reset();
    seedMissed(11);
    seedFilledSpend(1950); // 7d headroom = $50, below one interval

    const r = await catchUp(11, 1100);

    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("rolling_cap_no_headroom");
    expect(stubs.placeMarketBuy).not.toHaveBeenCalled();
    expect(unclaimed()).toHaveLength(11);
  });

  it("leg 4 (D4 §8) · THE REFUSING CONTROL — the AUTOMATED tick still obeys the single-buy cap", async () => {
    // The exemption must be scoped to the catch-up ROUTE. If someone removed
    // checkSingleBuyCap outright, every leg above would still be green and only
    // this one would go red. That asymmetry is the entire point of this leg.
    reset({ base_unit_usd: 1500, next_run_at: NOW - WEEK });
    await runTick(db);

    const capHits = db.prepare(
      `SELECT error_code FROM autobuy_runs WHERE status = 'skipped_cap_hit'`,
    ).all() as Array<{ error_code: string }>;
    expect(capHits).toHaveLength(1);
    expect(capHits[0].error_code).toMatch(/^single_buy_cap:/);
    expect(buysPlaced()).toHaveLength(0);
    expect(stubs.placeMarketBuy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-5 — the world moved between display and confirm (§4 A5).
// ─────────────────────────────────────────────────────────────────────────────
describe("K-5 · the member confirmed a NUMBER, not a procedure", () => {
  it("a zone flip between display and confirm -> 409, nothing placed; the re-derived amount then places", async () => {
    reset();
    seedMissed(11);

    // Displayed at 1x fair_value: 11 x $100 = $1,100. Now the zone flips to
    // elevated (0.5x) and the same confirmation describes a stale amount.
    stubs.getCurrent.mockResolvedValue({
      ok: true,
      value: { z_score: 1.2, zone: "elevated", updated_at: new Date().toISOString() },
    });

    const stale = await catchUp(11, 1100);
    expect(stale.status).toBe(409);
    expect(stale.body?.error).toBe("catch_up_amount_changed");
    expect(stale.body?.actual).toEqual({ intervals: 11, usd: 550 });
    expect(stubs.placeMarketBuy).not.toHaveBeenCalled();
    expect(unclaimed()).toHaveLength(11);

    // Confirming the re-derived figure places.
    const fresh = await catchUp(11, 550);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ ok: true, intervals: 11, usd: 550 });
    expect(stubs.placeMarketBuy.mock.calls[0][1]).toBe(550);
  });

  it("the CONFIRMATION gate is in front of this route: no header -> 400 confirmation_required", async () => {
    reset();
    seedMissed(2);

    const r = await call("POST", "/api/autobuy/catch-up", { expected_intervals: 2, expected_usd: 200 });
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("confirmation_required");
    expect(stubs.placeMarketBuy).not.toHaveBeenCalled();
  });

  it("a confirmation valid for OTHER figures -> 409 confirmation_mismatch, nothing placed", async () => {
    reset();
    seedMissed(11);

    const r = await call("POST", "/api/autobuy/catch-up", { expected_intervals: 11, expected_usd: 1100 }, {
      [CONFIRMATION_HEADER]: sha("expected_intervals=1&expected_usd=100"),
    });
    expect(r.status).toBe(409);
    expect(r.body?.error).toBe("confirmation_mismatch");
    expect(stubs.placeMarketBuy).not.toHaveBeenCalled();
    expect(unclaimed()).toHaveLength(11);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR WIRE ADDITIONS — each must reach its consumer AS A FIELD.
//
// Every one of these numbers used to exist only inside `reason`. A UI rendering
// them would have had to parse that string, which breaks silently the day the
// text is edited — the defect these fields exist to remove. So each assertion
// reads a TYPED FIELD and, where it matters, asserts the string is NOT the
// source. `reason` is deliberately still present: it is the log line and the
// generic frame's payload.
// ─────────────────────────────────────────────────────────────────────────────
describe("wire additions · the member-facing numbers are fields, not substrings", () => {
  it("rolling_cap_no_headroom carries `cap` with the binding window, its cap, headroom and unit", async () => {
    reset();
    seedMissed(11);
    seedFilledSpend(1950); // 7d cap 2000 -> $50 headroom, below one $100 interval

    const r = await catchUp(11, 1100);

    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("rolling_cap_no_headroom");
    // The field, typed and whole — not a number scraped out of `reason`.
    expect(r.body?.cap).toEqual({
      window: "7d",
      cap_usd: 2000,
      headroom_usd: 50,
      unit_usd: 100,
    });
    // `cap_usd` is the one value that was on NO wire at 254f96e — `reason`
    // carried headroom and unit only. If this ever comes back as undefined the
    // copy that interpolates it silently renders "undefined".
    expect(typeof r.body?.cap?.cap_usd).toBe("number");
    expect(r.body?.reason).not.toContain("2000");
  });

  it("insufficient_funds carries `funds`, and a NOT-CONSIDERED balance is null, never 0", async () => {
    reset({ currency_preference: "usd_only" });
    seedMissed(2);
    // USD account absent entirely, USDC flush — under usd_only the USDC balance
    // must not appear as a number the copy could claim covers the buy.
    stubs.listAccounts.mockResolvedValue({
      ok: true,
      data: { accounts: [{ currency: "USDC", available_balance: { value: "9999" } }] },
    });

    const r = await catchUp(2, 200);

    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("insufficient_funds");
    expect(r.body?.funds).toEqual({
      needed_usd: 200,
      considered: ["USD"],
      usd_balance: 0,
      usdc_balance: null,
    });
    // The discrimination that matters: "not considered" is null and an empty
    // account is 0, and the two are different facts.
    expect(r.body?.funds?.usdc_balance).toBeNull();
    expect(r.body?.funds?.usd_balance).toBe(0);
  });

  it("insufficient_funds under a *_preferred preference reports BOTH as considered — neither covered it", async () => {
    reset({ currency_preference: "usdc_preferred" });
    seedMissed(10); // $1,000 total
    // 600 + 600: each is short on its own, the SUM is not. selectCurrency has
    // no split-fill, so the honest claim is "neither", and the fields have to
    // let the copy say that rather than imply a shortfall of 400.
    stubs.listAccounts.mockResolvedValue({
      ok: true,
      data: {
        accounts: [
          { currency: "USD", available_balance: { value: "600" } },
          { currency: "USDC", available_balance: { value: "600" } },
        ],
      },
    });

    const r = await catchUp(10, 1000);

    expect(r.body?.error).toBe("insufficient_funds");
    expect(r.body?.funds?.considered).toEqual(["USD", "USDC"]);
    expect(r.body?.funds?.usd_balance).toBe(600);
    expect(r.body?.funds?.usdc_balance).toBe(600);
    expect(r.body?.funds?.needed_usd).toBe(1000);
  });

  it("valuation_stale carries `staleness` with THIS NODE'S threshold, not a hardcoded 48", async () => {
    reset();
    seedMissed(2);
    stubs.getCurrent.mockResolvedValue({
      ok: true,
      value: {
        z_score: -0.4,
        zone: "fair_value",
        updated_at: new Date(Date.now() - 100 * 3600 * 1000).toISOString(),
      },
    });

    const r = await catchUp(2, 200);

    expect(r.body?.error).toBe("valuation_stale");
    expect(r.body?.staleness?.threshold_hours).toBe(48); // AUTOBUY_STALE_DATA_MAX_HOURS in this fixture
    expect(r.body?.staleness?.age_hours).toBeGreaterThan(99);
    expect(typeof r.body?.staleness?.threshold_hours).toBe("number");
  });

  it("…and `staleness` is ABSENT on invalid_updated_at — the absence is the discriminator", async () => {
    // Same refusal CODE, different fault, no age to report. A UI that rendered
    // "more than {threshold} hours old" here would be describing a fault that
    // has no threshold. The field's absence routes it to the generic frame
    // without anyone having to remember a rule.
    reset();
    seedMissed(2);
    stubs.getCurrent.mockResolvedValue({
      ok: true,
      value: { z_score: -0.4, zone: "fair_value", updated_at: "not-a-timestamp" },
    });

    const r = await catchUp(2, 200);

    expect(r.body?.error).toBe("valuation_stale");
    expect(r.body?.reason).toBe("invalid_updated_at");
    expect(r.body?.staleness).toBeUndefined();
  });

  it("status `missed.remainder` carries binding_window — nested, so it cannot exist when nothing bound", async () => {
    reset();
    seedMissed(11);
    seedFilledSpend(1000); // 7d headroom $1,000 -> 10 fit, 1 withheld

    const r = await call("GET", "/api/autobuy/status", undefined);

    expect(r.status).toBe(200);
    expect(r.body?.missed?.fits_now).toEqual({ intervals: 10, estimated_usd: 1000 });
    expect(r.body?.missed?.remainder).toEqual({
      intervals: 1,
      estimated_usd: 100,
      binding_window: "7d",
    });
  });

  it("…and when nothing binds there is NO remainder, hence no binding window to assert", async () => {
    reset();
    seedMissed(3); // $300 against clear headroom

    const r = await call("GET", "/api/autobuy/status", undefined);

    expect(r.body?.missed?.remainder).toBeNull();
    expect(r.body?.missed?.fits_now).toEqual({ intervals: 3, estimated_usd: 300 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A THROWN SUMMARY IS NOT "NOTHING MISSED".
// ─────────────────────────────────────────────────────────────────────────────
describe("status · a computeMissedSummary failure is distinguishable from an empty set", () => {
  it("a throw sets missed_error and leaves missed null", async () => {
    reset();
    seedMissed(4);
    stubs.getCurrent.mockRejectedValue(new Error("valuation client exploded"));

    const r = await call("GET", "/api/autobuy/status", undefined);

    expect(r.status).toBe(200);
    expect(r.body?.missed).toBeNull();
    expect(r.body?.missed_error).toContain("valuation client exploded");
  });

  it("genuinely nothing missed leaves BOTH null — the two states differ on the wire", async () => {
    reset(); // no seedMissed

    const r = await call("GET", "/api/autobuy/status", undefined);

    expect(r.body?.missed).toBeNull();
    expect(r.body?.missed_error).toBeNull();
  });
});
