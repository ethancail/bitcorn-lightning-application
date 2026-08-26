// Behavioural control for the REMOVAL of POST /api/lightning/open-recommended-channel.
//
// Driven through the real exported handleRequest, on the same synthetic-request
// harness as action-confirmation.route.test.ts, because the question is what the
// SERVER does with the path now — not what a table says about it.
//
// ─── WHAT A DELETED MUTATION ROUTE ACTUALLY RETURNS, AND IT IS NOT 404 ──────
//
// handleRequest classifies every non-GET request BEFORE dispatch runs
// (index.ts, `const verdict = classifyMutation(method, url)`). A path in neither
// CONFIRMED_ROUTES nor EXEMPT_MUTATIONS classifies as "unknown", and
// default-require turns that into 400 confirmation_required — so the deleted
// route never reaches the dispatch chain at all, and the 404-shaped answer the
// chain would have given is unreachable.
//
// That is the correct outcome for a removal and it is worth pinning: the route
// is refused by the gate rather than merely missing from the chain, which means
// it fails CLOSED even if someone later re-adds a handler without classifying
// it. The discriminator is the `detail` string — an unclassified route says
// "is not classified", a classified-but-unconfirmed one says "send x-bitcorn-confirm".
//
// ─── THE PAIR ───────────────────────────────────────────────────────────────
//
// (i) refuses the deleted path. (ii) — the half that matters — asserts the two
// SURVIVING openTreasuryChannel call sites still route, and that the GET
// enrichment route beside the deleted POST is untouched. Deleting a route out of
// a 4600-line if/else chain is exactly the edit that silently takes a neighbour
// with it.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, describe, expect, it } from "vitest";
import { CONFIRMATION_HEADER } from "./action-confirmation";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-removal-test-"));
process.env.DB_DIR = TMP_DB;

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

beforeAll(async () => {
  ({ handleRequest } = await import("../index"));
});

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

type Captured = { status: number; body: any; raw: string };

function call(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Captured> {
  const raw = body === undefined ? "" : JSON.stringify(body);

  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = method;
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
      try {
        parsed = chunks ? JSON.parse(chunks) : null;
      } catch {
        parsed = null;
      }
      resolve({ status, body: parsed, raw: chunks });
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
    setImmediate(() => {
      (req as unknown as PassThrough).end(raw);
    });
    setTimeout(() => {
      if (!done) {
        status = -1;
        chunks = "";
        finish();
      }
    }, 4000);
  });
}

const REMOVED = "/api/lightning/open-recommended-channel";

// ═══════════════════════════════════════════════════════════════════════════
// (i) REFUSES — the deleted path is not served
// ═══════════════════════════════════════════════════════════════════════════

describe("the removed funding route is not served", () => {
  it("refuses POST with 400 unknown-classification, NOT 404", () => {
    return call("POST", REMOVED, { peer_id: "acinq", local_funding_amount_sat: 1_000_000 }).then(
      (r) => {
        expect(r.status).toBe(400);
        expect(r.body?.error).toBe("confirmation_required");
        // The discriminator. "is not classified" is the unknown-verdict branch;
        // a route still in CONFIRMED_ROUTES would say "send x-bitcorn-confirm".
        expect(r.body?.detail, `detail was: ${r.body?.detail}`).toContain("is not classified");
      },
    );
  });

  it("still refuses when a caller supplies a well-formed confirmation", () => {
    // The value that WOULD have been correct under the old table. Classification
    // happens before verification, so a right-looking header changes nothing —
    // this is what makes the removal a removal rather than a harder gate.
    const correct = sha("peer_id=acinq&local_funding_amount_sat=1000000");
    return call(
      "POST",
      REMOVED,
      { peer_id: "acinq", local_funding_amount_sat: 1_000_000 },
      { [CONFIRMATION_HEADER]: correct },
    ).then((r) => {
      expect(r.status).toBe(400);
      expect(r.body?.detail).toContain("is not classified");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (ii) PERMITS — the neighbours survive. THIS IS THE ONE THAT MATTERS.
// ═══════════════════════════════════════════════════════════════════════════

describe("the surviving routes are unaffected", () => {
  it("GET /api/network/recommended-peers still routes (the neighbour above the cut)", async () => {
    const r = await call("GET", "/api/network/recommended-peers", undefined);
    // No Worker is configured in a test process, so the honest outcome is 503
    // worker_not_configured — reached from INSIDE the handler. What matters is
    // that the request was SERVED: an unrouted path could not produce this body,
    // and a GET never touches the confirmation gate at all.
    expect(r.status, `body: ${r.raw}`).not.toBe(-1);
    expect([200, 502, 503, 500]).toContain(r.status);
    expect(r.body?.error).not.toBe("confirmation_required");
  });

  it("POST /api/member/open-channel still routes past the gate", async () => {
    // Surviving openTreasuryChannel call site #1. With a CORRECT confirmation it
    // must get past classification and verification into the handler; the
    // handler then fails on absent LND, which is the baseline behaviour here.
    const correct = sha("capacity_sats=250000");
    const r = await call(
      "POST",
      "/api/member/open-channel",
      { capacity_sats: 250_000 },
      { [CONFIRMATION_HEADER]: correct },
    );
    expect(r.status).not.toBe(-1);
    expect(r.body?.error, `body: ${r.raw}`).not.toBe("confirmation_required");
    expect(r.body?.error).not.toBe("confirmation_mismatch");
  });

  it("POST /api/member/open-channel still REFUSES without a confirmation", async () => {
    // The gate on the surviving route is intact, not collaterally removed.
    const r = await call("POST", "/api/member/open-channel", { capacity_sats: 250_000 });
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("confirmation_required");
    expect(r.body?.detail).toContain("send");
  });

  it("POST /api/treasury/expansion/execute still routes past the gate", async () => {
    // Surviving openTreasuryChannel call site #2 — the only one that reaches
    // assertCanExpand. Same shape: past the gate, then whatever the handler does.
    const correct = sha("peer_pubkey=02bb&capacity_sats=250000");
    const r = await call(
      "POST",
      "/api/treasury/expansion/execute",
      { peer_pubkey: "02bb", capacity_sats: 250_000 },
      { [CONFIRMATION_HEADER]: correct },
    );
    expect(r.status).not.toBe(-1);
    expect(r.body?.error, `body: ${r.raw}`).not.toBe("confirmation_required");
    expect(r.body?.error).not.toBe("confirmation_mismatch");
  });
});
