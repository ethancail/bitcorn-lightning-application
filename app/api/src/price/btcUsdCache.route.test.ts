// Drive-mode P1 item 3 (spec P1 item 3, §3.2, §3.3; D1.4; R15(6), R18(9)):
// one cached, timestamped BTC/USD rate —
//   - GET /api/exchange-rate answers from the cache with its age and state:
//     fresh up to 10 minutes, stale after, none after 6 hours or with no rate;
//     always 200, never a 502 (R18(9));
//   - a member payment no longer waits on Coinbase before paying;
//   - a payment's per-record USD amount is stored only when the rate is fresh.
//
// Only Date is faked (the clock); timers and promises stay real. Coinbase is a
// stubbed global fetch whose mode the test sets: ok, fail or hang.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-rate-cache-route-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;

const coinbase = vi.hoisted(() => ({ mode: "ok" as "ok" | "fail" | "hang", calls: 0 }));
vi.stubGlobal("fetch", vi.fn(async () => {
  coinbase.calls++;
  if (coinbase.mode === "hang") return new Promise<never>(() => {});
  if (coinbase.mode === "fail") throw new Error("coinbase down");
  return { ok: true, status: 200, json: async () => ({ data: { amount: "60000.00" } }) } as any;
}));

const ln = vi.hoisted(() => ({ n: 0 }));
vi.mock("ln-service", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    decodePaymentRequest: vi.fn(async () => ({
      id: (++ln.n).toString(16).padStart(64, "0"), destination: "03" + "cd".repeat(32), tokens: 1_000, description: "t",
    })),
    payViaPaymentRequest: vi.fn(async () => ({ id: "x", tokens: 1_000, fee: 0, confirmed_at: "" })),
  };
});
vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return { ...actual, getLndClient: () => ({ lnd: {} }) };
});
vi.mock("../subscription/tier2Gate", () => ({ assertTier2RoutingAllowed: () => {} }));

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { payNetworkInvoice } = await import("../lightning/network-payments");

const T0 = new Date("2026-11-03T12:00:00Z").getTime();
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

async function rate(): Promise<{ status: number | null; body: any }> {
  let status: number | null = null;
  let body = "";
  const res: any = { setHeader() {}, writeHead(s: number) { status = s; return res; }, end(c?: string) { if (c) body += c; return res; } };
  await handleRequest({ method: "GET", url: "/api/exchange-rate", headers: {} } as any, res);
  return { status, body: JSON.parse(body) };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  // A non-hub channel with room, so the pay pre-check passes.
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at)
    VALUES ('500x1x0', ?, 1000000, 900000, 90000, 1, 0, ?)
  `).run("03" + "cd".repeat(32), T0);
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

async function lastPaymentUsd(): Promise<number | null> {
  return (db.prepare("SELECT amount_usd FROM network_payments ORDER BY id DESC LIMIT 1").get() as any).amount_usd;
}

describe("D1.4 — the rate's age and state, at the route", () => {
  it("warm-up: the cache gets one successful Coinbase read", async () => {
    coinbase.mode = "ok";
    await rate();
    await flush();
  });

  it("fresh: with Coinbase now failing, the route still answers 200 from the cache", async () => {
    coinbase.mode = "fail";
    const r = await rate();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usd: 60000, state: "fresh", fetched_at: T0 });
  });

  it("a payment while fresh stores its USD amount", async () => {
    await payNetworkInvoice("lnbcrt1test");
    expect(await lastPaymentUsd()).toBe(0.6); // 1,000 sats at $60,000
  });

  it("stale at 10 minutes + 1 second: dollars kept, age reported", async () => {
    vi.setSystemTime(T0 + 10 * 60_000 + 1_000);
    const r = await rate();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usd: 60000, state: "stale", fetched_at: T0, age_ms: 601_000 });
    await flush();
  });

  it("a payment while stale stores no USD amount (R18(9))", async () => {
    await payNetworkInvoice("lnbcrt1test");
    expect(await lastPaymentUsd()).toBeNull();
  });

  it("none at 6 hours + 1 second: no dollars, still 200 (R18(9))", async () => {
    vi.setSystemTime(T0 + 6 * 3_600_000 + 1_000);
    const r = await rate();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usd: null, state: "none" });
    await flush();
  });
});

describe("a member payment does not wait on Coinbase", () => {
  it("with Coinbase hanging, payNetworkInvoice still completes", async () => {
    coinbase.mode = "hang";
    const done = payNetworkInvoice("lnbcrt1test").then(() => "paid");
    const timeout = new Promise((r) => setTimeout(() => r("waited on Coinbase"), 1_000));
    expect(await Promise.race([done, timeout])).toBe("paid");
  });
});
