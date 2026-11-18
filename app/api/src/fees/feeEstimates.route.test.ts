// fee-estimates — GET /api/fee-estimates through the real handleRequest (spec
// §4 P22, §16 done-when 2). Faked at their module boundaries: the Worker call
// (workerFetch) and LND's curve (getLndChainFeeRate). Expectations come from
// the stubs through toSendableRate, never from literals.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-fee-estimates-route-"));
process.env.DB_DIR = TMP;
process.env.BITCOIN_NETWORK = "mainnet";

const m = vi.hoisted(() => ({
  workerCalls: [] as Array<{ path: string; hasSignal: boolean }>,
  workerBody: null as unknown,
  workerHeader: "live",
  workerThrows: false,
  lndTargets: [] as number[],
  lndFigure: (t: number) => t + 0.3 as number,
}));

vi.mock("../lib/workerFetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/workerFetch")>();
  return {
    ...actual,
    workerFetch: async (p: string, opts: RequestInit = {}) => {
      m.workerCalls.push({ path: p, hasSignal: !!opts.signal });
      if (m.workerThrows) throw new actual.WorkerFetchError("down", "transport_error");
      return new Response(JSON.stringify(m.workerBody), {
        status: 200,
        headers: { "X-Fee-Source": m.workerHeader },
      });
    },
  };
});

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndChainFeeRate: async (t: number) => {
      m.lndTargets.push(t);
      return { tokens_per_vbyte: m.lndFigure(t) };
    },
  };
});

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let toSendableRate: (x: number) => number;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("../index"));
  ({ toSendableRate } = await import("./feeEstimates"));
});

beforeEach(() => {
  m.workerCalls = [];
  m.workerBody = null;
  m.workerHeader = "live";
  m.workerThrows = false;
  m.lndTargets = [];
  m.lndFigure = (t: number) => t + 0.3;
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
      writeHead(s: number) { status = s; return res; },
      write(c: any) { if (c) chunks += c.toString(); return true; },
      end(c?: any) {
        if (c) chunks += c.toString();
        resolve({ status, body: chunks ? JSON.parse(chunks) : null });
      },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    (req as unknown as PassThrough).end();
  });
}

describe("GET /api/fee-estimates", () => {
  it("serves the Worker's projected blocks: source, header, age and three integer rates", async () => {
    const medians = [12.7, 11, 9.02, 8, 7, 3.3];
    m.workerBody = { fetched_at: new Date(Date.now() - 120_000).toISOString(), blocks: medians.map((x) => ({ medianFee: x })) };
    const { status, body } = await get("/api/fee-estimates");

    expect(status).toBe(200);
    expect(m.workerCalls).toEqual([{ path: "/fees", hasSignal: true }]);
    expect(m.lndTargets).toEqual([]);
    expect(body.source).toBe("worker");
    expect(body.worker_source).toBe("live");
    expect(body.data_age_seconds).toBeGreaterThanOrEqual(119);
    expect(body.data_age_seconds).toBeLessThan(130);
    expect(body.options.priority.rate).toBe(toSendableRate(medians[0]));
    expect(body.options.normal.rate).toBe(toSendableRate(medians[2]));
    expect(body.options.economy.rate).toBe(toSendableRate(medians[5]));
    for (const k of ["priority", "normal", "economy"]) expect(Number.isInteger(body.options[k].rate)).toBe(true);
    expect(body.sizes_vb).toEqual({ open: 155, close: 192 });
    expect(body.ceiling_sat_per_vbyte).toBe(200);
  });

  it("falls back to LND's curve at 2/3/6 when the Worker is unreachable", async () => {
    m.workerThrows = true;
    const { status, body } = await get("/api/fee-estimates");

    expect(status).toBe(200);
    expect([...m.lndTargets].sort()).toEqual([2, 3, 6]);
    expect(body.source).toBe("lnd");
    expect(body.worker_source).toBeNull();
    expect(body.options.priority).toMatchObject({ rate: toSendableRate(2.3), estimate: true, target: 2 });
    expect(body.options.economy).toMatchObject({ rate: toSendableRate(6.3), estimate: true, target: 6 });
  });

  it("is unavailable, with no figure, when the Worker is stale and LND is flat at 25", async () => {
    m.workerBody = { fetched_at: new Date(Date.now() - 31 * 60_000).toISOString(), blocks: [{ medianFee: 4 }] };
    m.workerHeader = "fallback";
    m.lndFigure = () => 25;
    const { status, body } = await get("/api/fee-estimates");

    expect(status).toBe(200);
    expect(body.source).toBe("unavailable");
    expect(body.worker_source).toBe("fallback");
    expect(body.options).toBeNull();
  });
});
