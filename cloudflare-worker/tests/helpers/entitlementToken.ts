// Shared Ed25519 entitlement-token signer for router-level tests.
//
// Extracted from tests/baseScope.test.ts so that every test going through
// `worker.fetch` at a JWT-gated route mints tokens ONE way. Two independent
// signing helpers would drift apart, and a gate test that drifts is worse than
// no gate test — it keeps passing while asserting something the gate no longer
// does.
//
// Not named *.test.ts on purpose: vitest's default include pattern
// (**/*.{test,spec}.*) skips this file, so it is a helper module rather than an
// empty suite.
//
// Cache note: src/lib/jwt.ts memoizes the imported CryptoKey at module scope,
// keyed on the base64url public-key value. Each caller creating its own signer
// therefore invalidates that cache by construction rather than colliding with
// it — no cross-file key bleed, and no need to share one keypair globally.

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { Scope } from "../../src/lib/jwt";

// A valid `sub`: verifyEntitlementToken requires 66-char lowercase hex
// (src/lib/jwt.ts:147). This is the treasury pubkey from docker-compose.yml,
// used here only because it is a real, correctly-shaped pubkey.
export const MEMBER_PUBKEY =
  "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";

// EXPECTED_ISSUER, src/lib/jwt.ts:65. Exported so a test asserting the
// wrong-issuer rejection can say "not this" rather than hardcoding a second
// copy of the string that would not move if the Worker's expectation did.
export const ISSUER = "bitcorn-treasury";

/** Default token lifetime, matching the original `.setExpirationTime("1h")`. */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Claim overrides for minting a token the gate should REJECT.
 *
 * Added 2026-08-07 for tests/valuationScope.test.ts. Every field is optional
 * and every default reproduces exactly what `token(scope)` already produced, so
 * this is additive — no existing caller changes behavior.
 *
 * `iat`/`exp` are absolute epoch SECONDS rather than jose's relative strings,
 * because an expired-token test has to clear the Worker's `clockTolerance:
 * "60s"` (src/lib/jwt.ts:121) deliberately, and a relative string makes the
 * margin hard to see. Use EXPIRED_EXP for that.
 */
export interface TokenOverrides {
  scope?: Scope;
  /** Epoch seconds. Default: now. */
  iat?: number;
  /** Epoch seconds. Default: iat + 3600. Set in the past to mint an expired token. */
  exp?: number;
  /** Default: ISSUER. Any other value trips the gate's issuer check. */
  issuer?: string;
  /** Default: MEMBER_PUBKEY. A non-66-hex value trips the gate's `sub` check. */
  subject?: string;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * An `exp` comfortably outside the gate's 60s clock tolerance. One hour in the
 * past, not 61 seconds: a test that sits exactly at the boundary would be
 * testing the tolerance, which is a different property with its own reasons.
 */
export function expiredExp(): number {
  return nowSeconds() - DEFAULT_TTL_SECONDS;
}

export interface EntitlementSigner {
  /**
   * The raw Ed25519 x coord, base64url — exactly the shape
   * `Env.SUBSCRIPTION_PUBLIC_KEY` carries and `loadPublicKey()` feeds to
   * importJWK (src/lib/jwt.ts:87-90).
   */
  publicKeyX: string;
  /** Mints a token the Worker's gate accepts at the given scope. */
  token(scope: Scope): Promise<string>;
  /**
   * Mints a token with arbitrary claims, for the rejection paths. Signed with
   * the SAME key as `token()`, so a test using this isolates the claim it
   * varied — a wrong-issuer token still carries a valid signature, and the gate
   * must reject it for the issuer rather than incidentally for the signature.
   * (For the bad-signature path, mint from a SECOND signer instead.)
   */
  tokenWith(overrides?: TokenOverrides): Promise<string>;
}

/**
 * Generates a fresh Ed25519 keypair and returns a signer plus the public key
 * to put on the test Env. Call once per suite in `beforeAll`.
 */
export async function createEntitlementSigner(): Promise<EntitlementSigner> {
  const pair = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const jwk = await exportJWK(pair.publicKey);
  const publicKeyX = jwk.x as string;

  // Both public methods delegate here. Defined as a closure rather than a
  // method calling `this.tokenWith(...)` so a destructured `const { token } =
  // signer` still works.
  function sign(overrides: TokenOverrides = {}): Promise<string> {
    const iat = overrides.iat ?? nowSeconds();
    const exp = overrides.exp ?? iat + DEFAULT_TTL_SECONDS;
    return new SignJWT({ scope: overrides.scope ?? "full" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(overrides.issuer ?? ISSUER)
      .setSubject(overrides.subject ?? MEMBER_PUBKEY)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(pair.privateKey as CryptoKey);
  }

  return {
    publicKeyX,
    token(scope: Scope): Promise<string> {
      return sign({ scope });
    },
    tokenWith(overrides: TokenOverrides = {}): Promise<string> {
      return sign(overrides);
    },
  };
}

/**
 * Returns a copy of `req` carrying an Authorization Bearer header. Copies
 * rather than mutating so a `request()` factory can be reused across cases.
 */
export function withAuth(req: Request, jwt: string): Request {
  const authed = new Request(req, { headers: new Headers(req.headers) });
  authed.headers.set("Authorization", `Bearer ${jwt}`);
  return authed;
}
