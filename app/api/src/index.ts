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
import { decodePaymentRequest } from "ln-service";
import { getChannels, getPeers, getNodeInfo } from "./api/read";
import { getTreasuryMetrics } from "./api/treasury";
import { getChannelMetrics } from "./api/treasury-channel-metrics";
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
import { getLndChainBalance, getLndPeers, openTreasuryChannel } from "./lightning/lnd";
import { applyTreasuryFeePolicy } from "./lightning/fees";
import { assertTreasury } from "./utils/role";

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
    console.warn("[lnd] initial sync failed:", err.message);
  }

  setInterval(() => {
    syncLndState().catch(err =>
      console.warn("[lnd] periodic sync failed:", err.message)
    );
  }, 15000);
})();

const server = http.createServer(async (req, res) => {
  // ✅ CORS HEADERS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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

          if (!peerPubkey || typeof peerPubkey !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid peer_pubkey" }));
            return;
          }

          if (!Number.isFinite(capacitySats) || capacitySats < 100000 || capacitySats > 2000000) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid capacity_sats (must be 100k-2M)" }));
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

          // Create execution record
          const execId = createExpansionExecution(peerPubkey, capacitySats);

          try {
            // Open channel
            const result = await openTreasuryChannel(peerPubkey, capacitySats, {
              isPrivate: isPrivate,
              partnerSocket: peer.socket,
            });

            // Update execution as submitted
            updateExpansionExecution(
              execId,
              "submitted",
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
          let decodedRequest: { id: string; destination: string; tokens: number } | null = null;
          try {
            decodedRequest = decodePaymentRequest({ request: payment_request });
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
            console.log("Node membership:", node?.membership_status);

            assertActiveMember(node.membership_status);
            assertRateLimit(decodedRequest.tokens);

            console.log("Membership passed");
            console.log("Rate limit passed");

            const result = await payInvoice(payment_request);

            console.log("Payment result:", result);

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

  // ✅ 404 MUST BE LAST
  res.writeHead(404);
  res.end();
});


server.listen(PORTS.userApi, () => {
  console.log(`[api] listening on port ${PORTS.userApi}`);
});
