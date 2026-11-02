// D5 (loop-fee-ceilings spec §6, F4): the execute body echoes the quote's
// ceilings and the confirmation hash covers them, on A (member Loop Out),
// B (admin Loop Out) and D (member Loop In). A ceiling altered in the body
// is refused by the confirmation check.
//
// Driven through the real handleRequest and the real confirmation gate, the
// action-confirmation.route.test.ts harness. Requests that PASS the gate fail
// downstream (no node here); what is asserted is only the gate's answer.
//
// The canonical string walks each route's declared field order (see
// CANONICAL FORM in utils/action-confirmation.ts), so it is written out here
// by hand: deriving it with the code under test would prove nothing.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, describe, expect, it } from "vitest";
import { CONFIRMATION_HEADER } from "../utils/action-confirmation";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-ceilings-confirm-test-"));

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

beforeAll(async () => {
  ({ handleRequest } = await import("../index"));
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
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let parsed: any = null;
      try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = null; }
      resolve({ status, body: parsed });
    };
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(st: number) { status = st; return res; },
      write(c: any) { if (c) chunks += c.toString(); return true; },
      end(c?: any) { if (c) chunks += c.toString(); finish(); },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => (req as unknown as PassThrough).end(JSON.stringify(body)));
    setTimeout(() => { if (!done) { status = -1; finish(); } }, 4000);
  });
}

const isConfirmError = (r: { body: any }) =>
  r.body?.error === "confirmation_required" || r.body?.error === "confirmation_mismatch";

const LO = {
  max_swap_fee_sat: 835,
  max_prepay_amt_sat: 30000,
  max_miner_fee_sat: 1200,
  max_swap_routing_fee_sat: 2500,
  max_prepay_routing_fee_sat: 300,
};
const LO_CANON =
  "max_swap_fee_sat=835&max_prepay_amt_sat=30000&max_miner_fee_sat=1200" +
  "&max_swap_routing_fee_sat=2500&max_prepay_routing_fee_sat=300";
const LI = { max_swap_fee_sat: 500, max_miner_fee_sat: 900 };
const LI_CANON = "max_swap_fee_sat=500&max_miner_fee_sat=900";

const cases = [
  {
    site: "A, member Loop Out",
    url: "/api/swaps/loop-out",
    body: { swap_request_id: "r1", destination_address: "bc1qdest", ...LO },
    canon: `swap_request_id=r1&destination_address=bc1qdest&${LO_CANON}`,
    alter: { max_prepay_amt_sat: 50000 },
    bare: { swap_request_id: "r1", destination_address: "bc1qdest" },
  },
  {
    site: "B, admin Loop Out",
    url: "/api/admin/swaps/loop-out",
    body: { swap_request_id: "r1", ...LO },
    canon: `swap_request_id=r1&${LO_CANON}`,
    alter: { max_swap_routing_fee_sat: 37500 },
    bare: { swap_request_id: "r1" },
  },
  {
    site: "D, member Loop In",
    url: "/api/swaps/loop-in",
    body: { swap_request_id: "r1", ...LI },
    canon: `swap_request_id=r1&${LI_CANON}`,
    alter: { max_miner_fee_sat: 20000 },
    bare: { swap_request_id: "r1" },
  },
];

describe.each(cases)("D5 ($site): the confirmation covers the echoed ceilings", (c) => {
  it("the confirmation over the full body passes the gate", async () => {
    const r = await post(c.url, c.body, { [CONFIRMATION_HEADER]: sha(c.canon) });
    expect(r.status).not.toBe(-1);
    expect(isConfirmError(r)).toBe(false);
  });

  it("a ceiling altered in the body, same confirmation → 409 confirmation_mismatch", async () => {
    // POSITIVE HALF FIRST: this header must be a working confirmation for the
    // unaltered body, or the 409 below would prove nothing about the ceiling
    // (a header that never matched 409s just as readily).
    const ok = await post(c.url, c.body, { [CONFIRMATION_HEADER]: sha(c.canon) });
    expect(isConfirmError(ok), "the header must clear the gate for the unaltered body").toBe(false);

    const r = await post(c.url, { ...c.body, ...c.alter }, { [CONFIRMATION_HEADER]: sha(c.canon) });
    expect(r.status).toBe(409);
    expect(r.body?.error).toBe("confirmation_mismatch");
  });

  it("a body without the ceilings → 400 confirmation_required", async () => {
    const r = await post(c.url, c.bare, { [CONFIRMATION_HEADER]: sha(c.canon) });
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("confirmation_required");
  });
});
