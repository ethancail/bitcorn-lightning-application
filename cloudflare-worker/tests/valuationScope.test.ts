// Router-level JWT gate enforcement for the five GET /valuation/* endpoints.
//
// WHY THIS FILE EXISTS. The /valuation/* reads are tier-gated at scope=full
// (src/index.ts:167-179) — that gate is what makes the valuation engine a paid
// benefit, so it is load-bearing for the whole subscription model. It had ZERO
// rejection coverage before this file:
//
//   - tests/handlers/valuation.test.ts calls the three handlers DIRECTLY,
//     bypassing withJwtGate entirely. No 401, no 403, no scope anywhere in it.
//   - tests/router.test.ts:46-77 does go through worker.fetch, but carries a
//     valid full-scope Bearer and says so at its :20-25 — it asserts ROUTING.
//   - /valuation/manual/day and /valuation/manual/calendar had no test of any
//     kind, handler-level or router-level.
//
// Worth noting how the gap arose, because it is not carelessness: those three
// router tests were written BEFORE the gate existed, so they were failing 401
// and were repaired by giving them a token. Correct repair — they are dispatch
// tests. But it converted the last three requests in the suite that touched the
// gate into requests that sail through it. A fix that makes a test pass for the
// right reason can still delete the last accidental coverage of something else.
//
// Structure and technique are deliberately copied from tests/baseScope.test.ts
// rather than reinvented, per its own warning that two drifting gate-test
// dialects are worse than one.
//
// HOW "reached the handler" IS PROVEN WITHOUT NETWORK. Each endpoint is called
// so that a gate-passing request lands on something only the HANDLER can
// produce, asserted positively rather than as a mere "not 403":
//   - manual/day + manual/calendar have their own input validators, so a
//     request missing the required query param answers 400 with a
//     handler-specific error code (the baseScope trick).
//   - current/history/inputs have NO input validation — they read KV
//     unconditionally — so gate-passage is proven instead by their distinctive
//     empty-KV answers against a mockKV env (404 no_valuation_data, {series:[]},
//     {}). Same idea, different marker, because those handlers offer no other.
// Either way the gate-blocked and gate-passed outcomes are impossible to
// confuse. No RPC, no fetch mock, fully deterministic.

import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/lib/types";
import {
  ISSUER,
  createEntitlementSigner,
  expiredExp,
  withAuth,
  type EntitlementSigner,
} from "./helpers/entitlementToken";

function mockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

let signer: EntitlementSigner;
// A SECOND, unrelated keypair. Used only for the bad-signature case: a token
// that is structurally perfect and signed by a key the Worker does not trust.
// Minting it from a different signer is the only way to isolate the signature
// check — varying a claim instead would trip an earlier check first.
let foreignSigner: EntitlementSigner;

beforeAll(async () => {
  signer = await createEntitlementSigner();
  foreignSigner = await createEntitlementSigner();
});

/** A correctly configured Worker: KV for the reads, public key for the gate. */
function makeEnv(): Env {
  return {
    PRICES_CACHE: mockKV(),
    SUBSCRIPTION_PUBLIC_KEY: signer.publicKeyX,
  } as unknown as Env;
}

/** A Worker whose SUBSCRIPTION_PUBLIC_KEY secret was never set. */
function unconfiguredEnv(): Env {
  return { PRICES_CACHE: mockKV() } as unknown as Env;
}

interface GatedEndpoint {
  name: string;
  request: () => Request;
  /** Status the HANDLER answers with when the gate lets the request through. */
  handlerStatus: number;
  /** `error` field of the handler's answer, when it has one. */
  handlerError?: string;
  /** Full body of the handler's answer, when it has no error field. */
  handlerBody?: unknown;
  /** Where that answer comes from, so the coupling is traceable. */
  handlerNote: string;
}

const GATED_ENDPOINTS: GatedEndpoint[] = [
  {
    name: "GET /valuation/current",
    request: () => new Request("https://w/valuation/current"),
    handlerStatus: 404,
    handlerError: "no_valuation_data",
    handlerNote: "empty-KV answer, handlers/valuation.ts:12",
  },
  {
    name: "GET /valuation/history",
    request: () => new Request("https://w/valuation/history?since=2026-04-01"),
    handlerStatus: 200,
    handlerBody: { series: [] },
    handlerNote: "empty-KV answer, handlers/valuation.ts:28",
  },
  {
    name: "GET /valuation/inputs",
    request: () => new Request("https://w/valuation/inputs"),
    handlerStatus: 200,
    handlerBody: {},
    handlerNote: "empty-KV answer, handlers/valuation.ts:35",
  },
  {
    // No ?date — the handler's own validator answers.
    name: "GET /valuation/manual/day",
    request: () => new Request("https://w/valuation/manual/day"),
    handlerStatus: 400,
    handlerError: "invalid_or_missing_date",
    handlerNote: "own validator, handlers/manualInputQuery.ts:23",
  },
  {
    // No ?from — the handler's own validator answers.
    name: "GET /valuation/manual/calendar",
    request: () => new Request("https://w/valuation/manual/calendar"),
    handlerStatus: 400,
    handlerError: "invalid_from",
    handlerNote: "own validator, handlers/manualInputQuery.ts:38",
  },
];

/** The request reached the handler: assert what only the handler produces. */
async function expectReachedHandler(res: Response, ep: GatedEndpoint) {
  expect(res.status).toBe(ep.handlerStatus);
  const body = await res.json();
  if (ep.handlerError !== undefined) {
    expect((body as { error?: string }).error).toBe(ep.handlerError);
  } else {
    expect(body).toEqual(ep.handlerBody);
  }
}

/**
 * The gate refused it: assert the status/reason AND that the handler's own
 * answer is absent. Without the second half, a test would still pass if the
 * gate were removed and the handler happened to answer with the same status.
 */
async function expectRefusedAtGate(
  res: Response,
  ep: GatedEndpoint,
  status: number,
  reason: string,
) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error?: string; detail?: string };
  expect(body.error).toBe(reason);
  // Every gate refusal carries a `detail` string (src/lib/jwt.ts:201). Asserted
  // as a shape, not a message: the wording is not a contract, its presence is.
  expect(typeof body.detail).toBe("string");
  if (status !== ep.handlerStatus) {
    expect(res.status).not.toBe(ep.handlerStatus);
  }
  if (ep.handlerError !== undefined) {
    expect(body.error).not.toBe(ep.handlerError);
  }
}

describe("/valuation/* JWT gate — the valuation engine is a paid benefit", () => {
  for (const ep of GATED_ENDPOINTS) {
    describe(ep.name, () => {
      it(`full-scope token PASSES the gate and reaches the handler (${ep.handlerNote})`, async () => {
        const jwt = await signer.token("full");
        const res = await worker.fetch(withAuth(ep.request(), jwt), makeEnv(), {} as any);
        await expectReachedHandler(res, ep);
      });

      it("payment-scope token is REFUSED 403 scope_insufficient", async () => {
        // The property this whole file exists for. `current`-tier members hold
        // full scope; prepay and every lapsed tier hold payment scope
        // (scopeForTier, app/api/src/subscription/tokenIssuance.ts:98-101).
        // 403 not 401 is deliberate — the token is authentic, just under-scoped
        // (src/lib/jwt.ts:158-167).
        const jwt = await signer.token("payment");
        const res = await worker.fetch(withAuth(ep.request(), jwt), makeEnv(), {} as any);
        await expectRefusedAtGate(res, ep, 403, "scope_insufficient");
      });

      it("no Authorization header is REFUSED 401 missing", async () => {
        const res = await worker.fetch(ep.request(), makeEnv(), {} as any);
        await expectRefusedAtGate(res, ep, 401, "missing");
      });

      it("a non-JWT Bearer is REFUSED 401 malformed", async () => {
        const res = await worker.fetch(
          withAuth(ep.request(), "not-a-jwt"),
          makeEnv(),
          {} as any,
        );
        await expectRefusedAtGate(res, ep, 401, "malformed");
      });

      it("a token signed by an untrusted key is REFUSED 401 bad_signature", async () => {
        const jwt = await foreignSigner.token("full");
        const res = await worker.fetch(withAuth(ep.request(), jwt), makeEnv(), {} as any);
        await expectRefusedAtGate(res, ep, 401, "bad_signature");
      });

      it("an expired token is REFUSED 401 expired — the reason string is an API contract", async () => {
        // ⚠ DO NOT FOLD THIS INTO THE OTHER 401 TESTS. It looks redundant —
        // same status, same shape — but the `error` VALUE is a contract between
        // this Worker and the API, not an internal detail.
        //
        // app/api/src/lib/workerFetch.ts:143 branches on it:
        //     if (reason === "bad_signature" || reason === "expired")
        // and only then refreshes the entitlement token and retries once. Every
        // other 401 reason is treated as structural and is NOT retried.
        //
        // So if an expired token ever started answering `malformed` instead,
        // nothing here would look broken — but transparent, self-healing token
        // refreshes would silently become hard member-facing failures. The
        // assertion is on `body.error === "expired"` precisely BECAUSE a client
        // branches on that string.
        //
        // exp is an hour in the past, comfortably clear of the gate's
        // `clockTolerance: "60s"` (src/lib/jwt.ts:121).
        const jwt = await signer.tokenWith({ scope: "full", exp: expiredExp() });
        const res = await worker.fetch(withAuth(ep.request(), jwt), makeEnv(), {} as any);
        await expectRefusedAtGate(res, ep, 401, "expired");
      });

      it("a token from the wrong issuer is REFUSED 401 bad_issuer", async () => {
        const jwt = await signer.tokenWith({
          scope: "full",
          issuer: `not-${ISSUER}`,
        });
        const res = await worker.fetch(withAuth(ep.request(), jwt), makeEnv(), {} as any);
        await expectRefusedAtGate(res, ep, 401, "bad_issuer");
      });

      it("a token whose sub is not a 66-char hex pubkey is REFUSED 401 bad_subject", async () => {
        const jwt = await signer.tokenWith({ scope: "full", subject: "nope" });
        const res = await worker.fetch(withAuth(ep.request(), jwt), makeEnv(), {} as any);
        await expectRefusedAtGate(res, ep, 401, "bad_subject");
      });

      it("an unconfigured Worker REFUSES 503 service_unconfigured — fail closed", async () => {
        // FAIL-CLOSED, and not hypothetical: deploy day sets this Worker's
        // secrets for the first time. A Worker with no SUBSCRIPTION_PUBLIC_KEY
        // must refuse every gated read rather than admit them ungated, which is
        // what a `catch`-and-continue or a truthiness slip would produce.
        const jwt = await signer.token("full");
        const res = await worker.fetch(
          withAuth(ep.request(), jwt),
          unconfiguredEnv(),
          {} as any,
        );
        await expectRefusedAtGate(res, ep, 503, "service_unconfigured");
      });
    });
  }
});

describe("gate check ORDER: missing-Bearer is decided before the key is loaded", () => {
  // src/lib/jwt.ts:111-114 — the `!jwt` throw sits ABOVE the loadPublicKey()
  // call. So a request with no Bearer against an unconfigured Worker answers
  // 401 `missing`, never 503 `service_unconfigured`.
  //
  // Pinned because the ordering is invisible: both branches refuse, so
  // reversing them breaks no other test in this file, and every case above
  // supplies exactly one of the two conditions. Only a request that trips BOTH
  // can tell the order. It matters because `missing` tells a client "you sent
  // no credential" while `service_unconfigured` tells an operator "this Worker
  // is misconfigured" — an operator debugging a 503 storm on deploy day should
  // not be chasing clients that simply never sent a token.
  it("no Bearer + no SUBSCRIPTION_PUBLIC_KEY answers 401 missing, not 503", async () => {
    const res = await worker.fetch(
      new Request("https://w/valuation/current"),
      unconfiguredEnv(),
      {} as any,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe("missing");
  });
});

describe("the two POST /valuation/* routes are HMAC-gated, NOT JWT-gated", () => {
  // src/index.ts:78-81 dispatch these BEFORE any withJwtGate call, and
  // src/lib/jwt.ts:18-21 states they "bypass this validator entirely".
  //
  // Pinned because moving them under withJwtGate is a plausible tidy-up that
  // would look like a consistency improvement and would break the treasury's
  // signed-write path — the treasury holds an HMAC secret, not an entitlement
  // token, so it would start receiving 401 `missing` on every submission.
  //
  // The tell that no JWT gate is present: with the HMAC secret configured and a
  // perfectly valid full-scope Bearer attached, the answer is still the HMAC
  // layer's own `missing_signature_headers`. A JWT gate in front would have
  // accepted that Bearer and changed nothing; a JWT gate INSTEAD of HMAC would
  // have answered something else entirely.
  const hmacEnv = () =>
    ({
      PRICES_CACHE: mockKV(),
      VALUATION_SUBMIT_HMAC: "test-secret",
      SUBSCRIPTION_PUBLIC_KEY: signer.publicKeyX,
    }) as unknown as Env;

  for (const path of ["/valuation/manual", "/valuation/refresh"]) {
    it(`POST ${path} answers the HMAC layer even with a valid full-scope Bearer`, async () => {
      const jwt = await signer.token("full");
      const req = withAuth(
        new Request(`https://w${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        jwt,
      );
      const res = await worker.fetch(req, hmacEnv(), {} as any);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("missing_signature_headers");
      // Not a JWT-gate refusal, which is the whole point.
      expect(body.error).not.toBe("missing");
      expect(body.error).not.toBe("scope_insufficient");
    });
  }
});
