import { CORS_HEADERS } from "../lib/cors";
import type { Env } from "../lib/types";
import { getCalendarSummary, getDayValues } from "../valuation/manualStore";

function deny(status: number, reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleManualInputDay(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return deny(400, "invalid_or_missing_date");
  }
  try {
    const metrics = await getDayValues(env.PRICES_CACHE, date);
    return ok({ date, metrics });
  } catch (err) {
    console.error("[manualInputQuery:day]", err instanceof Error ? err.message : err);
    return deny(503, "storage_failure");
  }
}

export async function handleManualInputCalendar(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return deny(400, "invalid_from");
  if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return deny(400, "invalid_to");
  try {
    const days = await getCalendarSummary(env.PRICES_CACHE, from, to);
    return ok({ from, to, days });
  } catch (err) {
    console.error("[manualInputQuery:calendar]", err instanceof Error ? err.message : err);
    return deny(503, "storage_failure");
  }
}
