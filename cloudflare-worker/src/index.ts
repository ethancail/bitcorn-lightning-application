import { handleOnramp } from "./handlers/onramp";
import { handlePrices, handleCornHistory } from "./handlers/prices";
import { handleRecommendedPeers } from "./handlers/recommendedPeers";
import { handleTreasuryInfo } from "./handlers/treasuryInfo";
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
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
      return handleOnramp(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
