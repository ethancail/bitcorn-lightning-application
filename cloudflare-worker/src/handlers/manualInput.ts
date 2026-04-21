import { CORS_HEADERS } from "../lib/cors";
import { verifyHmac } from "../lib/hmac";
import type { Env } from "../lib/types";
import { appendManualSubmission, MANUAL_METRIC_KEYS, type ManualValues } from "../valuation/manualStore";

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function deny(status: number, reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleManualInput(request: Request, env: Env): Promise<Response> {
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

  let parsed: { submitted_at?: string; values?: Partial<ManualValues> };
  try {
    parsed = JSON.parse(body);
  } catch {
    return deny(400, "invalid_json");
  }

  if (!parsed.submitted_at || typeof parsed.submitted_at !== "string") {
    return deny(400, "submitted_at_required");
  }
  if (!parsed.values || typeof parsed.values !== "object") {
    return deny(400, "values_required");
  }

  const values: Partial<ManualValues> = parsed.values;
  for (const k of MANUAL_METRIC_KEYS) {
    const v = values[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return deny(400, `invalid_value_for_${k}`);
    }
  }

  try {
    await appendManualSubmission(env.PRICES_CACHE, parsed.submitted_at, values as ManualValues);
  } catch (err) {
    console.error("[manualInput] append failed:", err instanceof Error ? err.message : err);
    return deny(503, "storage_failure");
  }

  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
