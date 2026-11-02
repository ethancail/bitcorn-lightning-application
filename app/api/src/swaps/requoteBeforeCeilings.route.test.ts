// Ruling d, part 1: a quote stored without fee components (a pre-migration
// row) always gets requote_required — never a bare 400 from the body-ceiling
// check. A client holding such a quote has no ceilings to echo; before this,
// the confirmation gate refused its body as 400 confirmation_required
// (missing_field) before the handler could say "get a new quote".
//
// Driven through the real handleRequest: the real confirmation gate, the real
// swap handlers and the real swapService against a temp-dir database the real
// migration runner builds. Only the node read, the membership/role checks, the
// swap policy and the loopd boundary are stubbed.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_HEADER } from "../utils/action-confirmation";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-requote-before-ceilings-test-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const MEMBER = "02" + "11".repeat(32);
const s = vi.hoisted(() => ({ node: { pubkey: "", node_role: "member", membership_status: "active" } as any, initiate: vi.fn() }));

vi.mock("../api/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/read")>()),
  getNodeInfo: () => s.node,
}));
vi.mock("../utils/membership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/membership")>()),
  assertActiveMember: () => {},
}));
vi.mock("../utils/role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/role")>()),
  assertTreasury: () => {},
}));
vi.mock("./swapPolicy", () => ({
  checkMemberLoopOutPolicy: async () => ({ ok: true }),
  checkTreasuryLoopOutPolicy: async () => ({ ok: true }),
  checkMemberLoopInPolicy: async () => ({ ok: true }),
}));
vi.mock("./loopProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loopProvider")>()),
  initiateLoopOut: s.initiate,
  initiateLoopIn: s.initiate,
}));

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("../index"));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
});

beforeEach(() => {
  s.node = { pubkey: MEMBER, node_role: "member", membership_status: "active" };
  s.initiate.mockReset();
});

const sha = (v: string) => crypto.createHash("sha256").update(v, "utf8").digest("hex");

/** A row as a pre-migration build wrote it: no quote components. */
function preMigrationRow(swapType: "loop_out" | "loop_in"): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO swap_requests
      (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status,
       amount_sat, quoted_fee_sat, quote_expires_at)
    VALUES (?, ?, ?, ?, 'member', ?, ?, 'quote_created', 250000, 2035, ?)
  `).run(id, now, now, MEMBER, swapType, swapType === "loop_out" ? "lightning_to_chain" : "chain_to_lightning", now + 300_000);
  return id;
}

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

// A valid mainnet address: the handler validates it against ENV.bitcoinNetwork.
const DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

describe("a pre-migration quote executed without ceilings gets requote_required, not a 400", () => {
  it("A, member Loop Out", async () => {
    const id = preMigrationRow("loop_out");
    const r = await post("/api/swaps/loop-out", { swap_request_id: id, destination_address: DEST }, {
      [CONFIRMATION_HEADER]: sha(`swap_request_id=${id}&destination_address=${DEST}`),
    });
    expect(r).toMatchObject({ status: 409, body: { error: "requote_required" } });
    expect(s.initiate).not.toHaveBeenCalled();
  });

  it("B, admin Loop Out", async () => {
    s.node = { pubkey: MEMBER, node_role: "treasury" };
    const id = preMigrationRow("loop_out");
    const r = await post("/api/admin/swaps/loop-out", { swap_request_id: id }, {
      [CONFIRMATION_HEADER]: sha(`swap_request_id=${id}`),
    });
    expect(r).toMatchObject({ status: 409, body: { error: "requote_required" } });
    expect(s.initiate).not.toHaveBeenCalled();
  });

  it("D, member Loop In", async () => {
    const id = preMigrationRow("loop_in");
    const r = await post("/api/swaps/loop-in", { swap_request_id: id }, {
      [CONFIRMATION_HEADER]: sha(`swap_request_id=${id}`),
    });
    expect(r).toMatchObject({ status: 409, body: { error: "requote_required" } });
    expect(s.initiate).not.toHaveBeenCalled();
  });
});
