// POST /api/profile/acknowledge-price-change, through handleRequest
// (pay-from-node spec §4.1, §6 Q6; ruling C, 2026-11-05). The route takes the
// price the member was SHOWN, records it only if it is still the current
// price, and never lowers the stored ceiling. Exempt from confirmation
// ("local flag"); the checks are body validation in the handler.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-ack-price-test-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const h = vi.hoisted(() => ({ price: 50_000 as number }));

// The cap is not under test here (treasury-price-trust's controls test it);
// its shipped value is owed, so inject one that bounds nothing these tests
// acknowledge. Not a proposal for SUBSCRIPTION_PRICE_CAP_SATS.
vi.mock("./subscription/priceCap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subscription/priceCap")>()),
  SUBSCRIPTION_PRICE_CAP_SATS: Number.MAX_SAFE_INTEGER,
}));

vi.mock("./subscription/memberStatusClient", () => ({
  fetchLocalSubscriptionStatus: async () => ({
    ok: true,
    status: { applicable: true, current_tier: "current", price_sats: h.price, deposit_address: "bcrt1qx" },
  }),
}));

const PUB = "02ackmember";
const URL = "/api/profile/acknowledge-price-change";

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let db: import("better-sqlite3").Database;
let profile: typeof import("./profile/profileStore");

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("./index"));
  const { runMigrations } = await import("./db/migrate");
  runMigrations();
  ({ db } = await import("./db"));
  profile = await import("./profile/profileStore");
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info (id, pubkey, network, node_role, updated_at)
     VALUES (1, ?, 'regtest', 'member', 0)`,
  ).run(PUB);
});

beforeEach(() => {
  db.prepare("DELETE FROM member_profile").run();
  h.price = 50_000;
  profile.acknowledgePrice(PUB, 40_000, 1);
});

function stored(): number | null {
  return profile.getMemberProfile(PUB)?.last_acknowledged_price ?? null;
}

function post(rawBody: string): Promise<{ status: number; body: any }> {
  const stream = new PassThrough();
  const req = stream as unknown as http.IncomingMessage;
  (req as any).method = "POST";
  (req as any).url = URL;
  (req as any).headers = { "content-type": "application/json" };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let status = 0;
    let chunks = "";
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(s: number) { status = s; return res; },
      end(c?: any) {
        if (c) chunks += c.toString();
        let body: any = null;
        try { body = chunks ? JSON.parse(chunks) : null; } catch { body = chunks; }
        resolve({ status, body });
      },
      write(c: any) { if (c) chunks += c.toString(); return true; },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => stream.end(rawBody));
  });
}

describe("C11 — the shown price must be the current price", () => {
  it("a mismatch → 409 acknowledged_price_mismatch, and nothing is recorded", async () => {
    const r = await post(JSON.stringify({ price_sats: 45_000 }));
    expect(r.status).toBe(409);
    expect(r.body?.error).toBe("acknowledged_price_mismatch");
    expect(stored()).toBe(40_000);
  });

  it("permitting control: the current price → 200, and it is recorded", async () => {
    const r = await post(JSON.stringify({ price_sats: 50_000 }));
    expect(r.status).toBe(200);
    expect(r.body?.acknowledged_price).toBe(50_000);
    expect(stored()).toBe(50_000);
  });
});

describe("C12 — the body must carry a finite positive price", () => {
  for (const [label, raw] of [
    ["no body", ""],
    ["no price_sats", "{}"],
    ["a string", JSON.stringify({ price_sats: "50000" })],
    ["zero", JSON.stringify({ price_sats: 0 })],
    ["not JSON", "price=50000"],
  ] as const) {
    it(`${label} → 400 invalid_request, nothing recorded`, async () => {
      const r = await post(raw);
      expect(r.status).toBe(400);
      expect(r.body?.error).toBe("invalid_request");
      expect(stored()).toBe(40_000);
    });
  }
});

describe("ruling C — the route never lowers the ceiling", () => {
  it("the price fell below the stored one: acknowledging it → 200, the stored price stays", async () => {
    profile.acknowledgePrice(PUB, 60_000, 1);
    const r = await post(JSON.stringify({ price_sats: 50_000 }));
    expect(r.status).toBe(200);
    expect(stored()).toBe(60_000);
  });
});
