// Bitcorn Lightning — Cloudflare Worker (thin router).
//
// Endpoints:
//   POST /                    — Coinbase Onramp session token (handlers/onramp.ts)
//   GET  /prices              — Commodity futures prices (handlers/prices.ts)
//   GET  /prices/corn-history — Historical monthly corn prices (handlers/prices.ts)
//   GET  /recommended-peers   — Curated external peer list (handlers/recommendedPeers.ts)
//   GET  /treasury-info       — Treasury node connection info (handlers/treasuryInfo.ts)
//   GET  /valuation/current   — Latest composite Z-score + zone (handlers/valuation.ts)
//   GET  /valuation/history   — Daily composite history series (handlers/valuation.ts)
//   GET  /valuation/inputs    — Per-input snapshot map (handlers/valuation.ts)
//   POST /valuation/manual    — Treasury-signed manual metric entries (HMAC; handlers/manualInput.ts)
//   GET  /valuation/manual/day      — Read all 8 metric values for a date (handlers/manualInputQuery.ts)
//   GET  /valuation/manual/calendar — Per-day completeness summary across a range (handlers/manualInputQuery.ts)
//   POST /valuation/refresh   — Manually trigger the engine cron (HMAC; handlers/refresh.ts)
//
// Deploy runbook, secret management, and architecture: docs/COINBASE_INTEGRATION.md.
// Valuation engine runs on cron (wrangler.toml [triggers]); see valuation/cron.ts.

import { handleOnramp } from "./handlers/onramp";
import { handlePrices, handleCornHistory } from "./handlers/prices";
import { handleRecommendedPeers } from "./handlers/recommendedPeers";
import { handleTreasuryInfo } from "./handlers/treasuryInfo";
import {
  handleValuationCurrent,
  handleValuationHistory,
  handleValuationInputs,
} from "./handlers/valuation";
import { handleManualInput } from "./handlers/manualInput";
import { handleManualInputCalendar, handleManualInputDay } from "./handlers/manualInputQuery";
import { handleValuationRefresh } from "./handlers/refresh";
import { handleScheduled } from "./valuation/cron";
import { CORS_HEADERS } from "./lib/cors";
import { withJwtGate } from "./lib/jwt";
import type { Env } from "./lib/types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── PUBLIC endpoints (setup-flow, no token required) ───────────
    // Members need these BEFORE they have any entitlement token.
    if (request.method === "GET" && url.pathname === "/recommended-peers") {
      return handleRecommendedPeers();
    }
    if (request.method === "GET" && url.pathname === "/treasury-info") {
      return handleTreasuryInfo(env);
    }

    // ── HMAC-gated endpoints (treasury-only writes, unchanged) ────
    // Per spec §6.6 "The existing HMAC-signed manual-input contract
    // (treasury → Worker) is untouched; member auth is a new
    // orthogonal mechanism."
    if (request.method === "POST" && url.pathname === "/valuation/manual") {
      return handleManualInput(request, env);
    }
    if (request.method === "POST" && url.pathname === "/valuation/refresh") {
      return handleValuationRefresh(request, env);
    }

    // ── PREPAY-scope endpoints (Onramp + commodity prices) ────────
    // scope=prepay tokens are sufficient; scope=full tokens are also
    // accepted (full is a superset).
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
      return withJwtGate(request, env, "prepay", () => handleOnramp(request, env));
    }
    if (request.method === "GET" && url.pathname === "/prices") {
      return withJwtGate(request, env, "prepay", () => handlePrices(env));
    }
    if (request.method === "GET" && url.pathname === "/prices/corn-history") {
      return withJwtGate(request, env, "prepay", () => handleCornHistory(env));
    }

    // ── FULL-scope endpoints (valuation reads) ────────────────────
    // scope=prepay tokens are rejected with 403; scope=full required.
    if (request.method === "GET" && url.pathname === "/valuation/current") {
      return withJwtGate(request, env, "full", () => handleValuationCurrent(env));
    }
    if (request.method === "GET" && url.pathname === "/valuation/history") {
      return withJwtGate(request, env, "full", () => handleValuationHistory(env, url));
    }
    if (request.method === "GET" && url.pathname === "/valuation/inputs") {
      return withJwtGate(request, env, "full", () => handleValuationInputs(env));
    }
    if (request.method === "GET" && url.pathname === "/valuation/manual/day") {
      return withJwtGate(request, env, "full", () => handleManualInputDay(request, env));
    }
    if (request.method === "GET" && url.pathname === "/valuation/manual/calendar") {
      return withJwtGate(request, env, "full", () => handleManualInputCalendar(request, env));
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};
