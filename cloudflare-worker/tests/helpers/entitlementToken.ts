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

// EXPECTED_ISSUER, src/lib/jwt.ts:65.
const ISSUER = "bitcorn-treasury";

export interface EntitlementSigner {
  /**
   * The raw Ed25519 x coord, base64url — exactly the shape
   * `Env.SUBSCRIPTION_PUBLIC_KEY` carries and `loadPublicKey()` feeds to
   * importJWK (src/lib/jwt.ts:87-90).
   */
  publicKeyX: string;
  /** Mints a token the Worker's gate accepts at the given scope. */
  token(scope: Scope): Promise<string>;
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

  return {
    publicKeyX,
    token(scope: Scope): Promise<string> {
      return new SignJWT({ scope })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(ISSUER)
        .setSubject(MEMBER_PUBKEY)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(pair.privateKey as CryptoKey);
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
