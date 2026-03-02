import { db } from "../db";
import { getLiquidityHealth } from "./treasury-liquidity-health";
import { getCapitalPolicy } from "./treasury-capital-policy";
import { getRotationCandidates } from "./treasury-rotation";
import { getDailyLossSats } from "../utils/loss-cap";
import { getLndChainBalance } from "../lightning/lnd";
import { ENV } from "../config/env";

export type AlertSeverity = "info" | "warning" | "critical";

export type TreasuryAlert = {
  type: string;
  severity: AlertSeverity;
  message: string;
  data: Record<string, any>;
  at: number;
};

function getDailyDeployedSats(): number {
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(requested_capacity_sats), 0) AS v
       FROM treasury_expansion_executions
       WHERE created_at >= ? AND status IN ('requested', 'submitted', 'succeeded')`
    )
    .get(since24h) as { v: number };
  return row?.v ?? 0;
}

function getExpansionsTodayCount(): number {
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS v
       FROM treasury_expansion_executions
       WHERE created_at >= ? AND status IN ('requested', 'submitted', 'succeeded')`
    )
    .get(since24h) as { v: number };
  return row?.v ?? 0;
}

export async function getTreasuryAlerts(): Promise<TreasuryAlert[]> {
  const now = Date.now();
  const alerts: TreasuryAlert[] = [];
  const policy = getCapitalPolicy();

  // --- Rotation candidates ---
  const candidates = getRotationCandidates();
  if (candidates.length > 0) {
    const topScore = candidates[0].rotation_score;
    alerts.push({
      type: "ROTATION_CANDIDATES_PRESENT",
      severity: topScore >= 150 ? "critical" : "warning",
      message: `${candidates.length} channel(s) are candidates for rotation`,
      data: {
        count: candidates.length,
        top_score: topScore,
        top_channel: candidates[0].channel_id,
        top_reason: candidates[0].reason,
      },
      at: now,
    });
  }

  // --- Daily loss cap ---
  const dailyLoss = getDailyLossSats();
  if (dailyLoss >= policy.max_daily_loss_sats) {
    alerts.push({
      type: "DAILY_LOSS_CAP_EXCEEDED",
      severity: "critical",
      message: `Daily loss cap exceeded — automation halted: ${dailyLoss} / ${policy.max_daily_loss_sats} sats`,
      data: { daily_loss_sats: dailyLoss, cap_sats: policy.max_daily_loss_sats },
      at: now,
    });
  } else if (dailyLoss >= policy.max_daily_loss_sats * 0.8) {
    alerts.push({
      type: "DAILY_LOSS_CAP_NEAR",
      severity: "warning",
      message: `Daily loss approaching cap: ${dailyLoss} / ${policy.max_daily_loss_sats} sats (${Math.round(dailyLoss / policy.max_daily_loss_sats * 100)}%)`,
      data: {
        daily_loss_sats: dailyLoss,
        cap_sats: policy.max_daily_loss_sats,
        pct_used: Math.round(dailyLoss / policy.max_daily_loss_sats * 100),
      },
      at: now,
    });
  }

  // --- Daily expansion limits ---
  const expansionsToday = getExpansionsTodayCount();
  if (expansionsToday >= policy.max_expansions_per_day) {
    alerts.push({
      type: "DAILY_EXPANSION_LIMIT_REACHED",
      severity: "warning",
      message: `Daily expansion limit reached: ${expansionsToday} / ${policy.max_expansions_per_day}`,
      data: { expansions_today: expansionsToday, limit: policy.max_expansions_per_day },
      at: now,
    });
  }

  const dailyDeploy = getDailyDeployedSats();
  if (dailyDeploy >= policy.max_daily_deploy_sats * 0.8) {
    alerts.push({
      type: "DAILY_DEPLOY_LIMIT_NEAR",
      severity: "warning",
      message: `Daily deploy approaching limit: ${dailyDeploy} / ${policy.max_daily_deploy_sats} sats`,
      data: {
        daily_deploy_sats: dailyDeploy,
        limit_sats: policy.max_daily_deploy_sats,
        pct_used: Math.round(dailyDeploy / policy.max_daily_deploy_sats * 100),
      },
      at: now,
    });
  }

  // --- On-chain reserve (requires LND call) ---
  try {
    const { chain_balance } = await getLndChainBalance();
    const reserveBuffer = chain_balance / policy.min_onchain_reserve_sats;
    if (chain_balance < policy.min_onchain_reserve_sats) {
      alerts.push({
        type: "ONCHAIN_RESERVE_BREACHED",
        severity: "critical",
        message: `On-chain reserve below minimum: ${chain_balance} < ${policy.min_onchain_reserve_sats} sats`,
        data: { chain_balance, min_reserve: policy.min_onchain_reserve_sats },
        at: now,
      });
    } else if (reserveBuffer < 1.2) {
      alerts.push({
        type: "ONCHAIN_RESERVE_NEAR",
        severity: "warning",
        message: `On-chain reserve near minimum: ${chain_balance} sats (${Math.round(reserveBuffer * 100)}% of floor)`,
        data: { chain_balance, min_reserve: policy.min_onchain_reserve_sats, buffer_pct: Math.round(reserveBuffer * 100) },
        at: now,
      });
    }
  } catch {
    // LND unavailable — skip reserve check
  }

  // --- Scheduler simulation mode ---
  if (ENV.rebalanceSchedulerEnabled && ENV.rebalanceSchedulerDryRun) {
    alerts.push({
      type: "SCHEDULER_SIMULATION_MODE",
      severity: "info",
      message: "Rebalance scheduler is running in dry-run (simulation) mode — no rebalances are being executed",
      data: { interval_ms: ENV.rebalanceSchedulerIntervalMs },
      at: now,
    });
  }

  // --- Keysend rebalance available ---
  const health = getLiquidityHealth();
  const criticalChannels = health.filter((h) => h.is_active && h.health_classification === "critical");
  if (criticalChannels.length > 0) {
    alerts.push({
      type: "KEYSEND_REBALANCE_AVAILABLE",
      severity: "info",
      message: `${criticalChannels.length} channel(s) have >85% local balance — keysend push rebalance available`,
      data: {
        count: criticalChannels.length,
        channels: criticalChannels.map((c) => ({
          channel_id: c.channel_id,
          imbalance_ratio: c.imbalance_ratio,
          local_sats: c.local_sats,
          capacity_sats: c.capacity_sats,
        })),
      },
      at: now,
    });
  }

  // --- Member keysend disabled (only peers within 24h skip window) ---
  const keysendSkipWindow = now - 24 * 60 * 60 * 1000;
  const keysendDisabled = db.prepare(
    `SELECT peer_pubkey, last_failure_at FROM member_keysend_status
     WHERE keysend_disabled = 1 AND last_failure_at >= ?`
  ).all(keysendSkipWindow) as Array<{ peer_pubkey: string; last_failure_at: number }>;

  if (keysendDisabled.length > 0) {
    alerts.push({
      type: "MEMBER_KEYSEND_DISABLED",
      severity: "warning",
      message: `${keysendDisabled.length} member node(s) have keysend disabled and cannot be auto-rebalanced`,
      data: {
        count: keysendDisabled.length,
        peers: keysendDisabled.map((p) => ({
          peer_pubkey: p.peer_pubkey,
          last_failure_at: p.last_failure_at,
        })),
      },
      at: now,
    });
  }

  return alerts;
}
