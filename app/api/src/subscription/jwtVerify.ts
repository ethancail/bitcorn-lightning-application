// Server-side JWT verification (treasury and member routes that
// accept an entitlement token, e.g., /api/subscription/status).
//
// Source of truth:
//   - bitcorn-research/specs/2026-05-11-subscription-stage-5a-jwt-fix-
//     and-member-ui.md §4 (publication mechanism + member-side cache
//     + self-heal on bad_signature)
//   - bitcorn-research/decisions/2026-05-11-jwt-validation-key-
//     publication.md (locks the 5 mechanism details)
//   - bitcorn-research/decisions/2026-05-11-subscription-stage-4-
//     architectural-deltas.md decision #2 (the bug this fixes)
//
// Disambiguation (spec §4.3):
//   - On the treasury node, the local keypair IS the signing key —
//     validating against it is the source-of-truth path.
//   - On member nodes, the local keypair is a different lazily-
//     generated keypair that has NO relationship to the treasury's
//     signing key. Members must validate against the cached JWK from
//     the Worker's /treasury-info endpoint instead.
//
// The role check uses `localPubkey === ENV.treasuryPubkey`, read from
// the lnd_node_info singleton row (populated by the sync loop on first
// iteration, ~10s after API boot). The local pubkey doesn't change
// post-boot so we cache it at module level after the first read.
//
// Self-heal (spec §4.4): when a cached-JWK validation returns
// bad_signature, we trigger an out-of-band /treasury-info re-fetch via
// forceTreasuryInfoFetch() (rate-limited to ≤1/30s in tokenRefresh.ts)
// and retry validation once with the fresh JWK. If still bad_signature,
// the failure is real (treasury rotated and Worker secret is stale, or
// the token was forged).

import { jwtVerify, importJWK } from "jose";
import type { JWK, KeyLike } from "jose";
import { db } from "../db";
import { ENV } from "../config/env";
import { getTreasurySigningKeypair } from "./treasuryKeypair";
import { forceTreasuryInfoFetch } from "./tokenRefresh";

export interface VerifiedJwt {
  sub: string;           // member pubkey (lowercase hex)
  scope: "full" | "payment";
  iat: number;
  exp: number;
}

export class JwtVerificationError extends Error {
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
      | "no_treasury_key",
  ) {
    super(message);
    this.name = "JwtVerificationError";
  }
}

const EXPECTED_ISSUER = "bitcorn-treasury";

// Module-level cache of the local pubkey. Populated lazily on first
// verify call. The local pubkey is LND's node identity — immutable for
// the lifetime of the container.
let cachedLocalPubkey: string | null = null;

function getLocalPubkey(): string | null {
  if (cachedLocalPubkey !== null) return cachedLocalPubkey || null;
  const row = db
    .prepare(`SELECT pubkey FROM lnd_node_info WHERE id = 1`)
    .get() as { pubkey?: string } | undefined;
  cachedLocalPubkey = (row?.pubkey ?? "").toLowerCase();
  return cachedLocalPubkey || null;
}

function isTreasuryNode(): boolean {
  const local = getLocalPubkey();
  const treasury = (ENV.treasuryPubkey ?? "").toLowerCase();
  return !!local && !!treasury && local === treasury;
}

// Per-process cache of the imported CryptoKey, keyed on the JWK string
// from subscription_local_token.treasury_public_key_jwk. Invalidates
// automatically when the operator rotates the Worker secret and the
// member-side cache refreshes.
let cachedJwkString: string | null = null;
let cachedPublicKey: KeyLike | null = null;

async function loadMemberSidePublicKey(): Promise<KeyLike | null> {
  const row = db
    .prepare(
      `SELECT treasury_public_key_jwk
       FROM subscription_local_token WHERE id = 1`,
    )
    .get() as { treasury_public_key_jwk?: string | null } | undefined;
  const jwkStr = row?.treasury_public_key_jwk ?? null;
  if (!jwkStr) return null;
  if (cachedPublicKey && cachedJwkString === jwkStr) return cachedPublicKey;
  try {
    const jwk = JSON.parse(jwkStr) as JWK;
    const key = (await importJWK(jwk, "EdDSA")) as KeyLike;
    cachedJwkString = jwkStr;
    cachedPublicKey = key;
    return key;
  } catch {
    return null;
  }
}

/**
 * Verifies a Bearer JWT and returns the verified claim set. Throws
 * `JwtVerificationError` on any failure.
 *
 * Treasury vs member dispatch happens transparently: on treasury nodes
 * the local signing keypair is used; on member nodes the cached JWK
 * fetched from the Worker's /treasury-info endpoint is used (with
 * self-heal on bad_signature).
 */
export async function verifyEntitlementToken(jwt: string): Promise<VerifiedJwt> {
  if (!jwt || typeof jwt !== "string") {
    throw new JwtVerificationError("missing JWT", "missing");
  }

  const onTreasury = isTreasuryNode();

  if (onTreasury) {
    const kp = await getTreasurySigningKeypair();
    return await verifyWithKey(jwt, kp.publicKey);
  }

  // Member-node path.
  let publicKey = await loadMemberSidePublicKey();
  if (!publicKey) {
    // Cold cache. Force a /treasury-info fetch (rate-limited inside
    // forceTreasuryInfoFetch) and retry the cache read once.
    await forceTreasuryInfoFetch();
    publicKey = await loadMemberSidePublicKey();
    if (!publicKey) {
      throw new JwtVerificationError(
        "treasury public key not cached and could not be fetched",
        "no_treasury_key",
      );
    }
  }

  try {
    return await verifyWithKey(jwt, publicKey);
  } catch (err) {
    if (err instanceof JwtVerificationError && err.reason === "bad_signature") {
      // Self-heal: cached key didn't match. Common case is that the
      // treasury operator just rotated and republished, and this
      // member's 12h refresh hasn't run yet.
      await forceTreasuryInfoFetch();
      const refreshedKey = await loadMemberSidePublicKey();
      // If the cache didn't change we'd refuse the same signature
      // again; comparing the key reference is sufficient — same
      // JWK string yields the same cached CryptoKey above.
      if (refreshedKey && refreshedKey !== publicKey) {
        return await verifyWithKey(jwt, refreshedKey);
      }
    }
    throw err;
  }
}

async function verifyWithKey(
  jwt: string,
  publicKey: KeyLike,
): Promise<VerifiedJwt> {
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
      throw new JwtVerificationError("JWT expired", "expired");
    }
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      throw new JwtVerificationError(
        `JWT claim validation failed: ${err?.message ?? ""}`,
        "bad_issuer",
      );
    }
    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
      throw new JwtVerificationError("JWT signature invalid", "bad_signature");
    }
    throw new JwtVerificationError(
      `JWT verification failed: ${err?.message ?? String(err)}`,
      "malformed",
    );
  }

  const sub = String(payload.sub ?? "").toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(sub)) {
    throw new JwtVerificationError("JWT sub is not a 66-char hex pubkey", "bad_subject");
  }
  const scope = payload.scope;
  if (scope !== "full" && scope !== "payment") {
    throw new JwtVerificationError(
      `JWT scope must be "full" or "payment", got: ${String(scope)}`,
      "bad_scope",
    );
  }
  const iat = Number(payload.iat ?? 0);
  const exp = Number(payload.exp ?? 0);

  return { sub, scope, iat, exp };
}

/**
 * Extracts a Bearer JWT from an Authorization header. Returns null if
 * the header is missing or not a Bearer. Lowercases the scheme for
 * tolerance.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader || typeof authHeader !== "string") return null;
  const match = authHeader.match(/^bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim();
}
