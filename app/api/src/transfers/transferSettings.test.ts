// Drive-mode P3, item 1: the automatic-transfer settings.
//   D3.1 — a fresh node gets R15(2)/R15(3)'s defaults and R16(2)'s floors, the
//          day boundary is US Central (R16(4)), and saved values survive a
//          restart.
//   NULL = default — only values the member saves are stored; null resets.
//   Validation — each bad field is a 400 and nothing is written.
//   R40(4) — PATCH is EXEMPT from action-confirmation and reaches the handler.
//
// Harness: real migrations on a temp-dir DB, driven through handleRequest.

import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-transfer-settings-"));
process.env.DB_DIR = TMP_DB;

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { classifyMutation } = await import("../utils/action-confirmation");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

beforeEach(() => {
  db.prepare("DELETE FROM member_transfer_settings").run();
});

async function call(method: "GET" | "PATCH", body?: unknown): Promise<{ status: number; json: any }> {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = "/api/transfers/settings";
  req.headers = { "content-type": "application/json" };
  let status = 0;
  let out = "";
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const res: any = {
    setHeader() {},
    writeHead(s: number) { status = s; return res; },
    end(c?: string) { if (c) out += c; done(); return res; },
  };
  const handled = handleRequest(req, res);
  if (method === "PATCH") {
    await new Promise((r) => setImmediate(r));
    req.emit("data", Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)));
    req.emit("end");
  }
  await handled;
  await finished;
  return { status, json: JSON.parse(out) };
}

const storedRow = () => db.prepare("SELECT * FROM member_transfer_settings").all();

describe("D3.1 — defaults, floors and the day boundary on a fresh node", () => {
  it("defaults: Save on fees; 2% or $3; $10 a day in fees; $500 moved a day", async () => {
    const { status, json } = await call("GET");
    expect(status).toBe(200);
    expect(json.settings).toEqual({
      strategy: "save",
      fee_limit_pct_bps: 200,
      fee_limit_usd_cents: 300,
      daily_fee_budget_usd_cents: 1_000,
      max_moved_per_day_usd_cents: 50_000,
    });
    expect(json.defaults).toEqual(json.settings);
  });

  it("floors: farmer $70 / $140, merchant $200 / $400 (R16(2))", async () => {
    const { json } = await call("GET");
    expect(json.floors_usd_cents).toEqual({ farmer: { save: 7_000, open: 14_000 }, merchant: { save: 20_000, open: 40_000 } });
  });

  it("the day boundary is US Central (R16(4))", async () => {
    expect((await call("GET")).json.day_boundary_tz).toBe("America/Chicago");
  });

  it("a fresh node stores nothing: every stored value is null, and there is no row", async () => {
    const { json } = await call("GET");
    expect(Object.values(json.stored).every((v) => v === null)).toBe(true);
    expect(storedRow()).toEqual([]);
  });
});

describe("saving", () => {
  it("PATCH stores only what was sent; the rest stays null and follows the default", async () => {
    const r = await call("PATCH", { strategy: "open", daily_fee_budget_usd_cents: 2_500 });
    expect(r.status).toBe(200);
    expect(r.json.settings.strategy).toBe("open");
    expect(r.json.settings.daily_fee_budget_usd_cents).toBe(2_500);
    expect(r.json.settings.fee_limit_usd_cents).toBe(300);
    expect(r.json.stored.fee_limit_usd_cents).toBeNull();
    expect(r.json.stored.strategy).toBe("open");
  });

  it("null puts a value back to the default", async () => {
    await call("PATCH", { strategy: "manual" });
    const r = await call("PATCH", { strategy: null });
    expect(r.json.stored.strategy).toBeNull();
    expect(r.json.settings.strategy).toBe("save");
  });

  it("saved values survive a restart (a fresh module graph on the same DB)", async () => {
    await call("PATCH", { strategy: "manual", fee_limit_pct_bps: 150, max_moved_per_day_usd_cents: 20_000 });
    vi.resetModules();
    const again = await import("./transferSettings");
    expect(again.effectiveTransferSettings()).toMatchObject({ strategy: "manual", fee_limit_pct_bps: 150, max_moved_per_day_usd_cents: 20_000 });
  });
});

describe("validation — each bad field is a 400 and nothing is written", () => {
  const bad: Array<[string, unknown]> = [
    ["unknown strategy", { strategy: "fast" }],
    ["strategy not a string", { strategy: 1 }],
    ["fee percent zero", { fee_limit_pct_bps: 0 }],
    ["fee percent above the 15% swap fee ceiling", { fee_limit_pct_bps: 1_501 }],
    ["fee percent fractional", { fee_limit_pct_bps: 1.5 }],
    ["fee dollars negative", { fee_limit_usd_cents: -300 }],
    ["daily budget a string", { daily_fee_budget_usd_cents: "1000" }],
    ["daily max zero", { max_moved_per_day_usd_cents: 0 }],
    ["an unknown field", { enabled: true }],
    ["an empty object", {}],
    ["a good field beside a bad one", { strategy: "open", fee_limit_usd_cents: 0 }],
  ];
  for (const [why, body] of bad) {
    it(why, async () => {
      const r = await call("PATCH", body);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("invalid_transfer_settings");
      expect(storedRow()).toEqual([]);
    });
  }

  it("invalid JSON is a 400", async () => {
    const r = await call("PATCH", "{not json");
    expect(r.status).toBe(400);
    expect(storedRow()).toEqual([]);
  });

  it("the 15% boundary itself is accepted", async () => {
    expect((await call("PATCH", { fee_limit_pct_bps: 1_500 })).status).toBe(200);
  });
});

describe("R40(4) — the PATCH is exempt from action-confirmation", () => {
  it("classified exempt", () => {
    expect(classifyMutation("PATCH", "/api/transfers/settings")).toBe("exempt");
  });

  it("reaches the handler with no confirmation", async () => {
    const r = await call("PATCH", { strategy: "open" });
    expect(r.status).toBe(200);
    expect(r.json.error).toBeUndefined();
  });
});
