// Behavioural control for the confirmation gate, driven through the real
// exported handleRequest — not through the pure module.
//
// WHY THIS FILE IS SEPARATE from action-confirmation.test.ts: that one proves
// the decision function is correct. This one proves the decision is actually
// ATTACHED. A correct verifier that nothing calls is the failure mode that unit
// tests cannot see, and it is the one that ships sats out the door.
//
// These assertions were run against pre-change index.ts and FAILED (the capital
// routes accepted a request with no confirmation at all). Re-run them that way
// before trusting a green here — see the commit message for the recorded output.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, describe, expect, it } from "vitest";
import { CONFIRMATION_HEADER } from "./action-confirmation";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-confirm-test-"));
process.env.DB_DIR = TMP_DB;

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

beforeAll(async () => {
  ({ handleRequest } = await import("../index"));
});

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

type Captured = { status: number; body: any; raw: string };

/** Drive handleRequest with a synthetic request; resolve once the response ends. */
function call(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
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
    // Body is written after the handler has had a chance to attach listeners.
    setImmediate(() => {
      (req as unknown as PassThrough).end(raw);
    });
    // Safety net: if nothing ever responds, fail loudly rather than hang.
    setTimeout(() => {
      if (!done) {
        status = -1;
        chunks = "";
        finish();
      }
    }, 4000);
  });
}

const isConfirmError = (c: Captured) =>
  c.body?.error === "confirmation_required" || c.body?.error === "confirmation_mismatch";

// ─────────────────────────────────────────────────────────────────────────────
// The three states. Two would not be enough: "rejects without" plus "accepts
// with" is also satisfied by a gate that merely checks the header is PRESENT.
// The middle state — present but WRONG — is what proves the value is verified.
// ─────────────────────────────────────────────────────────────────────────────
describe("a capital route: three states, not two", () => {
  const url = "/api/treasury/rebalance/circular";
  const body = { outgoing_channel: "111", incoming_channel: "222", tokens: 50000 };
  const correct = sha("outgoing_channel=111&incoming_channel=222&tokens=50000");

  it("NO confirmation -> 400 confirmation_required", async () => {
    const r = await call("POST", url, body);
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("confirmation_required");
  });

  it("WRONG confirmation -> 409 confirmation_mismatch", async () => {
    const r = await call("POST", url, body, { [CONFIRMATION_HEADER]: sha("nonsense") });
    expect(r.status).toBe(409);
    expect(r.body?.error).toBe("confirmation_mismatch");
  });

  it("CORRECT confirmation -> passes the gate and reaches the handler", async () => {
    const r = await call("POST", url, body, { [CONFIRMATION_HEADER]: correct });
    // Deliberately NOT asserting 200: there is no LND here, so the handler
    // fails downstream. What is being proven is that the gate let it through.
    // Asserting 200 would be asserting the presence of a Lightning node.
    expect(isConfirmError(r)).toBe(false);
    expect(r.status).not.toBe(-1); // -1 = nothing responded; would be a false pass
  });

  it("a confirmation valid for OTHER parameters -> 409 (the replay case)", async () => {
    const r = await call("POST", url, { ...body, tokens: 5_000_000 }, {
      [CONFIRMATION_HEADER]: correct,
    });
    expect(r.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BODY MUST SURVIVE THE GATE. The gate consumes the request stream to read
// the fields it verifies, then hands dispatch a replaying stand-in. If that
// replay were broken, "correct confirmation -> no confirm error" would still
// pass — the route would just fail later, for a different reason. So assert on
// a route that reports a DISTINGUISHABLE error when the body is missing.
//
// /api/member/open-channel rejects capacity_sats < 100_000. With the body
// delivered, a 1,000,000 capacity clears that check; with the body lost,
// Number(undefined) is NaN and the same route answers "must be at least
// 100,000". Absence of that message is therefore proof the bytes arrived.
// ─────────────────────────────────────────────────────────────────────────────
describe("the body survives the gate", () => {
  it("the route sees the parsed body after replay", async () => {
    const body = { capacity_sats: 1_000_000 };
    const r = await call("POST", "/api/member/open-channel", body, {
      [CONFIRMATION_HEADER]: sha("capacity_sats=1000000"),
    });
    expect(isConfirmError(r)).toBe(false);
    expect(JSON.stringify(r.body ?? {})).not.toContain("at least 100,000");
  });

  it("and the SAME route with a too-small capacity still reports it — proving the check is live", async () => {
    // The negative half: if the assertion above passed because the route never
    // validates, this would pass too. It must not.
    const body = { capacity_sats: 50_000 };
    const r = await call("POST", "/api/member/open-channel", body, {
      [CONFIRMATION_HEADER]: sha("capacity_sats=50000"),
    });
    expect(isConfirmError(r)).toBe(false);
    expect(JSON.stringify(r.body ?? {})).toContain("at least 100,000");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DOCUMENTED SHELL IDIOM, PINNED.
//
// These hex values were not computed in JavaScript. They came out of the
// `jq … | sha256sum` recipe in docs/API.md, run in bash, and are pasted here
// verbatim. That makes this the one test that fails if the canonical form
// changes and the documentation is not updated with it — otherwise the recipe
// rots silently and Ethan finds out by having a treasury command rejected.
//
// If one of these fails: re-run the idiom from docs/API.md, and if the new
// value is correct, the DOC changed meaning — update both together.
// ─────────────────────────────────────────────────────────────────────────────
describe("the documented shell idiom clears the gate", () => {
  const cases: Array<[url: string, body: unknown, shellComputed: string]> = [
    [
      "/api/pay",
      { payment_request: "lnbc1pjxyzqqdq" },
      "ffd020f4084283dc2475e82ded9b66533f581c60d220d8e11dd1cfd44bef85b4",
    ],
    [
      "/api/treasury/rebalance/circular",
      {
        outgoing_channel: "842391119757312",
        incoming_channel: "901234567890123",
        tokens: 250000,
        max_fee_sats: 500,
      },
      "933e462d5924ffe5f35484297f8006e8968afe14dc374fef12877ba2377f2342",
    ],
    [
      "/api/treasury/rebalance/loop-out",
      { channel_id: "842391119757312", amount_sats: 500000, max_swap_fee_sats: 5000 },
      "344e53cf307436abaa5c6850fd24395616e1eedac488910b5bdbcfe1a80d0898",
    ],
    [
      "/api/treasury/expansion/execute",
      {
        peer_pubkey: "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca",
        capacity_sats: 2000000,
      },
      "08fd5898f57826759cb81ecb19b3b5b52395f4b0b4323e24e03e7d34a1696aec",
    ],
  ];

  for (const [url, body, shellComputed] of cases) {
    it(`${url}: the bash-computed value is accepted`, async () => {
      const r = await call("POST", url, body, { [CONFIRMATION_HEADER]: shellComputed });
      expect(isConfirmError(r), `shell idiom for ${url} was refused: ${r.raw}`).toBe(false);
    });

    it(`${url}: and it is REJECTED once a parameter changes`, async () => {
      // Without this half, a gate that accepted everything would pass above.
      const tampered = { ...(body as Record<string, unknown>), __unused: 1 };
      const first = Object.keys(body as object)[0];
      (tampered as any)[first] =
        typeof (body as any)[first] === "number" ? (body as any)[first] + 1 : `${(body as any)[first]}X`;
      const r = await call("POST", url, tampered, { [CONFIRMATION_HEADER]: shellComputed });
      expect(r.status).toBe(409);
    });
  }
});

describe("what must stay untouched", () => {
  it("a READ needs no confirmation", async () => {
    const r = await call("GET", "/api/node", undefined);
    expect(isConfirmError(r)).toBe(false);
  });

  it("a non-capital MUTATION needs no confirmation", async () => {
    const r = await call("POST", "/api/contacts", { pubkey: "02ab", name: "x" });
    expect(isConfirmError(r)).toBe(false);
  });

  it("OPTIONS preflight is unaffected", async () => {
    const r = await call("OPTIONS", "/api/pay", undefined);
    expect(r.status).toBe(204);
  });

  it("/health is unaffected", async () => {
    const r = await call("GET", "/health", undefined);
    expect(isConfirmError(r)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OUTAGE DIRECTION. There is no LND in this environment, so every capital route
// is in the outage state already. The property: an outage must not make a route
// MORE permissive. A gate that ran after the handler's LND probe, or that threw
// and got swallowed by a route's catch-all, would 500/503 here instead of 400 —
// and a 5xx from an unauthenticated caller means the request reached the body.
// ─────────────────────────────────────────────────────────────────────────────
describe("outage does not open the gate", () => {
  it("refuses BEFORE the handler can fail on LND", async () => {
    const r = await call("POST", "/api/pay", { payment_request: "lnbc1abc" });
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("confirmation_required");
  });

  it("still refuses a wrong value during outage, with 409 not 5xx", async () => {
    const r = await call("POST", "/api/pay", { payment_request: "lnbc1abc" }, {
      [CONFIRMATION_HEADER]: sha("wrong"),
    });
    expect(r.status).toBe(409);
  });

  it("an unclassified mutation fails CLOSED rather than passing through", async () => {
    const r = await call("POST", "/api/definitely/not/a/route", { a: 1 });
    // No such dispatch site exists, so this must not 200. The gate classifies it
    // "unknown" and refuses; without the gate it would fall to the 404 tail.
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("confirmation_required");
  });
});
