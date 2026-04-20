import { CORS_HEADERS } from "../lib/cors";
import type { Env } from "../lib/types";

export function handleTreasuryInfo(env: Env): Response {
  const pubkey = env.TREASURY_PUBKEY || null;
  const socket = env.TREASURY_SOCKET || null;
  return Response.json({ pubkey, socket }, { headers: CORS_HEADERS });
}
