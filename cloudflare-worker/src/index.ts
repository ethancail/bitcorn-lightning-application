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
//   ─── Stablecoin rail (per spec §5) ───
//   GET  /base/contract-info  — Public; SettlementRouter address + live state (handlers/base.ts)
//   POST /base/contract-state — FULL-scope; allowlisted ABI read wrapper (handlers/base.ts)
//   GET  /base/balance        — FULL-scope; convenience ERC-20 balanceOf (handlers/base.ts)
//   POST /base/events         — FULL-scope; allowlisted eth_getLogs wrapper (handlers/base.ts)
//   (the three gated reads moved payment→full when the rail became a
//    subscription benefit — see the rationale block at the route definitions)
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
import {
  handleBaseBalance,
  handleBaseContractInfo,
  handleBaseContractState,
  handleBaseEvents,
} from "./handlers/base";
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
    // /base/contract-info is public per spec §5.2: contract addresses and
    // live fee/pause state are on-chain-public anyway, and members need
    // them for sync before they hold any entitlement token.
    if (request.method === "GET" && url.pathname === "/base/contract-info") {
      return handleBaseContractInfo(env);
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

    // ── SUBSCRIBER-BASE endpoints (Onramp + commodity prices) ─────
    // Per decisions/2026-05-11-subscription-stage-5a-architectural-
    // deltas.md decision #1: these endpoints serve the recovery path
    // (Onramp lets a lapsed member acquire BTC to renew; prices give
    // them the BTC/USD context to size the purchase), so any valid
    // subscriber token is accepted — payment-scope (prepay + all
    // lapsed tiers) and full-scope (current) both work.
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
      return withJwtGate(request, env, "payment", () => handleOnramp(request, env));
    }
    if (request.method === "GET" && url.pathname === "/prices") {
      return withJwtGate(request, env, "payment", () => handlePrices(env));
    }
    if (request.method === "GET" && url.pathname === "/prices/corn-history") {
      return withJwtGate(request, env, "payment", () => handleCornHistory(env));
    }
    // ── BASE state-read endpoints: FULL scope (the stablecoin rail is a
    //    subscription benefit) ───────────────────────────────────────
    //
    // SUPERSEDES the original payment-scope placement, which read:
    // "Recovery-path-adjacent — lapsed members must be able to see their USDC
    // balances to decide whether to renew." That rationale is deliberately
    // retired. The rail is a subscription benefit: available to nodes that are
    // `current`, blocked for every lapsed tier and for never-paid nodes past
    // their fresh-grace window.
    //
    // Why `full` is what the tier ladder already implies: these reads ARE a
    // hosted service (the Worker's RPC budget, its Alchemy key, its cache), and
    // the ladder lapses hosted services at +7 days (`worker_lapsed`).
    // Payment-scope was the exception here, not the rule.
    //
    // Blocking traps nobody's funds. The rail is non-custodial: USDC balances
    // are on-chain public, and a lapsed member can transact against the
    // SettlementRouter directly (the app says so itself — see the web app's
    // RailErrorBanner "Why?" copy). What lapses is Bitcorn's *view* of the
    // chain, not the member's access to it.
    //
    // ⚠ FRESH-GRACE ACCESS IS INTENDED, NOT AN OVERSIGHT. A never-paid node
    // inside its 30-day `grace_days_fresh` window (migration 042) computes to
    // tier `current` and therefore holds a full-scope token, so it reaches
    // these endpoints. That is the decision, for three reasons:
    //   1. The rail is revenue-generating per settlement. At the launch rate of
    //      25 bps a fresh-grace member pays BitCorn on every transaction, so
    //      trial access produces fee revenue rather than freeloading.
    //   2. The 30-day window runs from `subscription.created_at`, written on
    //      first token request. Every existing member's row is already old, so
    //      an existing never-paid node sits at `prepay` and IS blocked. Fresh
    //      grace reaches only genuinely new nodes — the trial case it was
    //      built for.
    //   3. Blocking trial members would re-create the "pay first to evaluate
    //      whether you want to pay" loop that migration 042 exists to remove.
    // Scope alone cannot express "paid only": paid-`current` and
    // fresh-grace-`current` are the same tier string and mint identical
    // full-scope tokens. Excluding trials needs a new scope or JWT claim —
    // a separate arc, deliberately not built here.
    //
    // ⚠ KNOWN CONSEQUENCE, accepted: `worker_lapsed` fires at +7 days past
    // `paid_through`. A PAYING merchant 8 days late on a 50,000-sat
    // subscription therefore loses the ability to send a six-figure grain
    // settlement — the send path needs `routerAddress`, which comes from the
    // API's contract-state cache, which is populated via the payment-scoped
    // `feeRecipient()` read below. The +7-day threshold was sized for
    // Lightning-side hosted services (prices, valuation, Onramp) where losing
    // access is proportionate; losing settlement capability over a ~$40 late
    // payment is a different proportion, and the ladder never contemplated it.
    // Shipping +7 anyway: the cohort is small and trusted, it would be noticed
    // fast, and the fix is a one-line scope change. Revisit if it bites.
    if (request.method === "POST" && url.pathname === "/base/contract-state") {
      return withJwtGate(request, env, "full", () => handleBaseContractState(request, env));
    }
    if (request.method === "GET" && url.pathname === "/base/balance") {
      return withJwtGate(request, env, "full", () => handleBaseBalance(request, env));
    }
    if (request.method === "POST" && url.pathname === "/base/events") {
      return withJwtGate(request, env, "full", () => handleBaseEvents(request, env));
    }

    // ── TIER-GATED endpoints (valuation reads) ────────────────────
    // payment-scope tokens are rejected with 403; only `current`-tier
    // members hold full-scope tokens, so these endpoints are limited
    // to actively-paid subscribers. Consumed services, not recovery
    // paths.
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
