import { CORS_HEADERS } from "../lib/cors";
import { verifyHmac } from "../lib/hmac";
import type { Env } from "../lib/types";
import { handleScheduled } from "../valuation/cron";

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function deny(status: number, reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// POST /valuation/refresh — manually trigger the engine that the cron
// runs nightly. Same HMAC + timestamp-skew auth as /valuation/manual.
// Used after deploys that change adapter logic, when waiting for the
// next 00:15 UTC scheduled run isn't acceptable.
export async function handleValuationRefresh(request: Request, env: Env): Promise<Response> {
  const secret = env.VALUATION_SUBMIT_HMAC;
  if (!secret) return deny(401, "valuation_submit_hmac_not_configured");

  const timestampHeader = request.headers.get("X-Valuation-Timestamp");
  const signature = request.headers.get("X-Valuation-Signature");
  if (!timestampHeader || !signature) return deny(401, "missing_signature_headers");

  const parsedTs = Date.parse(timestampHeader);
  if (!Number.isFinite(parsedTs)) return deny(401, "invalid_timestamp_header");
  if (Math.abs(Date.now() - parsedTs) > MAX_TIMESTAMP_SKEW_MS) return deny(401, "timestamp_skew_too_large");

  const body = await request.text();
  const ok = await verifyHmac(secret, timestampHeader, body, signature);
  if (!ok) return deny(401, "signature_mismatch");

  try {
    await handleScheduled(env);
  } catch (err) {
    console.error("[valuation-refresh] runEngine failed:", err instanceof Error ? err.message : err);
    return deny(503, "engine_failed");
  }
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
