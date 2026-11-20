// fee-estimates — fee_rate on the three routes, through the real handleRequest
// (confirmation gate included). Spec §9 (O5, P16; F1, F4), §13 items 4, 5, 11,
// 12; rulings D1 (close: the ROUTE refuses absent/null unless force) and D4
// (dry_run on every route does not require fee_rate).
//
// Faked at their module boundaries: node info (treasury, synced), the capital
// guardrail, the member's status fetch, and the LND wrappers. The LND wrappers
// are spies: "what reaches LND" is read off their arguments (H5), and "nothing
// is sent" is their call count.
//
// Every refusal names the LAYER that answers it (F4, D1): GATE = 400
// confirmation_required from the confirmation gate, before the route runs;
// ROUTE = 400 from checkFeeRate in the route.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-fee-rate-routes-"));
process.env.DB_DIR = TMP;
const TREASURY = "02" + "11".repeat(32);
process.env.TREASURY_PUBKEY = TREASURY;

const PEER = "03" + "22".repeat(32);
const CHANNEL_ID = "842391119757312";

const m = vi.hoisted(() => ({
  opens: [] as Array<{ peer: string; capacity: number; opts: any }>,
  closes: [] as Array<{ txid: string; vout: number; opts: any }>,
  openRejectsWith: null as unknown,
  closeRejectsWith: null as unknown,
}));

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ node_role: "treasury", synced_to_chain: 1 }) as any };
});

vi.mock("../utils/capital-guardrails", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/capital-guardrails")>();
  return { ...actual, assertCanExpand: async () => {} };
});

vi.mock("../subscription/memberStatusClient", () => ({
  fetchLocalSubscriptionStatus: async () => ({ ok: false }),
}));

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    connectToPeer: async () => {},
    getLndChainBalance: async () => ({ chain_balance: 50_000_000 }),
    getLndPeers: async () => ({ peers: [{ public_key: PEER, socket: "1.2.3.4:9735" }] }),
    getLndChannels: async () => ({
      channels: [{ id: "842391119757312", transaction_id: "cd".repeat(32), transaction_vout: 1 }],
    }),
    openTreasuryChannel: async (peer: string, capacity: number, opts: any) => {
      m.opens.push({ peer, capacity, opts });
      if (m.openRejectsWith !== null) throw m.openRejectsWith;
      return { transaction_id: "ab".repeat(32), transaction_vout: 0 };
    },
    closeTreasuryChannel: async (txid: string, vout: number, opts: any) => {
      m.closes.push({ txid, vout, opts });
      if (m.closeRejectsWith !== null) throw m.closeRejectsWith;
      return { transaction_id: "ef".repeat(32) };
    },
  };
});

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let deriveConfirmation: typeof import("../utils/action-confirmation").deriveConfirmation;
let CONFIRMED_ROUTES: typeof import("../utils/action-confirmation").CONFIRMED_ROUTES;
let CONFIRMATION_HEADER: string;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handleRequest } = await import("../index"));
  ({ deriveConfirmation, CONFIRMED_ROUTES, CONFIRMATION_HEADER } = await import("../utils/action-confirmation"));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  const { db } = await import("../db");
  db.prepare(
    `INSERT OR REPLACE INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at)
     VALUES (?, ?, 2000000, 1000000, 1000000, 1, 0, ?)`,
  ).run(CHANNEL_ID, PEER, Date.now());
});

beforeEach(() => {
  m.opens = [];
  m.closes = [];
  m.openRejectsWith = null;
  m.closeRejectsWith = null;
});

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function routeFor(url: string) {
  const r = CONFIRMED_ROUTES.find((x) => x.match.kind === "exact" && x.match.url === url);
  if (!r) throw new Error(`no confirmed route for ${url}`);
  return r;
}

/**
 * POST with the confirmation the table derives for this exact body — so the
 * gate passes whenever it can, and any refusal is either the gate's (it could
 * not derive) or the route's. When the table cannot derive, a junk header is
 * sent; the gate refuses on the derivation, not on the header.
 */
function post(url: string, raw: string): Promise<{ status: number; body: any }> {
  let parsedBody: unknown;
  try { parsedBody = JSON.parse(raw); } catch { parsedBody = undefined; }
  const d = deriveConfirmation(routeFor(url), { url, body: parsedBody });
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = "POST";
  (req as any).url = url;
  (req as any).headers = {
    "content-type": "application/json",
    [CONFIRMATION_HEADER]: d.ok ? d.value : sha("underivable"),
  };
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
        let body: any = null;
        try { body = chunks ? JSON.parse(chunks) : null; } catch { body = chunks; }
        resolve({ status, body });
      },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => (req as unknown as PassThrough).end(raw));
  });
}

const EXPANSION = "/api/treasury/expansion/execute";
const ROTATION = "/api/treasury/rotation/execute";
const MEMBER_OPEN = "/api/member/open-channel";

const BASE: Record<string, Record<string, unknown>> = {
  [EXPANSION]: { peer_pubkey: PEER, capacity_sats: 2_000_000 },
  [ROTATION]: { channel_id: CHANNEL_ID },
  [MEMBER_OPEN]: { capacity_sats: 1_000_000 },
};

/** Build the raw JSON for a fee_rate case. ABSENT omits the key. */
const ABSENT = Symbol("absent");
function rawBody(url: string, fee: unknown, extra: Record<string, unknown> = {}): string {
  const body: Record<string, unknown> = { ...BASE[url], ...extra };
  if (fee !== ABSENT) body.fee_rate = fee;
  return JSON.stringify(body);
}

const lndCalls = () => m.opens.length + m.closes.length;

type Layer = "GATE" | "ROUTE";
type Case = { label: string; fee: unknown; layer: Layer; error: string };

// The refused values of §9 item 1 and 201 against 200 (§13 item 5).
function casesFor(url: string): Case[] {
  // F4: the gate refuses absent and null where the table REQUIRES fee_rate
  // (member open). Where the table marks it optional (expansion, D4; close, D1)
  // absent and null reach the route.
  const absentLayer: Layer = url === MEMBER_OPEN ? "GATE" : "ROUTE";
  const absentError = absentLayer === "GATE" ? "confirmation_required" : "fee_rate_required";
  return [
    { label: "absent", fee: ABSENT, layer: absentLayer, error: absentError },
    { label: "null", fee: null, layer: absentLayer, error: absentError },
    { label: "NaN (JSON.stringify sends null)", fee: NaN, layer: absentLayer, error: absentError },
    { label: "Infinity (JSON.stringify sends null)", fee: Infinity, layer: absentLayer, error: absentError },
    { label: '"abc"', fee: "abc", layer: "GATE", error: "confirmation_required" },
    { label: '"Infinity"', fee: "Infinity", layer: "GATE", error: "confirmation_required" },
    { label: "0", fee: 0, layer: "ROUTE", error: "invalid_fee_rate" },
    { label: "-1", fee: -1, layer: "ROUTE", error: "invalid_fee_rate" },
    { label: "1.5", fee: 1.5, layer: "ROUTE", error: "invalid_fee_rate" },
    { label: "true", fee: true, layer: "ROUTE", error: "invalid_fee_rate" },
    { label: '"5"', fee: "5", layer: "ROUTE", error: "invalid_fee_rate" },
    { label: "201", fee: 201, layer: "ROUTE", error: "fee_rate_above_ceiling" },
  ];
}

for (const url of [MEMBER_OPEN, EXPANSION, ROTATION]) {
  describe(`${url} — refusals, each labelled with the layer that answers (§13 items 5, 11)`, () => {
    for (const c of casesFor(url)) {
      it(`fee_rate ${c.label} → 400 ${c.error} [${c.layer}], nothing sent to LND`, async () => {
        const r = await post(url, rawBody(url, c.fee));
        expect(r.status).toBe(400);
        expect(r.body?.error).toBe(c.error);
        expect(lndCalls()).toBe(0);
      });
    }

    it("fee_rate 200 (the ceiling) is accepted and reaches LND", async () => {
      const r = await post(url, rawBody(url, 200));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(lndCalls()).toBe(1);
    });
  });
}

describe("H5 — what reaches the LND call equals body.fee_rate (§13 item 4)", () => {
  for (const fee of [1, 7, 200]) {
    it(`member open, fee_rate ${fee}`, async () => {
      const body = JSON.parse(rawBody(MEMBER_OPEN, fee));
      const r = await post(MEMBER_OPEN, JSON.stringify(body));
      expect(r.status).toBe(200);
      expect(m.opens).toHaveLength(1);
      expect(m.opens[0].opts.chainFeeTokensPerVbyte).toBe(body.fee_rate);
    });

    it(`treasury open (expansion), fee_rate ${fee}`, async () => {
      const body = JSON.parse(rawBody(EXPANSION, fee));
      const r = await post(EXPANSION, JSON.stringify(body));
      expect(r.status).toBe(200);
      expect(m.opens).toHaveLength(1);
      expect(m.opens[0].opts.chainFeeTokensPerVbyte).toBe(body.fee_rate);
    });

    it(`cooperative close (rotation), fee_rate ${fee}`, async () => {
      const body = JSON.parse(rawBody(ROTATION, fee));
      const r = await post(ROTATION, JSON.stringify(body));
      expect(r.status).toBe(200);
      expect(m.closes).toHaveLength(1);
      expect(m.closes[0].opts.chainFeeTokensPerVbyte).toBe(body.fee_rate);
      expect(m.closes[0].opts.isForce).toBe(false);
    });
  }
});

describe("force close and dry_run (F1, D1, D4; §13 item 12)", () => {
  it("close: is_force_close true WITH fee_rate → 400 fee_rate_not_allowed [ROUTE], nothing sent", async () => {
    const r = await post(ROTATION, rawBody(ROTATION, 5, { is_force_close: true }));
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("fee_rate_not_allowed");
    expect(lndCalls()).toBe(0);
  });

  it("close: is_force_close true with NO fee_rate → closes, and no fee rate reaches LND", async () => {
    const r = await post(ROTATION, rawBody(ROTATION, ABSENT, { is_force_close: true }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(m.closes).toHaveLength(1);
    expect(m.closes[0].opts.isForce).toBe(true);
    expect(m.closes[0].opts.chainFeeTokensPerVbyte).toBeUndefined();
  });

  it("close: dry_run with no fee_rate → the preview, nothing sent", async () => {
    const r = await post(ROTATION, rawBody(ROTATION, ABSENT, { dry_run: true }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.dry_run).toBe(true);
    expect(lndCalls()).toBe(0);
  });

  it("expansion: dry_run with no fee_rate → the preview, nothing sent (D4)", async () => {
    const r = await post(EXPANSION, rawBody(EXPANSION, ABSENT, { dry_run: true }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.dry_run).toBe(true);
    expect(lndCalls()).toBe(0);
  });

  it("expansion: dry_run with an invalid fee_rate is still refused [ROUTE]", async () => {
    const r = await post(EXPANSION, rawBody(EXPANSION, 0, { dry_run: true }));
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("invalid_fee_rate");
  });
});

describe("fee_rate is confirmed: the hash differs when only fee_rate differs (§9 item 3)", () => {
  for (const url of [MEMBER_OPEN, EXPANSION, ROTATION]) {
    it(`${url}: fee_rate 5 and 6 derive different confirmations`, () => {
      const a = deriveConfirmation(routeFor(url), { url, body: JSON.parse(rawBody(url, 5)) });
      const b = deriveConfirmation(routeFor(url), { url, body: JSON.parse(rawBody(url, 6)) });
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(a.value).not.toBe(b.value);
        expect(a.canonical).toContain("fee_rate=5");
      }
    });

    it(`${url}: a confirmation for fee_rate 5 does not execute fee_rate 6 → 409, nothing sent`, async () => {
      const five = deriveConfirmation(routeFor(url), { url, body: JSON.parse(rawBody(url, 5)) });
      if (!five.ok) throw new Error("derivation failed");
      const req = new PassThrough() as unknown as http.IncomingMessage;
      (req as any).method = "POST";
      (req as any).url = url;
      (req as any).headers = { "content-type": "application/json", [CONFIRMATION_HEADER]: five.value };
      (req as any).socket = { remoteAddress: "127.0.0.1" };
      const status = await new Promise<number>((resolve) => {
        let s = 0;
        const res = {
          setHeader() {}, getHeader() {},
          writeHead(x: number) { s = x; return res; },
          write() { return true; },
          end() { resolve(s); },
        } as unknown as http.ServerResponse;
        void handleRequest(req, res);
        setImmediate(() => (req as unknown as PassThrough).end(rawBody(url, 6)));
      });
      expect(status).toBe(409);
      expect(lndCalls()).toBe(0);
    });
  }
});

describe("D6 ruling — LND refusing the rate as below the node's relay floor gets a named error", () => {
  // The real shape: ln-service's array error with LND's details string
  // (lightning open_channel.js:284; LND v0.21.8 sweep/walletsweep.go:135-138,
  // ErrFeePreferenceTooLow = "fee preference too low", sweep/sweeper.go:28).
  const TOO_LOW = [
    503,
    "FailedToOpenChannel",
    { err: "fee preference too low: got 253 sat/kw, minimum is 1000 sat/kw" },
  ];
  const OTHER = [503, "FailedToOpenChannel", { err: "insufficient funds available to construct transaction" }];

  for (const url of [MEMBER_OPEN, EXPANSION]) {
    it(`${url}: LND's "fee preference too low" → 400 fee_rate_below_network_minimum`, async () => {
      m.openRejectsWith = TOO_LOW;
      const r = await post(url, rawBody(url, 1));
      expect(m.opens).toHaveLength(1);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "fee_rate_below_network_minimum" });
    });

    it(`${url}: the same refusal as an Error message is named too`, async () => {
      m.openRejectsWith = new Error("fee preference too low: got 253 sat/kw, minimum is 1000 sat/kw");
      const r = await post(url, rawBody(url, 1));
      expect(r.status).toBe(400);
      expect(r.body?.error).toBe("fee_rate_below_network_minimum");
    });

    it(`${url}: any other LND refusal keeps its 500`, async () => {
      m.openRejectsWith = OTHER;
      const r = await post(url, rawBody(url, 1));
      expect(r.status).toBe(500);
      expect(r.body?.error).not.toBe("fee_rate_below_network_minimum");
    });
  }
});

describe("D6 ruling, extended to the cooperative close (Ethan, 2026-11-18)", () => {
  // The real shape: the close stream's gRPC error, wrapped by ln-service as
  // [503, 'UnexpectedCloseChannelError', { err }] (lightning close_channel.js:204);
  // LND's text is in err.details (rpcserver.go:2945 → walletsweep.go:135-138).
  function grpcError(details: string) {
    const e = new Error(`2 UNKNOWN: ${details}`) as Error & { code: number; details: string };
    e.code = 2;
    e.details = details;
    return e;
  }
  const TOO_LOW_CLOSE = [
    503,
    "UnexpectedCloseChannelError",
    { err: grpcError("fee preference too low: got 253 sat/kw, minimum is 1000 sat/kw") },
  ];
  const OTHER_CLOSE = [
    503,
    "UnexpectedCloseChannelError",
    { err: grpcError("unable to gracefully close channel while peer is offline (try force closing it instead)") },
  ];

  it(`${ROTATION}: LND's "fee preference too low" → 400 fee_rate_below_network_minimum`, async () => {
    m.closeRejectsWith = TOO_LOW_CLOSE;
    const r = await post(ROTATION, rawBody(ROTATION, 1));
    expect(m.closes).toHaveLength(1);
    expect(m.closes[0].opts.chainFeeTokensPerVbyte).toBe(1);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "fee_rate_below_network_minimum" });
  });

  it(`${ROTATION}: any other close refusal keeps its 500`, async () => {
    m.closeRejectsWith = OTHER_CLOSE;
    const r = await post(ROTATION, rawBody(ROTATION, 1));
    expect(r.status).toBe(500);
    expect(r.body?.error).not.toBe("fee_rate_below_network_minimum");
  });

  it(`${ROTATION}: a force close is never mapped — it sends no rate`, async () => {
    m.closeRejectsWith = TOO_LOW_CLOSE;
    const r = await post(ROTATION, rawBody(ROTATION, ABSENT, { is_force_close: true }));
    expect(r.status).toBe(500);
  });
});
