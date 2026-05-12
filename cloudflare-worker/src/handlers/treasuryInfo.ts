import { CORS_HEADERS } from "../lib/cors";
import type { Env } from "../lib/types";

// Public endpoint — members fetch this before they have any entitlement
// token. Returns the treasury's Lightning identity (pubkey + socket,
// existing behavior), the HTTP API URL for subscription-token discovery
// (v1.14.1), and the treasury's Ed25519 public key in JWK form so
// member nodes can validate JWT signatures locally without a cross-node
// round trip (v1.14.2, Stage 5a).
//
// Implementation note: SUBSCRIPTION_PUBLIC_KEY is stored as the raw
// base64url-encoded `x` value (matching what the Worker's JWT verifier
// in lib/jwt.ts feeds into importJWK). We materialize the full JWK
// object here for the published response — that's what member-side
// jose consumers expect. The external contract is the JWK JSON shape;
// how the Worker stores the secret is implementation detail.
//
// Fields are `null` when the corresponding secret isn't set. Members
// gracefully fall back: missing api_url → use local TREASURY_API_URL
// env or cross-node validation; missing subscription_public_key → fall
// back to treasury-side JWT validation (cross-node).
export function handleTreasuryInfo(env: Env): Response {
  const pubkey = env.TREASURY_PUBKEY || null;
  const socket = env.TREASURY_SOCKET || null;
  const api_url = env.TREASURY_API_URL || null;
  const subscription_public_key = env.SUBSCRIPTION_PUBLIC_KEY
    ? { kty: "OKP", crv: "Ed25519", x: env.SUBSCRIPTION_PUBLIC_KEY }
    : null;
  return Response.json(
    { pubkey, socket, api_url, subscription_public_key },
    { headers: CORS_HEADERS },
  );
}
