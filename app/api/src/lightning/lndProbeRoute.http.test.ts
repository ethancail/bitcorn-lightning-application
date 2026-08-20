// Route-level coverage for GET /api/node/lnd-probe.
//
// This is the repo's first test that drives a route through the real dispatch
// chain. It became possible only at ee8903f, where index.ts's createServer
// callback was extracted to the exported handleRequest() and the five
// module-scope boot statements moved behind a require.main guard (PR #279). No
// listener is bound and no server is constructed; index.boot.test.ts pins that.
//
// WHY THIS EXISTS ALONGSIDE lndProbeRoute.test.ts. That suite proves the probe
// classifies faults correctly, with deps injected. It cannot prove the branch is
// wired: that the path literal dispatches at all, that the node-role check
// refuses a member, or that the serialized body is the report and nothing more.
// Those are properties of index.ts, so they need index.ts.
//
// ⚠ NO LND CONTACT. LND_DIR points at an empty scratch dir, so isLndAvailable()
// (lnd.ts:51-59, an fs.existsSync pair) is false and runLndHealthProbe
// short-circuits to files_absent with probe_calls_attempted: 0 — before any
// client is built or any socket is opened. That is what makes driving the real
// route safe here, and it is asserted rather than assumed.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// index.ts transitively imports ./db, which opens SQLite at its own module
// scope. Point it at a scratch dir, same as index.boot.test.ts.
const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-probe-route-db-"));
process.env.DB_DIR = TMP_DB;

// An EMPTY lnd dir: tls.cert and admin.macaroon are both absent, so the probe
// reports files_absent without reaching for a client or a socket.
const TMP_LND = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-probe-route-lnd-"));
process.env.LND_DIR = TMP_LND;

// node_role is what the branch's guard reads. Mocked so each case can set the
// role directly; assertTreasury itself is the real implementation.
const roleState = vi.hoisted(() => ({ node: null as { node_role?: string } | null }));

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => roleState.node };
});

const { handleRequest } = await import("../index");

// ─── Minimal req/res doubles ────────────────────────────────────────────────

interface Captured {
  status: number | null;
  headers: Record<string, unknown>;
  body: string;
  ended: boolean;
}

function fakeRes(): { res: any; captured: Captured } {
  const captured: Captured = { status: null, headers: {}, body: "", ended: false };
  const res = {
    setHeader(name: string, value: unknown) {
      captured.headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      captured.ended = true;
      return res;
    },
  };
  return { res, captured };
}

async function get(url: string): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = { method: "GET", url, headers: {} } as any;
  await handleRequest(req, res);
  return captured;
}

const PROBE_PATH = "/api/node/lnd-probe";

beforeEach(() => {
  roleState.node = null;
});

// ═══════════════════════════════════════════════════════════════════════════
// THE BRANCH DISPATCHES, AND THE ROLE CHECK GATES IT — both directions.
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/node/lnd-probe — treasury node", () => {
  it("dispatches and returns 200 with a JSON report", async () => {
    roleState.node = { node_role: "treasury" };
    const out = await get(PROBE_PATH);

    // 404 here would mean the branch never matched — the whole point of the
    // path-literal contract the flip query greps for.
    expect(out.status).toBe(200);
    expect(out.headers["Content-Type"]).toBe("application/json");
    expect(out.ended).toBe(true);
  });

  it("reports files_absent on all three scopes with ZERO probe calls", async () => {
    roleState.node = { node_role: "treasury" };
    const body = JSON.parse((await get(PROBE_PATH)).body);

    expect(body.files_present).toBe(false);
    expect(body.probe_calls_attempted).toBe(0);
    expect(body.scopes.map((s: any) => s.kind)).toEqual([
      "files_absent", "files_absent", "files_absent",
    ]);
    expect(body.scopes.map((s: any) => s.scope)).toEqual([
      "info:read", "offchain:read", "onchain:read",
    ]);
  });

  it("⚠ the wire body carries EXACTLY the report keys — no aggregate under any name", async () => {
    roleState.node = { node_role: "treasury" };
    const body = JSON.parse((await get(PROBE_PATH)).body);

    // Exact key set, not a blocklist of three names: this catches a rollup
    // introduced under any word (healthy, status, ok, verdict, worst_kind,
    // degraded, all_passed, severity, summary...).
    expect(Object.keys(body).sort()).toEqual([
      "checked_at", "files_present", "probe_calls_attempted", "scopes",
    ]);
    for (const scope of body.scopes) {
      expect(Object.keys(scope).sort()).toEqual(["code", "detail", "kind", "scope"]);
    }
  });

  it("stamps checked_at as a number", async () => {
    roleState.node = { node_role: "treasury" };
    const body = JSON.parse((await get(PROBE_PATH)).body);
    expect(typeof body.checked_at).toBe("number");
    expect(body.checked_at).toBeGreaterThan(0);
  });
});

describe("GET /api/node/lnd-probe — refused off the treasury", () => {
  it("returns 403 on a member node, not a report", async () => {
    roleState.node = { node_role: "member" };
    const out = await get(PROBE_PATH);

    expect(out.status).toBe(403);
    expect(JSON.parse(out.body).error).toBe("treasury_required");
    expect(JSON.parse(out.body)).not.toHaveProperty("scopes");
  });

  it("returns 403 on an external node", async () => {
    roleState.node = { node_role: "external" };
    expect((await get(PROBE_PATH)).status).toBe(403);
  });

  it("⚠ CARRIED LIMIT: 403 when node_role is absent entirely", async () => {
    // node_role is DERIVED from a successful getLndInfo() (sync.ts:11-18, :58),
    // so a treasury node that has never completed a first sync has no
    // lnd_node_info row and getNodeInfo() returns null. assertTreasury(undefined)
    // throws, so the total pre-existing-fault case cannot read this endpoint.
    // Pre-existing mechanism, unchanged by this arc — pinned here so it is
    // visible rather than folded into the member case.
    roleState.node = null;
    const out = await get(PROBE_PATH);
    expect(out.status).toBe(403);
    expect(JSON.parse(out.body).error).toBe("treasury_required");
  });

  it("the treasury/member split is a real discrimination, not a constant", async () => {
    roleState.node = { node_role: "treasury" };
    const asTreasury = await get(PROBE_PATH);
    roleState.node = { node_role: "member" };
    const asMember = await get(PROBE_PATH);

    expect(asTreasury.status).toBe(200);
    expect(asMember.status).toBe(403);
    expect(asTreasury.status).not.toBe(asMember.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE GUARD IS EXACT-EQUALITY — it shadows nothing and nothing shadows it.
// ═══════════════════════════════════════════════════════════════════════════

describe("the probe guard is exact-equality on the path literal", () => {
  it("does not match a trailing-segment near-miss", async () => {
    roleState.node = { node_role: "treasury" };
    expect((await get("/api/node/lnd-probe/extra")).status).toBe(404);
  });

  it("does not match a query-string form (req.url includes the query)", async () => {
    // Recorded rather than fixed: 97 exact-equality guards in this file behave
    // the same way, and req.url carries the query string. A caller adding ?x=1
    // gets 404, not a report.
    roleState.node = { node_role: "treasury" };
    expect((await get("/api/node/lnd-probe?verbose=1")).status).toBe(404);
  });

  it("leaves the neighbouring /api/node/preflight branch reachable", async () => {
    roleState.node = { node_role: "treasury" };
    // Inserting the probe branch directly above preflight's neighbour must not
    // shadow it. preflight calls LND, which with no files throws and is caught
    // into its own 500 — a reached branch, which is what this asserts.
    const out = await get("/api/node/preflight");
    expect(out.status).not.toBe(404);
  });

  it("/health still answers and is untouched by this arc", async () => {
    roleState.node = { node_role: "treasury" };
    const out = await get("/health");
    expect(out.status).not.toBe(404);
    // Decision 4: /health is not the host for LND probing. It must not have
    // grown scopes.
    expect(out.body).not.toContain("scopes");
  });
});
