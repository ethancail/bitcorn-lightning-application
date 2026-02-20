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
import { getLndChainBalance, getLndPeers, getLndChannels, openTreasuryChannel, closeTreasuryChannel } from "./lightning/lnd";
import { ENV } from "./config/env";
import { applyTreasuryFeePolicy } from "./lightning/fees";
import { assertTreasury } from "./utils/role";
import { executeCircularRebalance, CircularRebalanceError } from "./lightning/rebalance-circular";
import { getRebalanceExecutions } from "./api/treasury-rebalance-executions";
import { startRebalanceScheduler } from "./lightning/rebalance-scheduler";

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

  if (req.method === "GET" && req.url === "/api/member/stats") {
    try {
      const node = getNodeInfo();
      const hubPubkey = ENV.treasuryPubkey;

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

  // ✅ 404 MUST BE LAST
  res.writeHead(404);
  res.end();
});


server.listen(PORTS.userApi, () => {
  console.log(`[api] listening on port ${PORTS.userApi}`);
  startRebalanceScheduler();
});
