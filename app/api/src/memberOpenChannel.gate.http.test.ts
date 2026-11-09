// Membership-gating M1 — the member's app check on POST /api/member/open-channel.
//
// Spec: bitcorn-research specs/2026-11-05-membership-gating-spec.md §2 M1;
// done-whens DW6 and DW8; rulings R4 and pass 10 item A.
//
// Driven through the real exported handleRequest (confirmation gate included).
// Faked, at their module boundaries: the member's status fetch
// (memberStatusClient — it reaches the treasury over HTTP) and the two LND calls
// the route makes (connectToPeer, openTreasuryChannel). The funding call is the
// thing "before any funding step" is measured against: it is a spy, and a
// refusal is asserted by its call count.
//
// ⚠ THE REFUSAL ERROR IS THE REAL ln-service SHAPE, an array, not an Error:
// [503, 'FailedToOpenChannel', {err: <details>}] (lightning open_channel.js:284,
// Phase 1 Q4). The details string here is LND's funding-error form with R7's
// acceptor text inside it (acceptor record Q4/Q7, relayed; gate 1 confirms the
// exact bytes on Polar).

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_HEADER } from "./utils/action-confirmation";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-member-open-gate-"));
process.env.DB_DIR = TMP;
const TREASURY = "02" + "11".repeat(32);
process.env.TREASURY_PUBKEY = TREASURY;

const R7_ACCEPTOR_TEXT =
  "Opening a channel to the BitCorn hub requires a paid membership. Pay your membership in the BitCorn app on your node, then try again.";

const m = vi.hoisted(() => ({
  status: null as any,
  openCalls: 0,
  connectCalls: 0,
  openRejectsWith: null as unknown,
}));

vi.mock("./subscription/memberStatusClient", () => ({
  fetchLocalSubscriptionStatus: async () => m.status,
}));

vi.mock("./lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lightning/lnd")>();
  return {
    ...actual,
    connectToPeer: async () => {
      m.connectCalls++;
    },
    openTreasuryChannel: async () => {
      m.openCalls++;
      if (m.openRejectsWith !== null) throw m.openRejectsWith;
      return { transaction_id: "ab".repeat(32), transaction_vout: 0 };
    },
  };
});

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("./index"));
});

beforeEach(() => {
  m.status = null;
  m.openCalls = 0;
  m.connectCalls = 0;
  m.openRejectsWith = null;
});

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function open(): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify({ capacity_sats: 1_000_000 });
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = "POST";
  (req as any).url = "/api/member/open-channel";
  (req as any).headers = {
    "content-type": "application/json",
    [CONFIRMATION_HEADER]: sha("capacity_sats=1000000"),
  };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let status = 0;
    let chunks = "";
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(s: number) {
        status = s;
        return res;
      },
      write(c: any) {
        if (c) chunks += c.toString();
        return true;
      },
      end(c?: any) {
        if (c) chunks += c.toString();
        resolve({ status, body: chunks ? JSON.parse(chunks) : null });
      },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => (req as unknown as PassThrough).end(raw));
  });
}

function statusWith(verdict: boolean | null | undefined) {
  const body: any = { applicable: true, current_tier: verdict ? "current" : "prepay" };
  if (verdict !== undefined) body.open_channel_allowed = verdict;
  return { ok: true, status: body };
}

/** What ln-service rejects with when LND relays a peer's funding error. */
function lnServiceRefusal(details: string) {
  return [503, "FailedToOpenChannel", { err: details }];
}
const ACCEPTOR_REFUSAL = lnServiceRefusal(
  `received funding error from ${TREASURY}: chan_id=${"cd".repeat(32)}, err=${R7_ACCEPTOR_TEXT}`,
);

describe("DW6 — an unpaid member's open is refused before any funding step", () => {
  it("verdict false: 403 membership_not_paid, and openTreasuryChannel is never called", async () => {
    m.status = statusWith(false);
    const r = await open();
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "membership_not_paid" });
    expect(m.openCalls).toBe(0);
  });
});

describe("DW8 — a paid member's open goes through the app check", () => {
  it("verdict true: the funding call runs and the txid comes back", async () => {
    m.status = statusWith(true);
    const r = await open();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(m.openCalls).toBe(1);
  });
});

describe("R4 — an unknown verdict lets the open through; the acceptor decides", () => {
  it.each([
    ["a treasury that sends no verdict (older treasury)", statusWith(undefined)],
    ["a null verdict", statusWith(null)],
    ["a failed status fetch", { ok: false, code: "treasury_unreachable", detail: "timeout" }],
    ["no local token yet", { ok: false, code: "no_local_token", detail: "" }],
  ])("%s → the funding call runs", async (_label, status) => {
    m.status = status;
    const r = await open();
    expect(m.openCalls).toBe(1);
    expect(r.status).toBe(200);
  });
});

describe("item A — the acceptor's refusal, read out of ln-service's array error, shows as the app check's answer", () => {
  it("verdict unknown, acceptor refuses: 403 membership_not_paid (not failed_to_open_channel)", async () => {
    m.status = statusWith(undefined);
    m.openRejectsWith = ACCEPTOR_REFUSAL;
    const r = await open();
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "membership_not_paid" });
  });

  it("a different LND refusal keeps today's answer (500 failed_to_open_channel)", async () => {
    m.status = statusWith(undefined);
    m.openRejectsWith = lnServiceRefusal("received funding error from x: chan_id=y, err=channel too small");
    const r = await open();
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "failed_to_open_channel" });
  });

  it("an Error with a message keeps today's answer", async () => {
    m.status = statusWith(undefined);
    m.openRejectsWith = new Error("insufficient funds available to construct transaction");
    const r = await open();
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "insufficient funds available to construct transaction" });
  });
});
