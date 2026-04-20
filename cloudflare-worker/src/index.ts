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
import { handleScheduled } from "./valuation/cron";
import { CORS_HEADERS } from "./lib/cors";
import type { Env } from "./lib/types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/recommended-peers") {
      return handleRecommendedPeers();
    }
    if (request.method === "GET" && url.pathname === "/treasury-info") {
      return handleTreasuryInfo(env);
    }
    if (request.method === "GET" && url.pathname === "/prices/corn-history") {
      return handleCornHistory(env);
    }
    if (request.method === "GET" && url.pathname === "/prices") {
      return handlePrices(env);
    }
    if (request.method === "GET" && url.pathname === "/valuation/current") {
      return handleValuationCurrent(env);
    }
    if (request.method === "GET" && url.pathname === "/valuation/history") {
      return handleValuationHistory(env, url);
    }
    if (request.method === "GET" && url.pathname === "/valuation/inputs") {
      return handleValuationInputs(env);
    }
    if (request.method === "POST" && url.pathname === "/valuation/manual") {
      return handleManualInput(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
      return handleOnramp(request, env);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};
