// C1, POST /api/treasury/rebalance/loop-out, at the ROUTE level
// (loop-fee-ceilings spec §4 C1–C3; D4 and D14). The body's ceiling overrides
// (max_swap_fee_sats, max_miner_fee_sats) and its conf_target are dropped:
// the route hands executeLoopOut the channel and the amount, nothing else.
//
// Driven through the real handleRequest, so the request passes the real
// confirmation gate (C1's hash is channel_id + amount_sats, unchanged). Only
// executeLoopOut is replaced, by a spy, so what is asserted is exactly what
// the route passes it. rebalance-loop.ceilings.test.ts is the function-level
// layer (D4b); a test here cannot be turned red by the rebalance-loop.ts
// fallback, and that one cannot be turned red by index.ts.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_HEADER } from "./utils/action-confirmation";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-c1-loop-out-test-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const spy = vi.hoisted(() => ({ executeLoopOut: vi.fn() }));

vi.mock("./utils/role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/role")>()),
  assertTreasury: () => {},
}));
vi.mock("./lightning/loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lightning/loop")>()),
  isLoopAvailable: async () => ({ available: true }),
}));
vi.mock("./lightning/rebalance-loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lightning/rebalance-loop")>()),
  executeLoopOut: spy.executeLoopOut,
}));

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("./index"));
  const { runMigrations } = await import("./db/migrate");
  runMigrations();
});

beforeEach(() => {
  spy.executeLoopOut.mockReset();
  spy.executeLoopOut.mockResolvedValue({ ok: true });
});

const sha = (v: string) => crypto.createHash("sha256").update(v, "utf8").digest("hex");

function post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = "POST";
  (req as any).url = url;
  (req as any).headers = { "content-type": "application/json", ...headers };
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
    setImmediate(() => (req as unknown as PassThrough).end(JSON.stringify(body)));
  });
}

const URL_C1 = "/api/treasury/rebalance/loop-out";

describe("C1 drops the body's ceiling overrides and conf_target", () => {
  it("D4 + D14: oversized ceilings and a body conf_target reach executeLoopOut as nothing", async () => {
    const r = await post(
      URL_C1,
      {
        channel_id: "111",
        amount_sats: 250_000,
        max_swap_fee_sats: 999_999,
        max_miner_fee_sats: 999_999,
        conf_target: 144,
      },
      { [CONFIRMATION_HEADER]: sha("channel_id=111&amount_sats=250000") },
    );
    expect(r.status).toBe(200);
    expect(spy.executeLoopOut).toHaveBeenCalledTimes(1);
    expect(spy.executeLoopOut.mock.calls[0][0]).toEqual({ channel_id: "111", amount_sats: 250_000 });
  });
});
