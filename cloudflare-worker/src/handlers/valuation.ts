import { CORS_HEADERS } from "../lib/cors";
import type { Env } from "../lib/types";
import {
  loadCurrent,
  loadHistory,
  loadInputs,
} from "../valuation/persist";

export async function handleValuationCurrent(env: Env): Promise<Response> {
  const cv = await loadCurrent(env.PRICES_CACHE);
  if (!cv) {
    return new Response(JSON.stringify({ error: "no_valuation_data" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  return new Response(JSON.stringify(cv), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleValuationHistory(env: Env, url: URL): Promise<Response> {
  const since = url.searchParams.get("since"); // yyyy-mm-dd
  const until = url.searchParams.get("until");
  let rows = await loadHistory(env.PRICES_CACHE);
  if (since) rows = rows.filter((r) => r.date >= since);
  if (until) rows = rows.filter((r) => r.date <= until);
  return new Response(JSON.stringify({ series: rows }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleValuationInputs(env: Env): Promise<Response> {
  const snap = await loadInputs(env.PRICES_CACHE);
  return new Response(JSON.stringify(snap), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
