// Server-side JWT verification (treasury and member routes that
// accept an entitlement token, e.g., /api/subscription/status).
//
// Uses the treasury's own keypair via `getTreasurySigningKeypair()`.
// This is the same keypair the Worker validates against (Cloudflare
// holds the public-key half).
//
// Stage 4 wires only /api/subscription/status to this verifier; the
// Worker has its own copy of the validation logic in
// `cloudflare-worker/src/lib/jwt.ts`. The two implementations are
// intentionally separate — the Worker can't `require()` Node modules
// — but they must validate the same way (alg=EdDSA, iss check, exp
// check, sub format check).

import { jwtVerify } from "jose";
import { getTreasurySigningKeypair } from "./treasuryKeypair";

export interface VerifiedJwt {
  sub: string;           // member pubkey (lowercase hex)
  scope: "full" | "prepay";
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
      | "bad_scope",
  ) {
    super(message);
    this.name = "JwtVerificationError";
  }
}

const EXPECTED_ISSUER = "bitcorn-treasury";

/**
 * Verifies a Bearer JWT and returns the verified claim set. Throws
 * `JwtVerificationError` on any failure. Clock skew tolerance is the
 * jose default (10s); spec recommends ±60s but the jose default is
 * fine for our 24h-lifetime tokens.
 */
export async function verifyEntitlementToken(jwt: string): Promise<VerifiedJwt> {
  if (!jwt || typeof jwt !== "string") {
    throw new JwtVerificationError("missing JWT", "missing");
  }
  const kp = await getTreasurySigningKeypair();

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(jwt, kp.publicKey, {
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
  if (scope !== "full" && scope !== "prepay") {
    throw new JwtVerificationError(
      `JWT scope must be "full" or "prepay", got: ${String(scope)}`,
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
