// Router-level scope enforcement for the stablecoin rail's /base/* endpoints.
//
// WHY THIS FILE EXISTS, and why it is router-level rather than handler-level:
// tests/handlers/base.test.ts calls the four handlers DIRECTLY, bypassing
// withJwtGate entirely — it contains no scope, 401, or 403 assertion anywhere
// in its 33 tests. So before this file, the entire 192-test Worker suite passed
// identically whether /base/* required "payment" or "full". The scope gate had
// zero coverage. These tests go through `worker.fetch` so the gate is actually
// in the path.
//
// The property under test: the rail is a subscription benefit. `current`-tier
// members (full scope) reach the handlers; every lapsed tier and the
// past-fresh-grace `prepay` tier (payment scope) are refused 403 at the gate.
//
// HOW "reached the handler" is proven WITHOUT network: each gated endpoint is
// called with a deliberately malformed request, so a token that passes the gate
// lands on the handler's own input validation and returns a handler-specific
// 400. A token that fails the gate can never produce that 400 — withJwtGate
// short-circuits first. So 400 == gate passed, 403 == gate blocked, and the two
// outcomes are impossible to confuse. No RPC, no fetch mock, fully
// deterministic.

import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/lib/types";
import {
  createEntitlementSigner,
  withAuth,
  type EntitlementSigner,
} from "./helpers/entitlementToken";

// The tier → scope mapping this file assumes. Mirrors scopeForTier() in
// app/api/src/subscription/tokenIssuance.ts:98-101 (`current` → full, every
// other tier → payment). That function is pinned independently in
// app/api/src/subscription/tierScope.test.ts, so this table is verified rather
// than assumed — the Worker package can't import across into the API package.
//
// `current (fresh grace)` is listed as its own row on purpose. It is NOT a
// distinct tier: a never-paid node inside its 30-day grace_days_fresh window
// (migration 042) computes to the literal tier string `current` and mints an
// identical full-scope token. The row exists so the intent is legible here and
// so a future reader tightening this gate trips a named, failing test rather
// than silently removing trial access.
const TIER_SCOPE: Array<{
  tier: string;
  scope: "full" | "payment";
  entitled: boolean;
}> = [
  { tier: "current (paid)", scope: "full", entitled: true },
  { tier: "current (fresh grace, never paid)", scope: "full", entitled: true },
  { tier: "prepay", scope: "payment", entitled: false },
  { tier: "worker_lapsed", scope: "payment", entitled: false },
  { tier: "routing_lapsed", scope: "payment", entitled: false },
  { tier: "close_due", scope: "payment", entitled: false },
];

// Each gated endpoint paired with the malformed request that makes its own
// validator answer, and the error code that answer carries. Cites the handler
// line so the coupling is traceable if a handler's validation order changes.
const GATED_ENDPOINTS = [
  {
    name: "POST /base/contract-state",
    handlerError: "invalid_json", // handlers/base.ts:225
    request: () =>
      new Request("https://w/base/contract-state", {
        method: "POST",
        body: "not-json",
      }),
  },
  {
    name: "GET /base/balance",
    handlerError: "invalid_address", // handlers/base.ts:315
    request: () => new Request("https://w/base/balance?address=nope"),
  },
  {
    name: "POST /base/events",
    handlerError: "invalid_json", // handlers/base.ts:426
    request: () =>
      new Request("https://w/base/events", { method: "POST", body: "not-json" }),
  },
];

let signer: EntitlementSigner;

function tokenWithScope(scope: "full" | "payment"): Promise<string> {
  return signer.token(scope);
}

function makeEnv(): Env {
  // SUBSCRIPTION_PUBLIC_KEY is the raw Ed25519 x coord, base64url — the shape
  // loadPublicKey() feeds to importJWK (lib/jwt.ts:87-90).
  //
  // The three /base/* handlers are deliberately left UNCONFIGURED (no router,
  // no USDC, no RPC URL). A gate-passing request must still fail on the
  // handler's input validation before it could ever want them, which is what
  // keeps these tests network-free.
  return { SUBSCRIPTION_PUBLIC_KEY: signer.publicKeyX } as Env;
}

beforeAll(async () => {
  signer = await createEntitlementSigner();
});

describe("/base/* scope gate — the rail is a subscription benefit", () => {
  for (const endpoint of GATED_ENDPOINTS) {
    describe(endpoint.name, () => {
      for (const row of TIER_SCOPE) {
        if (row.entitled) {
          it(`tier ${row.tier} (scope=${row.scope}) PASSES the gate and reaches the handler`, async () => {
            const jwt = await tokenWithScope(row.scope);
            const res = await worker.fetch(
              withAuth(endpoint.request(), jwt),
              makeEnv(),
              {} as any,
            );
            const body = (await res.json()) as { error?: string };
            // Reaching the handler's own validator is the proof the gate let it
            // through. Asserted positively (the handler's error code), not as a
            // mere "not 403" — a 500 or a 404 would satisfy "not 403" while
            // meaning the request never got where we claim it did.
            expect(res.status).toBe(400);
            expect(body.error).toBe(endpoint.handlerError);
          });
        } else {
          it(`tier ${row.tier} (scope=${row.scope}) is REFUSED 403 at the gate`, async () => {
            const jwt = await tokenWithScope(row.scope);
            const res = await worker.fetch(
              withAuth(endpoint.request(), jwt),
              makeEnv(),
              {} as any,
            );
            const body = (await res.json()) as { error?: string };
            expect(res.status).toBe(403);
            expect(body.error).toBe("scope_insufficient");
            // And it must NOT have reached the handler: the malformed body
            // would otherwise have produced the handler's 400. This is the
            // assertion that goes red if the scope is loosened back to
            // "payment".
            expect(body.error).not.toBe(endpoint.handlerError);
          });
        }
      }

      it("a request with NO Bearer is refused 401 (missing), not 403", async () => {
        const res = await worker.fetch(endpoint.request(), makeEnv(), {} as any);
        const body = (await res.json()) as { error?: string };
        expect(res.status).toBe(401);
        expect(body.error).toBe("missing");
      });
    });
  }
});

describe("/base/contract-info stays public", () => {
  // The rail's one ungated read. Members need the router address before they
  // hold any token, and the data is on-chain public anyway. If this ever starts
  // requiring a Bearer, the sync loop's first step breaks for every node.
  it("is reachable with no Authorization header at all", async () => {
    const res = await worker.fetch(
      new Request("https://w/base/contract-info"),
      makeEnv(),
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rpc_status?: string };
    // Unconfigured env → the documented degraded payload, NOT an auth error.
    expect(body.rpc_status).toBe("unconfigured");
  });

  it("does not reject a payment-scope Bearer it has no use for", async () => {
    const jwt = await tokenWithScope("payment");
    const res = await worker.fetch(
      withAuth(new Request("https://w/base/contract-info"), jwt),
      makeEnv(),
      {} as any,
    );
    expect(res.status).toBe(200);
  });
});
