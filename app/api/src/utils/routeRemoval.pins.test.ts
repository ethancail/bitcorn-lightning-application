// REMOVAL PINS — the dormant money paths deleted by
// bitcorn-research/decisions/2026-10-13-dormant-money-paths-dispositions-d1-d4.md
//
// WHAT A DELETED POST LOOKS LIKE FROM OUTSIDE. handleRequest classifies every
// mutation against action-confirmation.ts BEFORE dispatch, and refuses one that
// matches neither table (default-require). So once a route's handler AND its
// table entry are gone, a POST to it never reaches the 404 fallthrough: it gets
// the exact "is not classified" refusal pinned below. That body is distinct
// from the refusal a still-classified route gives without a confirmation
// ("send x-bitcorn-confirm: …"), which is what made each pin red before its
// deletion.
//
// This pin proves the TABLE ENTRY is gone. That the HANDLER is gone is proven
// by action-confirmation.coverage.test.ts, whose AST walk of the dispatch chain
// fails if a mutation handler exists with no table entry. Both halves are
// needed: a handler re-added without its entry would leave this pin green.
//
// GETs skip the gate, so a deleted GET does reach the fallthrough: 404, empty
// body (index.ts's last line of dispatch).
//
// ANTI-VACUITY. Each describe also posts to one LIVE treasury route with no
// confirmation and asserts it is NOT refused as unclassified — so the pins are
// not satisfied by a gate that refuses everything — and that nothing reached
// LND (ln-service) or loopd (lightning/loop.ts), both mocked here.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ln-service");
vi.mock("../lightning/loop");

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-removal-pins-"));
process.env.DB_DIR = TMP_DB;

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let egress: Array<[string, Record<string, unknown>]>;

beforeAll(async () => {
  ({ handleRequest } = await import("../index"));
  egress = [
    ["ln-service", (await import("ln-service")) as Record<string, unknown>],
    ["lightning/loop", (await import("../lightning/loop")) as Record<string, unknown>],
  ];
});

beforeEach(() => vi.clearAllMocks());

/** Every call made to a mocked LND/loopd export since the last clear. */
function egressCalls(): string[] {
  const calls: string[] = [];
  for (const [mod, exports] of egress) {
    for (const [name, fn] of Object.entries(exports)) {
      if (vi.isMockFunction(fn) && fn.mock.calls.length > 0) calls.push(`${mod}.${name}`);
    }
  }
  return calls;
}

type Captured = { status: number; raw: string };

/** Drive handleRequest with a synthetic request; resolve once the response ends. */
function call(method: string, url: string, body?: unknown): Promise<Captured> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { "content-type": "application/json" };
  (req as any).socket = { remoteAddress: "127.0.0.1" };

  return new Promise((resolve) => {
    let status = 0;
    let chunks = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve({ status, raw: chunks });
      }
    };
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(s: number) {
        status = s;
        return res;
      },
      end(c?: any) {
        if (c) chunks += c.toString();
        finish();
      },
      write(c: any) {
        if (c) chunks += c.toString();
        return true;
      },
    } as unknown as http.ServerResponse;

    void handleRequest(req, res);
    setImmediate(() => (req as unknown as PassThrough).end(raw));
    setTimeout(() => {
      if (!done) {
        status = -1; // nothing responded — must never read as a pass
        finish();
      }
    }, 4000);
  });
}

/** A live, confirmed treasury route, sent with no confirmation hash. */
async function expectLiveRouteStillClassified() {
  const url = "/api/treasury/rebalance/loop-out";
  const r = await call("POST", url, { channel_id: "842391119757312", amount_sats: 500000 });
  expect(r.status).toBe(400);
  expect(r.raw).not.toBe(
    `{"error":"confirmation_required","detail":"POST ${url} is not classified in action-confirmation.ts; refusing rather than guessing"}`
  );
  expect(JSON.parse(r.raw).detail).toMatch(/^send x-bitcorn-confirm: sha256 of /);
  expect(egressCalls()).toEqual([]);
}

describe("egress mocks are in place (else 'no egress call' would prove nothing)", () => {
  it("ln-service and lightning/loop exports are mock functions", () => {
    for (const [mod, exports] of egress) {
      const fns = Object.values(exports).filter((v) => typeof v === "function");
      expect(fns.length, `${mod} exported no functions`).toBeGreaterThan(0);
      for (const fn of fns) expect(vi.isMockFunction(fn), mod).toBe(true);
    }
  });
});

describe("D2: the treasury keysend push routes are gone", () => {
  it("POST …/recommendations/1/approve is refused as unclassified", async () => {
    const r = await call("POST", "/api/member-liquidity/recommendations/1/approve", {});
    expect(r.status).toBe(400);
    expect(r.raw).toBe(
      '{"error":"confirmation_required","detail":"POST /api/member-liquidity/recommendations/1/approve is not classified in action-confirmation.ts; refusing rather than guessing"}'
    );
    expect(egressCalls()).toEqual([]);
  });

  it("GET /api/member-liquidity/recommendations reaches the 404 fallthrough", async () => {
    const r = await call("GET", "/api/member-liquidity/recommendations");
    expect(r.status).toBe(404);
    expect(r.raw).toBe("");
    expect(egressCalls()).toEqual([]);
  });

  it("anti-vacuity: a live treasury route is still classified, and reaches no egress", async () => {
    await expectLiveRouteStillClassified();
  });
});

describe("D1: the circular rebalance route is gone", () => {
  it("POST /api/treasury/rebalance/circular is refused as unclassified", async () => {
    const r = await call("POST", "/api/treasury/rebalance/circular", {
      outgoing_channel: "842391119757312",
      incoming_channel: "901234567890123",
      tokens: 250000,
    });
    expect(r.status).toBe(400);
    expect(r.raw).toBe(
      '{"error":"confirmation_required","detail":"POST /api/treasury/rebalance/circular is not classified in action-confirmation.ts; refusing rather than guessing"}'
    );
    expect(egressCalls()).toEqual([]);
  });

  it("anti-vacuity: a live treasury route is still classified, and reaches no egress", async () => {
    await expectLiveRouteStillClassified();
  });
});
