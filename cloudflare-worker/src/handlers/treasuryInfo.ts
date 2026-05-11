import { CORS_HEADERS } from "../lib/cors";
import type { Env } from "../lib/types";

// Public endpoint — members fetch this before they have any entitlement
// token. Returns the treasury's Lightning identity (pubkey + socket,
// existing behavior) plus the HTTP API URL for subscription-token
// discovery (new in v1.14.1). `api_url` is null if the treasury
// operator hasn't published it via `wrangler secret put TREASURY_API_URL`
// yet — members then fall back to their local TREASURY_API_URL env or
// operate without a token.
export function handleTreasuryInfo(env: Env): Response {
  const pubkey = env.TREASURY_PUBKEY || null;
  const socket = env.TREASURY_SOCKET || null;
  const api_url = env.TREASURY_API_URL || null;
  return Response.json({ pubkey, socket, api_url }, { headers: CORS_HEADERS });
}
