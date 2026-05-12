// Cloudflare Worker-side JWT validation for subscription entitlement
// tokens. Source of truth:
// bitcorn-research/specs/2026-05-08-member-subscription.md §6.6
//
// Validates:
//   1. Token signature against env.SUBSCRIPTION_PUBLIC_KEY (a JWK x
//      coord — raw 32-byte Ed25519 public key, base64url-encoded).
//   2. exp against current time (with the jose default clock-skew
//      tolerance, augmented to 60s).
//   3. sub format (66-char hex, member pubkey).
//   4. scope claim against the endpoint's required scope.
//
// The validator is intentionally separate from the API-side
// `subscription/jwtVerify.ts` because the Worker runtime can't load
// Node modules. Both validators must check the same claims the same
// way — keep them in sync.
//
// HMAC-gated endpoints (POST /valuation/manual, POST /valuation/refresh)
// bypass this validator entirely; they use the existing
// VALUATION_SUBMIT_HMAC contract per spec §6.6 "HMAC contract
// untouched."
//
// Public endpoints (GET /recommended-peers, GET /treasury-info) bypass
// this validator too — they need to be reachable BEFORE a member has
// any token, as part of the setup flow.

import { jwtVerify, importJWK } from "jose";
import type { Env } from "./types";

// `payment` covers any subscriber tier other than `current` (prepay
// during initial onboarding, plus all three lapsed tiers — payment
// scope is the recovery-path entitlement that keeps Coinbase Onramp +
// commodity-prices reads available so members can buy BTC and renew).
// Per decisions/2026-05-11-subscription-stage-5a-architectural-deltas.md
// decision #2.
export type Scope = "full" | "payment";

export interface VerifiedJwt {
  sub: string;
  scope: Scope;
  iat: number;
  exp: number;
}

export class WorkerJwtError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "missing"
      | "malformed"
      | "bad_signature"
      | "expired"
      | "bad_issuer"
      | "bad_subject"
      | "bad_scope"
      | "scope_insufficient"
      | "service_unconfigured",
    public readonly status: number,
  ) {
    super(message);
    this.name = "WorkerJwtError";
  }
}

const EXPECTED_ISSUER = "bitcorn-treasury";

// CryptoKey caching — importJWK is async + expensive; the Worker
// pools requests across many invocations and we don't want every
// gated request to redo the import. The cache is keyed on the
// base64url-encoded public key value so an operator rotating the
// secret immediately invalidates.
let cachedPublicKeyB64: string | null = null;
let cachedPublicKey: CryptoKey | null = null;

async function loadPublicKey(env: Env): Promise<CryptoKey> {
  const b64 = env.SUBSCRIPTION_PUBLIC_KEY;
  if (!b64) {
    throw new WorkerJwtError(
      "SUBSCRIPTION_PUBLIC_KEY is not configured on this Worker",
      "service_unconfigured",
      503,
    );
  }
  if (cachedPublicKey && cachedPublicKeyB64 === b64) {
    return cachedPublicKey;
  }
  const key = (await importJWK(
    { kty: "OKP", crv: "Ed25519", x: b64 },
    "EdDSA",
  )) as CryptoKey;
  cachedPublicKey = key;
  cachedPublicKeyB64 = b64;
  return key;
}

/**
 * Verifies a Bearer token and returns the verified claim set. Throws
 * `WorkerJwtError` on any failure. Caller maps to a 401 / 403 / 503
 * response per `err.status`.
 *
 * @param requiredScope The scope claim the token must have to access
 *   this endpoint. `"full"` callers reject any payment-scope token;
 *   `"payment"` callers accept both payment and full tokens (full is a
 *   superset).
 */
export async function verifyEntitlementToken(
  jwt: string | null,
  env: Env,
  requiredScope: Scope,
): Promise<VerifiedJwt> {
  if (!jwt) {
    throw new WorkerJwtError("missing Authorization Bearer JWT", "missing", 401);
  }
  const publicKey = await loadPublicKey(env);

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(jwt, publicKey, {
      algorithms: ["EdDSA"],
      issuer: EXPECTED_ISSUER,
      clockTolerance: "60s",
    });
    payload = result.payload as Record<string, unknown>;
  } catch (err: any) {
    const code = err?.code ?? "";
    if (code === "ERR_JWT_EXPIRED") {
      throw new WorkerJwtError("JWT expired", "expired", 401);
    }
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      throw new WorkerJwtError(
        `JWT claim validation failed: ${err?.message ?? ""}`,
        "bad_issuer",
        401,
      );
    }
    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
      throw new WorkerJwtError("JWT signature invalid", "bad_signature", 401);
    }
    throw new WorkerJwtError(
      `JWT verification failed: ${err?.message ?? String(err)}`,
      "malformed",
      401,
    );
  }

  const sub = String(payload.sub ?? "").toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(sub)) {
    throw new WorkerJwtError("JWT sub is not a 66-char hex pubkey", "bad_subject", 401);
  }
  const scope = payload.scope;
  if (scope !== "full" && scope !== "payment") {
    throw new WorkerJwtError(
      `JWT scope must be "full" or "payment", got: ${String(scope)}`,
      "bad_scope",
      401,
    );
  }
  // scope-required check: full > payment. A `payment`-scope token
  // calling a `full`-only endpoint is rejected with 403, not 401 —
  // the token is well-formed and authenticated, just under-scoped.
  if (requiredScope === "full" && scope === "payment") {
    throw new WorkerJwtError(
      "endpoint requires scope=full; token has scope=payment",
      "scope_insufficient",
      403,
    );
  }
  const iat = Number(payload.iat ?? 0);
  const exp = Number(payload.exp ?? 0);

  return { sub, scope, iat, exp };
}

/** Extracts a Bearer token from a Request's Authorization header. */
export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = auth.match(/^bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Convenience helper: wraps a handler with JWT enforcement at the
 * requested scope. Returns a standard 401/403/503 JSON Response on
 * failure; otherwise hands off to the wrapped handler with the
 * verified claims attached.
 */
export async function withJwtGate(
  req: Request,
  env: Env,
  requiredScope: Scope,
  handler: (verified: VerifiedJwt) => Promise<Response> | Response,
): Promise<Response> {
  try {
    const bearer = extractBearerToken(req);
    const verified = await verifyEntitlementToken(bearer, env, requiredScope);
    return await handler(verified);
  } catch (err: any) {
    if (err instanceof WorkerJwtError) {
      return new Response(
        JSON.stringify({ error: err.reason, detail: err.message }),
        {
          status: err.status,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    throw err;
  }
}
