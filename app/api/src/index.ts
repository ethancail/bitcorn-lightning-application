import http from "http";
import { PORTS } from "./config/ports";
import { initDb, db } from "./db";
import { runMigrations } from "./db/migrate";
import { persistNodeInfo } from "./lightning/persist";
import { syncLndState } from "./lightning/sync";
import { payInvoice } from "./lightning/pay";
import { assertActiveMember } from "./utils/membership";
import { assertRateLimit } from "./utils/rate-limit";
import { insertOutboundPayment } from "./lightning/persist-payments";
import { decodePaymentRequest, getNode } from "ln-service";
import { getChannels, getPeers, getNodeInfo } from "./api/read";
import { getTreasuryMetrics } from "./api/treasury";
import { getChannelMetrics } from "./api/treasury-channel-metrics";
import { getPeerScores } from "./api/treasury-peer-scoring";
import { computeDynamicFeeAdjustments, logChannelFeeAdjustments } from "./api/treasury-dynamic-fees";
import { applyDynamicFees } from "./lightning/fees";
import {
  getRotationCandidates,
  createRotationExecution,
  updateRotationExecution,
  getRotationExecutions,
} from "./api/treasury-rotation";
import { getTreasuryAlerts } from "./api/treasury-alerts";
import {
  getRecommendations as getLiquidityRecommendations,
  getEstimateForRecommendation,
  approveRecommendation,
  rejectRecommendation,
  getOutcomes as getLiquidityOutcomes,
  getOutcomeById as getLiquidityOutcomeById,
} from "./memberLiquidity/liquidityRoutes";
import { getAllClusterStates } from "./rebalance/clusterState";
import { assertDailyLossCapNotExceeded, DailyLossCapError } from "./utils/loss-cap";
import {
  getTreasuryFeePolicy,
  setTreasuryFeePolicy,
  markTreasuryFeePolicyApplied,
} from "./api/treasury-fee-policy";
import { getLiquidityHealth } from "./api/treasury-liquidity-health";
import {
  generateExpansionRecommendations,
  saveExpansionRecommendations,
  createExpansionExecution,
  updateExpansionExecution,
  getExpansionExecution,
} from "./api/treasury-expansion";
import {
  getCapitalPolicy,
  setCapitalPolicy,
} from "./api/treasury-capital-policy";
import {
  assertCanExpand,
  CapitalGuardrailError,
} from "./utils/capital-guardrails";
import { getLndClient, getLndChainBalance, getLndPendingChainBalance, getLndChainTransactions, getLndPeers, getLndChannels, getLndPendingChannels, openTreasuryChannel, closeTreasuryChannel, connectToPeer, createLndChainAddress, isKeysendEnabled } from "./lightning/lnd";
import { ENV } from "./config/env";
import { applyTreasuryFeePolicy } from "./lightning/fees";
import { assertTreasury } from "./utils/role";
import { executeCircularRebalance, CircularRebalanceError } from "./lightning/rebalance-circular";
import { getRebalanceExecutions } from "./api/treasury-rebalance-executions";
import { getCoinbaseSessionToken } from "./api/coinbase-onramp";
import { isLoopAvailable, getLoopOutTerms, getLoopOutQuote } from "./lightning/loop";
import { executeLoopOut, autoLoopOutRebalance, LoopOutError } from "./lightning/rebalance-loop";
import { startRebalanceScheduler } from "./lightning/rebalance-scheduler";
import { startClusterRebalanceScheduler } from "./rebalance/rebalanceScheduler";
import {
  getBtcExchangeRate,
  createPaymentInvoice,
  payNetworkInvoice,
  getNetworkPayments,
  syncNetworkInvoiceSettlements,
  decodeInvoice,
} from "./lightning/network-payments";
import {
  getLiquidityStatus as getMemberLiquidityStatus,
  getLiquidityHistory as getMemberLiquidityHistory,
} from "./memberAdvisor/liquidityAdvisorRoutes";
import { startMemberAdvisorScheduler } from "./memberAdvisor/advisorScheduler";
import {
  handleMemberLoopOutQuote,
  handleMemberLoopOut,
  handleGetSwap,
  handleSwapHistory,
  handleAdminLoopOutQuote,
  handleAdminLoopOut,
  handleAdminSwapList,
  handleAdminGetSwap,
} from "./swaps/swapRoutes";
import { startSwapPoller } from "./swaps/swapPoller";

initDb();
runMigrations();

persistNodeInfo().catch(err => {
  console.warn("[lnd] unable to persist node info:", err.message);
});

(async () => {
  try {
    await syncLndState();
    console.log("[lnd] initial sync complete");
  } catch (err: any) {
    console.warn("[lnd] initial sync failed:", err?.message ?? String(err), err?.details ?? "", err?.code ?? "");
  }

  setInterval(() => {
    syncLndState().catch(err =>
      console.warn("[lnd] periodic sync failed:", err?.message ?? String(err), err?.details ?? "", err?.code ?? "")
    );
  }, 15000);
})();

const server = http.createServer(async (req, res) => {
  // CORS — allow private/local network origins (Umbrel, Tailscale, LAN, localhost)
  // Umbrel apps are only reachable on local/private networks, not the public internet.
  const origin = req.headers.origin;
  if (!origin) {
    // No Origin header = same-origin or non-browser client — always allow
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    // Allow: localhost, private RFC1918, CGNAT/Tailscale (100.64-127.*), .local mDNS
    const host = origin.replace(/^https?:\/\//, "").split(":")[0];
    const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
    const isPrivate = host.startsWith("10.") || host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    const isTailscale = host.startsWith("100.") && (() => {
      const second = parseInt(host.split(".")[1], 10);
      return second >= 64 && second <= 127; // CGNAT range used by Tailscale
    })();
    if (isLocal || isPrivate || isTailscale) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    // Public origins get no Access-Control-Allow-Origin → browser blocks them
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  
  if (req.url === "/health") {
    try {
      db.prepare("SELECT 1").get();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", db: "ok" }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", db: "error" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/lnd/sync") {
    try {
      const result = await syncLndState();

      if (!result.ok) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/node") {
    try {
      const data = getNodeInfo();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data ?? {}));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed_to_fetch_node" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/node/balances") {
    try {
      const { chain_balance } = await getLndChainBalance();
      const row = db
        .prepare("SELECT COALESCE(SUM(local_balance_sat), 0) as total FROM lnd_channels WHERE active = 1")
        .get() as { total: number };
      const onchain_sats = chain_balance ?? 0;
      const lightning_sats = row?.total ?? 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        onchain_sats,
        lightning_sats,
        total_sats: onchain_sats + lightning_sats,
      }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "failed_to_fetch_balances" }));
    }
    return;
  }

  // Public — generates a fresh on-chain address for receiving bitcoin deposits.
  if (req.method === "GET" && req.url === "/api/node/address") {
    try {
      const { address } = await createLndChainAddress();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ address }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "failed_to_generate_address" }));
    }
    return;
  }

  // Public — on-chain balance and recent deposit transactions from LND.
  // No role gate: both treasury and member nodes need deposit visibility.
  if (req.method === "GET" && req.url === "/api/node/onchain-status") {
    try {
      const [{ chain_balance }, { pending_chain_balance }, { transactions }] = await Promise.all([
        getLndChainBalance(),
        getLndPendingChainBalance(),
        getLndChainTransactions(),
      ]);

      // Filter to incoming transactions, most recent first, cap at 20
      const recent_deposits = transactions
        .filter((tx) => !tx.is_outgoing)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 20)
        .map((tx) => ({
          tx_hash: tx.id,
          amount_sat: tx.tokens,
          confirmations: tx.confirmation_count ?? 0,
          is_confirmed: tx.is_confirmed,
          block_height: tx.confirmation_height ?? null,
          time_stamp: tx.created_at,
        }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        confirmed_balance_sat: chain_balance ?? 0,
        pending_balance_sat: pending_chain_balance ?? 0,
        recent_deposits,
      }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "failed_to_fetch_onchain_status" }));
    }
    return;
  }

  // Public — accessible to both treasury and member nodes.
  // No role gate: both roles need on-chain funding capability.
  if (req.method === "GET" && req.url === "/api/coinbase/onramp-url") {
    try {
      if (!ENV.coinbaseAppId || !ENV.coinbaseWorkerUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "coinbase_not_configured" }));
        return;
      }
      const { address } = await createLndChainAddress();
      const node = getNodeInfo();

      const sessionToken = await getCoinbaseSessionToken(
        ENV.coinbaseWorkerUrl,
        address
      );
      const url =
        `https://pay.coinbase.com/buy/select-asset` +
        `?appId=${encodeURIComponent(ENV.coinbaseAppId)}` +
        `&sessionToken=${encodeURIComponent(sessionToken)}`;

      db.prepare(
        "INSERT INTO coinbase_onramp_sessions (node_pubkey, wallet_address, onramp_url, created_at) VALUES (?, ?, ?, ?)"
      ).run(node?.pubkey ?? "", address, url, Date.now());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url, wallet_address: address }));
    } catch (err) {
      console.error("[coinbase onramp]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "failed_to_generate_onramp_url" }));
    }
    return;
  }

  // Public — commodity prices proxied from Cloudflare Worker (KV-cached)
  if (req.method === "GET" && req.url === "/api/commodity-prices") {
    try {
      const workerUrl = ENV.coinbaseWorkerUrl;
      if (!workerUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "commodity_prices_not_configured" }));
        return;
      }
      const response = await fetch(`${workerUrl}/prices`);
      if (!response.ok) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "commodity_prices_unavailable" }));
        return;
      }
      const data = await response.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[commodity-prices]", err);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "commodity_prices_unavailable" }));
    }
    return;
  }

  // Public — historical corn prices proxied from Cloudflare Worker
  if (req.method === "GET" && req.url === "/api/corn-history") {
    try {
      const workerUrl = ENV.coinbaseWorkerUrl;
      if (!workerUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "worker_not_configured" }));
        return;
      }
      const response = await fetch(`${workerUrl}/prices/corn-history`);
      if (!response.ok) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "corn_history_unavailable" }));
        return;
      }
      const data = await response.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[corn-history]", err);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "corn_history_unavailable" }));
    }
    return;
  }

  // Public — treasury connection info proxied from Cloudflare Worker
  if (req.method === "GET" && req.url === "/api/treasury-info") {
    try {
      const workerUrl = ENV.coinbaseWorkerUrl;
      if (!workerUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "worker_not_configured" }));
        return;
      }
      const response = await fetch(`${workerUrl}/treasury-info`);
      if (!response.ok) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "treasury_info_unavailable" }));
        return;
      }
      const data = await response.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[treasury-info]", err);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "treasury_info_unavailable" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/peers") {
    try {
      const data = getPeers();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed_to_fetch_peers" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/channels") {
    try {
      const data = getChannels();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed_to_fetch_channels" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/channels/pending") {
    try {
      const { pending_channels } = await getLndPendingChannels();
      const all = (pending_channels ?? []).map((ch) => ({
        peer_pubkey: ch.partner_public_key,
        capacity_sat: ch.capacity,
        status: ch.is_opening ? "opening" : ch.is_closing ? "closing" : "pending",
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(all));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "failed_to_fetch_pending" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/metrics") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const data = getTreasuryMetrics();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_metrics" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/channel-metrics") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const data = getChannelMetrics();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_channel_metrics" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/peers/performance") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const data = getPeerScores();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_peer_scores" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/peers/live") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const { peers } = await getLndPeers();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(peers.map((p: any) => ({
        pubkey: p.public_key,
        address: p.socket,
        bytes_sent: p.bytes_sent,
        bytes_received: p.bytes_received,
        is_inbound: p.is_inbound,
        ping_time: p.ping_time,
      }))));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/treasury/peers/connect") {
    const node = getNodeInfo();
    try { assertTreasury(node?.node_role); } catch (err: any) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        let { pubkey, address } = parsed;

        // Support URI format: pubkey@host:port
        if (!pubkey && parsed.uri) {
          const parts = parsed.uri.split("@");
          if (parts.length === 2) {
            pubkey = parts[0];
            address = parts[1];
          }
        }

        if (!pubkey || pubkey.length !== 66) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Valid 66-character pubkey required" }));
          return;
        }
        if (!address) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Node address (host:port) required" }));
          return;
        }

        await connectToPeer(pubkey, address);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pubkey, address }));
      } catch (err: any) {
        const msg = err?.message ?? "Failed to connect";
        const status = /already.*connected/i.test(msg) ? 200 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status === 200
          ? { ok: true, pubkey: "already_connected", address: "" }
          : { error: msg }
        ));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/fee-policy") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const policy = getTreasuryFeePolicy();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(policy));
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/treasury/fee-policy") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const base_fee_msat = Number(parsed.base_fee_msat);
          const fee_rate_ppm = Number(parsed.fee_rate_ppm);

          if (!Number.isFinite(base_fee_msat) || base_fee_msat < 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid base_fee_msat" }));
            return;
          }
          if (!Number.isFinite(fee_rate_ppm) || fee_rate_ppm < 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid fee_rate_ppm" }));
            return;
          }

          setTreasuryFeePolicy(base_fee_msat, fee_rate_ppm);
          await applyTreasuryFeePolicy(base_fee_msat, fee_rate_ppm);
          const applied = markTreasuryFeePolicyApplied();

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, policy: applied }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err?.message ?? err) }));
        }
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/alerts") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const alerts = await getTreasuryAlerts();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(alerts));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_alerts" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/fees/dynamic-preview") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const adjustments = computeDynamicFeeAdjustments();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(adjustments));
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 400;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/treasury/fees/apply-dynamic") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const adjustments = computeDynamicFeeAdjustments();
      const results = await applyDynamicFees(adjustments);
      logChannelFeeAdjustments(adjustments.filter(adj =>
        results.find(r => r.channel_id === adj.channel_id && r.applied)
      ));
      const applied = results.filter(r => r.applied).length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, applied, total: adjustments.length, results }));
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 400;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/capital-policy") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const policy = getCapitalPolicy();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(policy));
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/treasury/capital-policy") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const policy = setCapitalPolicy({
            min_onchain_reserve_sats: parsed.min_onchain_reserve_sats != null ? Number(parsed.min_onchain_reserve_sats) : undefined,
            max_deploy_ratio_ppm: parsed.max_deploy_ratio_ppm != null ? Number(parsed.max_deploy_ratio_ppm) : undefined,
            max_pending_opens: parsed.max_pending_opens != null ? Number(parsed.max_pending_opens) : undefined,
            max_peer_capacity_sats: parsed.max_peer_capacity_sats != null ? Number(parsed.max_peer_capacity_sats) : undefined,
            peer_cooldown_minutes: parsed.peer_cooldown_minutes != null ? Number(parsed.peer_cooldown_minutes) : undefined,
            max_expansions_per_day: parsed.max_expansions_per_day != null ? Number(parsed.max_expansions_per_day) : undefined,
            max_daily_deploy_sats: parsed.max_daily_deploy_sats != null ? Number(parsed.max_daily_deploy_sats) : undefined,
            max_daily_loss_sats: parsed.max_daily_loss_sats != null ? Number(parsed.max_daily_loss_sats) : undefined,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(policy));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err?.message ?? err) }));
        }
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/liquidity-health") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const data = getLiquidityHealth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_liquidity_health" }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/treasury/rebalance/executions")) {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = url.searchParams.get("limit");
      const limit = Math.min(500, Math.max(1, parseInt(limitParam ?? "50", 10) || 50));
      const executions = getRebalanceExecutions(limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(executions));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_rebalance_executions" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/expansion/recommendations") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const recommendations = await generateExpansionRecommendations();
      // Optionally save to DB for audit trail
      saveExpansionRecommendations(recommendations);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(recommendations));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_generate_recommendations" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/treasury/expansion/execute") {
    try {
      const node = getNodeInfo();
      if (!node) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Node info unavailable" }));
        return;
      }
      assertTreasury(node.node_role);

      // Verify synced
      if (!node.synced_to_chain) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Node not synced to chain" }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const peerPubkey = parsed.peer_pubkey;
          const capacitySats = Number(parsed.capacity_sats);
          const isPrivate = parsed.is_private ?? false;
          const isDryRun = parsed.dry_run === true;
          const feeRate = parsed.fee_rate ? Number(parsed.fee_rate) : undefined; // sat/vB

          if (!peerPubkey || typeof peerPubkey !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid peer_pubkey" }));
            return;
          }

          if (!Number.isFinite(capacitySats) || capacitySats < 100000 || capacitySats > 16_777_215) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid capacity_sats (must be 100k–16.7M)" }));
            return;
          }

          // Capital guardrails (policy limits) — enforce before any LND call
          try {
            await assertCanExpand(peerPubkey, capacitySats);
          } catch (err: any) {
            const isGuardrail = err instanceof CapitalGuardrailError;
            const statusCode = isGuardrail ? 429 : 500;
            res.writeHead(statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
            return;
          }

          // Check wallet balance
          const { chain_balance } = await getLndChainBalance();
          if (chain_balance < capacitySats) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Insufficient balance: ${chain_balance} < ${capacitySats}` }));
            return;
          }

          // Verify peer is connected (Phase 1 requirement)
          const { peers } = await getLndPeers();
          const peer = peers.find((p) => p.public_key === peerPubkey);
          if (!peer) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Peer not connected. Connect peer first." }));
            return;
          }

          if (isDryRun) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              dry_run: true,
              would_open: { peer_pubkey: peerPubkey, capacity_sats: capacitySats, is_private: isPrivate },
            }));
            return;
          }

          // Create execution record
          const execId = createExpansionExecution(peerPubkey, capacitySats);

          try {
            // Open channel
            const result = await openTreasuryChannel(peerPubkey, capacitySats, {
              isPrivate: isPrivate,
              partnerSocket: peer.socket,
              chainFeeTokensPerVbyte: feeRate,
            });

            // Mark execution as succeeded — funding tx is broadcast
            updateExpansionExecution(
              execId,
              "succeeded",
              result.transaction_id,
              null
            );

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                status: "submitted",
                funding_txid: result.transaction_id,
                execution_id: execId,
              })
            );
          } catch (openErr: any) {
            // Update execution as failed
            updateExpansionExecution(execId, "failed", null, String(openErr?.message ?? openErr));
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(openErr?.message ?? openErr) }));
          }
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err?.message ?? err) }));
        }
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/rotation/candidates") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const candidates = getRotationCandidates();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(candidates));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_rotation_candidates" }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/treasury/rotation/executions")) {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = url.searchParams.get("limit");
      const limit = Math.min(500, Math.max(1, parseInt(limitParam ?? "50", 10) || 50));
      const executions = getRotationExecutions(limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(executions));
    } catch (err: any) {
      const statusCode = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_rotation_executions" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/treasury/rotation/execute") {
    try {
      const node = getNodeInfo();
      if (!node) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Node info unavailable" }));
        return;
      }
      assertTreasury(node.node_role);

      if (!node.synced_to_chain) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Node not synced to chain" }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const channelId = parsed.channel_id;
          const isForceClose = parsed.is_force_close === true;
          const isDryRun = parsed.dry_run === true;

          if (!channelId || typeof channelId !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid channel_id" }));
            return;
          }

          // Look up channel in DB
          const channel = db
            .prepare(`SELECT channel_id, peer_pubkey, capacity_sat, local_balance_sat, active FROM lnd_channels WHERE channel_id = ?`)
            .get(channelId) as { channel_id: string; peer_pubkey: string; capacity_sat: number; local_balance_sat: number; active: number } | undefined;

          if (!channel) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Channel not found" }));
            return;
          }

          if (!channel.active) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Channel is not active — cannot cooperatively close" }));
            return;
          }

          // Safety: never rotate the treasury channel
          if (ENV.treasuryPubkey && channel.peer_pubkey === ENV.treasuryPubkey) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Cannot close the treasury channel" }));
            return;
          }

          // Fetch live LND channels to resolve transaction_id and transaction_vout
          const { channels: lndChannels } = await getLndChannels();
          const lndChannel = lndChannels.find(c => c.id === channelId);

          if (!lndChannel) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Channel not found in LND — may already be closed" }));
            return;
          }

          // Get rotation candidate info for the audit record
          const candidates = getRotationCandidates();
          const candidate = candidates.find(c => c.channel_id === channelId);
          const roiPpm = candidate?.roi_ppm ?? 0;
          const reason = candidate?.reason ?? "manual rotation";

          // Daily loss cap check (skip for dry runs)
          if (!isDryRun) {
            try {
              assertDailyLossCapNotExceeded(0);
            } catch (err: any) {
              const isCapError = err instanceof DailyLossCapError;
              res.writeHead(isCapError ? 429 : 500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err?.message ?? err) }));
              return;
            }
          }

          if (isDryRun) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              dry_run: true,
              would_close: {
                channel_id: channel.channel_id,
                peer_pubkey: channel.peer_pubkey,
                capacity_sats: channel.capacity_sat,
                local_sats: channel.local_balance_sat,
                roi_ppm: roiPpm,
                reason,
                is_force_close: isForceClose,
              },
            }));
            return;
          }

          const execId = createRotationExecution(
            channel.channel_id,
            channel.peer_pubkey,
            channel.capacity_sat,
            channel.local_balance_sat,
            roiPpm,
            reason,
            isForceClose
          );

          try {
            const result = await closeTreasuryChannel(
              lndChannel.transaction_id,
              lndChannel.transaction_vout,
              { isForce: isForceClose }
            );

            updateRotationExecution(execId, "submitted", result.transaction_id ?? null, null);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: true,
              status: "submitted",
              closing_txid: result.transaction_id ?? null,
              execution_id: execId,
            }));
          } catch (closeErr: any) {
            updateRotationExecution(execId, "failed", null, String(closeErr?.message ?? closeErr));
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(closeErr?.message ?? closeErr) }));
          }
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err?.message ?? err) }));
        }
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  // ─── Loop Out rebalance endpoints ────────────────────────────────────────

  if (req.method === "GET" && req.url === "/api/treasury/rebalance/loop-out/terms") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const loop = await isLoopAvailable();
      if (!loop.available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Loop not available", details: loop.error }));
        return;
      }
      const terms = await getLoopOutTerms();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(terms));
    } catch (err: any) {
      const code = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_get_loop_terms" }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/treasury/rebalance/loop-out/quote")) {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const loop = await isLoopAvailable();
      if (!loop.available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Loop not available", details: loop.error }));
        return;
      }
      const url = new URL(req.url ?? "", "http://localhost");
      const amountSats = Number(url.searchParams.get("amount_sats"));
      const channelId = url.searchParams.get("channel_id") ?? undefined;
      if (!Number.isFinite(amountSats) || amountSats <= 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "amount_sats query param required (positive number)" }));
        return;
      }
      const quote = await getLoopOutQuote(amountSats);
      const maxSwapFee = Math.ceil(amountSats * (ENV.loopMaxSwapFeePct / 100));
      const acceptable = quote.swap_fee_sat <= maxSwapFee && quote.miner_fee <= ENV.loopMaxMinerFeeSats;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...quote, channel_id: channelId, acceptable }));
    } catch (err: any) {
      const code = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_get_loop_quote" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/treasury/rebalance/loop-out/status") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const loop = await isLoopAvailable();
      const executions = getRebalanceExecutions(100);
      const inFlight = executions.filter(
        (e) => e.type === "loop_out" && (e.status === "requested" || e.status === "submitted")
      );
      const since24h = Date.now() - 24 * 60 * 60 * 1000;
      const completedToday = executions.filter(
        (e) => e.type === "loop_out" && e.status === "succeeded" && e.created_at >= since24h
      );
      const totalCostToday = completedToday.reduce((sum, e) => sum + (e.fee_paid_sats ?? 0), 0);
      const { getDailyLossSats } = await import("./utils/loss-cap");
      const { getCapitalPolicy } = await import("./api/treasury-capital-policy");
      const policy = getCapitalPolicy();
      const dailyLoss = getDailyLossSats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        loop_available: loop.available,
        loop_version: loop.version ?? null,
        in_flight_swaps: inFlight.length,
        completed_today: completedToday.length,
        total_cost_today_sats: totalCostToday,
        daily_loss_cap_remaining_sats: Math.max(0, policy.max_daily_loss_sats - dailyLoss),
      }));
    } catch (err: any) {
      const code = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_get_loop_status" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/treasury/rebalance/loop-out/auto") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const loop = await isLoopAvailable();
      if (!loop.available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Loop not available", details: loop.error }));
        return;
      }
      const result = await autoLoopOutRebalance();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: any) {
      if (err instanceof DailyLossCapError) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const code = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "auto_loop_out_failed" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/treasury/rebalance/loop-out") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const loop = await isLoopAvailable();
      if (!loop.available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Loop not available", details: loop.error }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const { channel_id, amount_sats, max_swap_fee_sats, max_miner_fee_sats, conf_target } = parsed;
          if (!channel_id || !amount_sats) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "channel_id and amount_sats are required" }));
            return;
          }
          const result = await executeLoopOut({
            channel_id: String(channel_id),
            amount_sats: Number(amount_sats),
            max_swap_fee_sats: max_swap_fee_sats != null ? Number(max_swap_fee_sats) : undefined,
            max_miner_fee_sats: max_miner_fee_sats != null ? Number(max_miner_fee_sats) : undefined,
            conf_target: conf_target != null ? Number(conf_target) : undefined,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          if (err instanceof LoopOutError) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          } else if (err instanceof DailyLossCapError) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err?.message ?? "loop_out_failed" }));
          }
        }
      });
    } catch (err: any) {
      const code = String(err?.message).includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/treasury/rebalance/circular") {
    try {
      const node = getNodeInfo();
      if (!node) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Node info unavailable" }));
        return;
      }
      assertTreasury(node.node_role);

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const tokens = Number(parsed.tokens);
          const outgoing_channel = parsed.outgoing_channel;
          const incoming_channel = parsed.incoming_channel;
          const max_fee_sats = Number(parsed.max_fee_sats);
          const isDryRun = parsed.dry_run === true;

          // Daily loss cap check (skip for dry runs)
          if (!isDryRun) {
            try {
              assertDailyLossCapNotExceeded(Number.isFinite(max_fee_sats) ? max_fee_sats : 0);
            } catch (err: any) {
              const isCapError = err instanceof DailyLossCapError;
              res.writeHead(isCapError ? 429 : 500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err?.message ?? err) }));
              return;
            }
          }

          if (isDryRun) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              dry_run: true,
              would_rebalance: {
                tokens: Number.isFinite(tokens) ? tokens : null,
                outgoing_channel: outgoing_channel ?? "auto",
                incoming_channel: incoming_channel ?? "auto",
                max_fee_sats: Number.isFinite(max_fee_sats) ? max_fee_sats : 0,
              },
            }));
            return;
          }

          const result = await executeCircularRebalance({
            tokens,
            outgoing_channel: outgoing_channel != null ? String(outgoing_channel) : undefined,
            incoming_channel: incoming_channel != null ? String(incoming_channel) : undefined,
            max_fee_sats: Number.isFinite(max_fee_sats) ? max_fee_sats : 0,
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          const msg = String(err?.message ?? err);
          if (err instanceof CircularRebalanceError) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: msg }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: msg || "circular_rebalance_failed" }));
          }
        }
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  // ─── Member liquidity advisor endpoints (member node) ─────────────────────

  if (req.method === "GET" && req.url === "/api/liquidity/status") {
    try {
      const data = await getMemberLiquidityStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/liquidity/history")) {
    try {
      const urlObj = new URL(req.url, `http://localhost`);
      const channelId = urlObj.searchParams.get("channelId") ?? "";
      const limit = urlObj.searchParams.has("limit") ? Number(urlObj.searchParams.get("limit")) : undefined;
      if (!channelId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "channelId query param required" }));
        return;
      }
      const data = getMemberLiquidityHistory(channelId, limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  if (req.method === "PATCH" && req.url === "/api/liquidity/config") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const { channel_role } = parsed;
        if (!channel_role || !["merchant", "farmer", "unknown"].includes(channel_role)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "channel_role must be 'merchant', 'farmer', or 'unknown'" }));
          return;
        }
        db.prepare("UPDATE member_liquidity_advisor_config SET channel_role = ?, updated_at = ? WHERE id = 1")
          .run(channel_role, Date.now());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, channel_role }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message }));
      }
    });
    return;
  }

  // ─── Member liquidity endpoints (treasury-only) ────────────────────────────

  if (req.method === "GET" && req.url === "/api/member-liquidity/clusters") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const states = getAllClusterStates();
      const clusters = states.map((s) => ({
        clusterId: s.clusterId,
        label: s.label,
        peerPubkey: s.peerPubkey,
        policyRole: s.policyRole,
        totalCapacitySats: s.totalCapacitySats,
        localBalanceSats: s.localBalanceSats,
        remoteBalanceSats: s.remoteBalanceSats,
        localPct: s.localPct,
        targetMinPct: s.targetMinPct,
        targetMidPct: s.targetMidPct,
        targetMaxPct: s.targetMaxPct,
        deviationDirection: s.deviationDirection,
        deviationPct: s.deviationPct,
        channelCount: s.channels.length,
        activeChannelCount: s.channels.filter((c) => c.active).length,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clusters }));
    } catch (err: any) {
      const code = err?.message?.includes("Treasury") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/member-liquidity/recommendations") {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const data = getLiquidityRecommendations();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      const code = err?.message?.includes("Treasury") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/member-liquidity/recommendations/") && req.url?.endsWith("/estimate")) {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const recId = req.url.slice("/api/member-liquidity/recommendations/".length, -"/estimate".length);
      const data = await getEstimateForRecommendation(recId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      const code = err?.message?.includes("Treasury") ? 403 : err?.message?.includes("not found") ? 404 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/api/member-liquidity/recommendations/") && req.url?.endsWith("/approve")) {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const recId = req.url.slice("/api/member-liquidity/recommendations/".length, -"/approve".length);
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const data = await approveRecommendation(recId, parsed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err: any) {
          const code = err?.message?.includes("expired") ? 400 : err?.message?.includes("not found") ? 404 : 500;
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err?.message }));
        }
      });
    } catch (err: any) {
      const code = err?.message?.includes("Treasury") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/api/member-liquidity/recommendations/") && req.url?.endsWith("/reject")) {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const recId = req.url.slice("/api/member-liquidity/recommendations/".length, -"/reject".length);
      const data = rejectRecommendation(recId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      const code = err?.message?.includes("Treasury") ? 403 : err?.message?.includes("not found") ? 404 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/member-liquidity/outcomes")) {
    try {
      const node = getNodeInfo();
      assertTreasury(node?.node_role);
      const urlObj = new URL(req.url, `http://localhost`);
      const path = urlObj.pathname;

      if (path !== "/api/member-liquidity/outcomes" && path.startsWith("/api/member-liquidity/outcomes/")) {
        const outcomeId = decodeURIComponent(path.slice("/api/member-liquidity/outcomes/".length));
        const data = getLiquidityOutcomeById(outcomeId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }

      const data = getLiquidityOutcomes({
        clusterId: urlObj.searchParams.get("clusterId") ?? undefined,
        status: urlObj.searchParams.get("status") ?? undefined,
        limit: urlObj.searchParams.has("limit") ? Number(urlObj.searchParams.get("limit")) : undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      const code = err?.message?.includes("Treasury") ? 403 : err?.message?.includes("not found") ? 404 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/pay") {
    try {
      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const { payment_request } = JSON.parse(body);

          if (!payment_request) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "missing_payment_request" }));
            return;
          }

          const node = getNodeInfo();
          if (!node) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: "node_info_unavailable" }));
            return;
          }

          // Decode payment request first (needed for rate limiting and logging)
          const { lnd: lndClient } = getLndClient();
          let decodedRequest: { id: string; destination: string; tokens: number } | null = null;
          try {
            decodedRequest = await decodePaymentRequest({ lnd: lndClient, request: payment_request });
          } catch (decodeErr) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_payment_request" }));
            return;
          }

          if (!decodedRequest) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "failed_to_decode_payment_request" }));
            return;
          }

          try {
            // Treasury can always pay; members need active membership
            if (node.node_role !== "treasury") {
              assertActiveMember(node.membership_status);
            }
            assertRateLimit(decodedRequest.tokens);

            const result = await payInvoice(payment_request);

            // Persist successful payment
            insertOutboundPayment({
              payment_hash: result.id,
              payment_request,
              destination: decodedRequest.destination,
              tokens: result.tokens,
              fee: result.fee,
              status: "succeeded",
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error("PAY ERROR:", err);

            // Persist failed payment (includes rate-limited payments)
            insertOutboundPayment({
              payment_hash: decodedRequest.id,
              payment_request,
              destination: decodedRequest.destination,
              tokens: decodedRequest.tokens,
              fee: 0,
              status: "failed",
            });

            // Check if it's a rate limit error (429) or other error (403)
            const isRateLimitError = String(err).includes("Rate limit exceeded");
            const statusCode = isRateLimitError ? 429 : 403;
            
            res.writeHead(statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        } catch (err: any) {
          console.error("PAY ERROR (outer):", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err?.message ?? "payment_failed" }));
        }
      });
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "payment_failed" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/node/preflight") {
    try {
      const keysendEnabled = await isKeysendEnabled();

      const checks = [
        {
          check: "keysend_enabled",
          passed: keysendEnabled,
          message: keysendEnabled
            ? "Keysend payments are enabled"
            : 'Keysend is not enabled. Go to Umbrel → Lightning → Settings → Enable "Receive Keysend Payments" → Restart LND, then retry.',
          required: true,
        },
      ];

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ checks, all_passed: checks.every((c) => c.passed) }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "preflight_check_failed" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/member/stats") {
    try {
      const node = getNodeInfo();
      const hubPubkey = ENV.treasuryPubkey;

      let isPeeredToHub = false;
      if (hubPubkey) {
        try {
          const { peers } = await getLndPeers();
          isPeeredToHub = peers.some((p: any) => p.public_key === hubPubkey);
        } catch {
          // non-fatal — direct peer check best-effort
        }
      }

      let keysendEnabled = false;
      try {
        keysendEnabled = await isKeysendEnabled();
      } catch {
        // non-fatal — keysend check best-effort
      }

      const treasuryChannel = hubPubkey
        ? (db
            .prepare(
              "SELECT channel_id, local_balance_sat, remote_balance_sat, capacity_sat, active FROM lnd_channels WHERE peer_pubkey = ? LIMIT 1"
            )
            .get(hubPubkey) as
            | {
                channel_id: string;
                local_balance_sat: number;
                remote_balance_sat: number;
                capacity_sat: number;
                active: number;
              }
            | undefined)
        : undefined;

      const now = Math.floor(Date.now() / 1000);
      const cutoff24h = now - 86400;
      const cutoff30d = now - 86400 * 30;

      const feesTotal = db
        .prepare("SELECT COALESCE(SUM(fee), 0) as total FROM payments_forwarded")
        .get() as { total: number };
      const fees24h = db
        .prepare(
          "SELECT COALESCE(SUM(fee), 0) as total FROM payments_forwarded WHERE created_at >= ?"
        )
        .get(cutoff24h) as { total: number };
      const fees30d = db
        .prepare(
          "SELECT COALESCE(SUM(fee), 0) as total FROM payments_forwarded WHERE created_at >= ?"
        )
        .get(cutoff30d) as { total: number };

      const result = {
        hub_pubkey: hubPubkey || null,
        membership_status: node?.membership_status ?? "unsynced",
        node_role: node?.node_role ?? "external",
        is_peered_to_hub: isPeeredToHub,
        keysend_enabled: keysendEnabled,
        treasury_channel: treasuryChannel
          ? {
              channel_id: treasuryChannel.channel_id,
              local_sats: treasuryChannel.local_balance_sat,
              remote_sats: treasuryChannel.remote_balance_sat,
              capacity_sats: treasuryChannel.capacity_sat,
              is_active: Boolean(treasuryChannel.active),
            }
          : null,
        forwarded_fees: {
          total_sats: feesTotal.total,
          last_24h_sats: fees24h.total,
          last_30d_sats: fees30d.total,
        },
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_member_stats" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/member/open-channel") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const capacitySats = Number(parsed.capacity_sats);
        const feeRate = parsed.fee_rate ? Number(parsed.fee_rate) : undefined;
        const partnerSocket: string | undefined =
          parsed.partner_socket && typeof parsed.partner_socket === "string"
            ? parsed.partner_socket.trim() || undefined
            : undefined;

        if (!Number.isFinite(capacitySats) || capacitySats < 100_000) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "capacity_sats must be at least 100,000" }));
          return;
        }

        const hubPubkey = ENV.treasuryPubkey;
        if (!hubPubkey) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Hub pubkey not configured on this node" }));
          return;
        }

        // Connect to peer first if socket address provided
        if (partnerSocket) {
          await connectToPeer(hubPubkey, partnerSocket);
        }

        const result = await openTreasuryChannel(hubPubkey, capacitySats, {
          isPrivate: false,
          partnerSocket,
          chainFeeTokensPerVbyte: feeRate,
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, funding_txid: result.transaction_id ?? null }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message ?? "failed_to_open_channel" }));
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RECOMMENDED PEERS (curated external peer list from Worker)
  // ═══════════════════════════════════════════════════════════════════════

  if (req.method === "GET" && req.url === "/api/network/recommended-peers") {
    try {
      const workerUrl = ENV.coinbaseWorkerUrl;
      if (!workerUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "worker_not_configured" }));
        return;
      }

      // Fetch curated list from Worker
      const response = await fetch(`${workerUrl}/recommended-peers`);
      if (!response.ok) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "recommended_peers_unavailable" }));
        return;
      }
      const peers = (await response.json()) as Array<{
        id: string; label: string; pubkey: string; socket: string;
        description: string; recommended_channel_size_sat: number; advanced: boolean;
      }>;

      // Enrich with local LND state
      const [lndPeers, lndChannels] = await Promise.all([
        getLndPeers().then((p) => p.peers ?? []).catch(() => []),
        getLndChannels().then((c) => c.channels ?? []).catch(() => []),
      ]);

      const connectedPubkeys = new Set((lndPeers as any[]).map((p: any) => p.public_key));
      const channelsByPeer = new Map<string, any[]>();
      for (const ch of lndChannels as any[]) {
        const pk = ch.partner_public_key;
        if (!channelsByPeer.has(pk)) channelsByPeer.set(pk, []);
        channelsByPeer.get(pk)!.push(ch);
      }

      const enriched = peers.map((peer) => ({
        ...peer,
        connected: connectedPubkeys.has(peer.pubkey),
        has_channel: channelsByPeer.has(peer.pubkey),
        channels: (channelsByPeer.get(peer.pubkey) ?? []).map((ch: any) => ({
          channel_id: ch.id,
          capacity_sat: ch.capacity,
          local_balance_sat: ch.local_balance,
          remote_balance_sat: ch.remote_balance,
          active: ch.is_active,
        })),
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(enriched));
    } catch (err: any) {
      console.error("[recommended-peers]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "recommended_peers_error" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/lightning/open-recommended-channel") {
    let body = "";
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const peerId = parsed.peer_id;
        const localFundingAmountSat = Number(parsed.local_funding_amount_sat);

        if (!peerId || typeof peerId !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "peer_id is required" }));
          return;
        }
        if (!Number.isFinite(localFundingAmountSat) || localFundingAmountSat < 100_000) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "local_funding_amount_sat must be at least 100,000" }));
          return;
        }

        // Fetch approved list from Worker — peer_id must match
        const workerUrl = ENV.coinbaseWorkerUrl;
        if (!workerUrl) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "worker_not_configured" }));
          return;
        }

        const response = await fetch(`${workerUrl}/recommended-peers`);
        if (!response.ok) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "could not verify peer against approved list" }));
          return;
        }
        const approvedPeers = (await response.json()) as Array<{
          id: string; pubkey: string; socket: string; label: string;
        }>;

        const peer = approvedPeers.find((p) => p.id === peerId);
        if (!peer) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "peer_not_in_approved_list" }));
          return;
        }

        // Connect to peer if needed
        await connectToPeer(peer.pubkey, peer.socket);

        // Open channel
        const result = await openTreasuryChannel(peer.pubkey, localFundingAmountSat, {
          isPrivate: false,
          partnerSocket: peer.socket,
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          peer_id: peer.id,
          peer_label: peer.label,
          funding_txid: result.transaction_id ?? null,
        }));
      } catch (err: any) {
        console.error("[open-recommended-channel]", err);
        // ln-service throws [statusCode, 'ErrorName', { err }] arrays
        const errStr = Array.isArray(err) ? JSON.stringify(err) : (err?.message ?? "");
        let userMsg = "Failed to open channel";
        if (/insufficient|InsufficientFunds/i.test(errStr)) {
          userMsg = "Insufficient on-chain balance to open this channel. Fund your node first.";
        } else if (/already.*peer|already.*connected/i.test(errStr)) {
          userMsg = "Already connected to this peer";
        } else if (/timeout|ETIMEDOUT|connect.*refused/i.test(errStr)) {
          userMsg = "Could not connect to peer. The node may be offline.";
        } else if (err?.message) {
          userMsg = err.message;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: userMsg }));
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NETWORK PAYMENTS
  // ═══════════════════════════════════════════════════════════════════════

  if (req.method === "GET" && req.url === "/api/exchange-rate") {
    try {
      const rate = await getBtcExchangeRate();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rate));
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "exchange_rate_unavailable" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/network/sync-settlements") {
    try {
      const result = syncNetworkInvoiceSettlements();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "sync_failed" }));
    }
    return;
  }

  // Delete a pending/failed/expired payment record (not succeeded — those are audit records)
  if (req.method === "DELETE" && req.url?.startsWith("/api/network/payments/")) {
    const paymentId = req.url.split("/api/network/payments/")[1]?.split("?")[0];
    if (!paymentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payment_id_required" }));
      return;
    }
    try {
      const row = db.prepare("SELECT id, status FROM network_payments WHERE id = ?").get(Number(paymentId)) as { id: number; status: string } | undefined;
      if (!row) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payment_not_found" }));
        return;
      }
      if (row.status === "succeeded") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "cannot_delete_succeeded_payment" }));
        return;
      }
      db.prepare("DELETE FROM network_payments WHERE id = ?").run(row.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deleted_id: row.id }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "delete_failed" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/network/decode") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { payment_request } = JSON.parse(body || "{}");
        if (!payment_request) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing_payment_request" }));
          return;
        }
        const decoded = await decodeInvoice(payment_request);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(decoded));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message ?? "invalid_payment_request" }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/network/pay") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { payment_request } = JSON.parse(body || "{}");
        if (!payment_request) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing_payment_request" }));
          return;
        }

        const node = getNodeInfo();
        if (!node) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "node_info_unavailable" }));
          return;
        }
        // Treasury can always pay; members need active membership
        if (node.node_role !== "treasury") {
          assertActiveMember(node.membership_status);
        }

        const result = await payNetworkInvoice(payment_request);
        res.writeHead(result.ok ? 200 : 402, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const isRateLimit = msg.includes("Rate limit exceeded");
        const isMembership = msg.includes("Active membership required");
        const code = isRateLimit ? 429 : isMembership ? 403 : 500;
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/network/invoice") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { amount_sats, memo } = JSON.parse(body || "{}");
        if (!amount_sats || amount_sats <= 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "amount_sats must be positive" }));
          return;
        }
        const result = await createPaymentInvoice(amount_sats, memo);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message ?? "invoice_creation_failed" }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/network/payments")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const direction = url.searchParams.get("direction") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
      const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined;

      const payments = getNetworkPayments({ direction, status, limit, offset });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payments));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_payments" }));
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTACTS
  // ═══════════════════════════════════════════════════════════════════════

  // Helper: build contact response with parsed tags + joined channels
  function contactRow(row: any) {
    const channels = db
      .prepare(
        "SELECT channel_id, capacity_sat, local_balance_sat, remote_balance_sat, active FROM lnd_channels WHERE peer_pubkey = ?"
      )
      .all(row.pubkey) as Array<{
      channel_id: string;
      capacity_sat: number;
      local_balance_sat: number;
      remote_balance_sat: number;
      active: number;
    }>;
    return {
      id: row.id,
      pubkey: row.pubkey,
      name: row.name,
      notes: row.notes ?? null,
      tags: row.tags
        ? row.tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : [],
      source: row.source,
      created_at: row.created_at,
      updated_at: row.updated_at,
      channels: channels.map((ch) => ({
        channel_id: ch.channel_id,
        capacity_sats: ch.capacity_sat,
        local_sats: ch.local_balance_sat,
        remote_sats: ch.remote_balance_sat,
        is_active: !!ch.active,
      })),
    };
  }

  // GET /api/contacts
  if (req.method === "GET" && req.url === "/api/contacts") {
    try {
      const rows = db
        .prepare("SELECT * FROM contacts ORDER BY name COLLATE NOCASE ASC")
        .all() as any[];
      const contacts = rows.map(contactRow);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(contacts));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_contacts" }));
    }
    return;
  }

  // POST /api/contacts/sync-peers  (must be before POST /api/contacts)
  if (req.method === "POST" && req.url === "/api/contacts/sync-peers") {
    try {
      // Collect pubkeys from both channels AND live connected peers
      const channelPubkeys = db
        .prepare("SELECT DISTINCT peer_pubkey FROM lnd_channels")
        .all() as Array<{ peer_pubkey: string }>;

      let livePeerPubkeys: string[] = [];
      try {
        const { peers } = await getLndPeers();
        livePeerPubkeys = (peers ?? []).map((p: any) => p.public_key as string);
      } catch {}

      const allPubkeys = new Set([
        ...channelPubkeys.map((r) => r.peer_pubkey),
        ...livePeerPubkeys,
      ]);

      const existing = new Set(
        (
          db.prepare("SELECT pubkey FROM contacts").all() as Array<{ pubkey: string }>
        ).map((r) => r.pubkey)
      );

      let added = 0;
      let skipped = 0;
      const now = Date.now();

      for (const peer_pubkey of allPubkeys) {
        if (existing.has(peer_pubkey)) {
          skipped++;
          continue;
        }

        // Try to get alias from LND gossip graph
        let name = `${peer_pubkey.slice(0, 8)}…${peer_pubkey.slice(-6)}`;
        try {
          const { lnd } = getLndClient();
          const nodeInfo = await getNode({ lnd, public_key: peer_pubkey, is_omitting_channels: true });
          if (nodeInfo.alias && nodeInfo.alias.trim()) {
            name = nodeInfo.alias.trim();
          }
        } catch {
          // gossip lookup failed — use truncated pubkey
        }

        db.prepare(
          "INSERT INTO contacts (pubkey, name, notes, tags, source, created_at, updated_at) VALUES (?, ?, NULL, NULL, 'auto', ?, ?)"
        ).run(peer_pubkey, name, now, now);
        added++;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, added, skipped }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_sync_peers" }));
    }
    return;
  }

  // POST /api/contacts
  if (req.method === "POST" && req.url === "/api/contacts") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const { pubkey, name, notes, tags } = parsed;

        if (!pubkey || typeof pubkey !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "pubkey is required" }));
          return;
        }
        if (!name || typeof name !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "name is required" }));
          return;
        }

        const tagsStr = Array.isArray(tags) ? tags.join(",") : tags ?? null;
        const now = Date.now();

        try {
          db.prepare(
            "INSERT INTO contacts (pubkey, name, notes, tags, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', ?, ?)"
          ).run(pubkey.trim(), name.trim(), notes ?? null, tagsStr, now, now);
        } catch (sqlErr: any) {
          if (sqlErr?.message?.includes("UNIQUE constraint failed")) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Contact with this pubkey already exists" }));
            return;
          }
          throw sqlErr;
        }

        const row = db
          .prepare("SELECT * FROM contacts WHERE pubkey = ?")
          .get(pubkey.trim()) as any;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, contact: contactRow(row) }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message ?? "failed_to_create_contact" }));
      }
    });
    return;
  }

  // PATCH /api/contacts/:pubkey
  if (req.method === "PATCH" && req.url?.startsWith("/api/contacts/")) {
    const pubkey = decodeURIComponent(req.url.slice("/api/contacts/".length));
    if (!pubkey) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "pubkey is required" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const sets: string[] = [];
        const params: any[] = [];

        if (parsed.name !== undefined) {
          sets.push("name = ?");
          params.push(parsed.name);
        }
        if (parsed.notes !== undefined) {
          sets.push("notes = ?");
          params.push(parsed.notes);
        }
        if (parsed.tags !== undefined) {
          const tagsStr = Array.isArray(parsed.tags) ? parsed.tags.join(",") : parsed.tags;
          sets.push("tags = ?");
          params.push(tagsStr);
        }

        if (sets.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No fields to update" }));
          return;
        }

        sets.push("updated_at = ?");
        params.push(Date.now());
        params.push(pubkey);

        const result = db
          .prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE pubkey = ?`)
          .run(...params);

        if (result.changes === 0) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Contact not found" }));
          return;
        }

        const row = db.prepare("SELECT * FROM contacts WHERE pubkey = ?").get(pubkey) as any;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, contact: contactRow(row) }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message ?? "failed_to_update_contact" }));
      }
    });
    return;
  }

  // DELETE /api/contacts/:pubkey
  if (req.method === "DELETE" && req.url?.startsWith("/api/contacts/")) {
    const pubkey = decodeURIComponent(req.url.slice("/api/contacts/".length));
    if (!pubkey) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "pubkey is required" }));
      return;
    }
    try {
      const result = db.prepare("DELETE FROM contacts WHERE pubkey = ?").run(pubkey);
      if (result.changes === 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Contact not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_delete_contact" }));
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SWAP ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════

  // Member swap endpoints
  if (req.method === "POST" && req.url === "/api/swaps/loop-out/quote") {
    try { await handleMemberLoopOutQuote(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") || e.message?.includes("authorized") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/swaps/loop-out") {
    try { await handleMemberLoopOut(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") || e.message?.includes("authorized") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && (req.url === "/api/swaps/history" || req.url?.startsWith("/api/swaps/history?"))) {
    try { await handleSwapHistory(req, res); } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/swaps/") && !req.url.includes("/admin/")) {
    const swapId = req.url.split("/api/swaps/")[1]?.split("?")[0];
    if (swapId && swapId !== "history") {
      try { await handleGetSwap(req, res, swapId); } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  // Admin swap endpoints
  if (req.method === "POST" && req.url === "/api/admin/swaps/loop-out/quote") {
    try { await handleAdminLoopOutQuote(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/swaps/loop-out") {
    try { await handleAdminLoopOut(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Treasury Loop In — removed from active architecture (v1.7.1).
  // Merchant-side liquidity uses channel lifecycle management, not Loop In.
  if (req.method === "POST" && (req.url === "/api/admin/swaps/loop-in/quote" || req.url === "/api/admin/swaps/loop-in")) {
    res.writeHead(410, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "treasury_loop_in_deprecated",
      message: "Treasury Loop In is not part of the active architecture. Merchant-side liquidity uses channel lifecycle management.",
    }));
    return;
  }

  if (req.method === "GET" && (req.url === "/api/admin/swaps" || req.url?.startsWith("/api/admin/swaps?"))) {
    try { await handleAdminSwapList(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/admin/swaps/")) {
    const swapId = req.url.split("/api/admin/swaps/")[1]?.split("?")[0];
    if (swapId) {
      try { await handleAdminGetSwap(req, res, swapId); } catch (e: any) {
        res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  // ✅ 404 MUST BE LAST
  res.writeHead(404);
  res.end();
});


server.listen(PORTS.userApi, () => {
  console.log(`[api] listening on port ${PORTS.userApi}`);
  // Loop Out rebalance scheduler — requires REBALANCE_SCHEDULER_ENABLED=true
  // and the loopd sidecar to be running (included in the Bitcorn app stack).
  startRebalanceScheduler();
  // Cluster-based rebalance engine — requires CLUSTER_REBALANCE_ENABLED=true.
  // Fee steering + circular rebalance + topology monitoring on a 15-min interval.
  startClusterRebalanceScheduler();
  // Member liquidity advisor — classifies treasury channel health on member nodes.
  // Runs on all nodes but only acts on non-treasury nodes.
  startMemberAdvisorScheduler();
  // Swap poller — monitors in-flight Loop swaps and updates status every 15s.
  startSwapPoller();
});
