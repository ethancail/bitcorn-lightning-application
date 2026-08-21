import { db } from "../db";
import { getCapitalPolicy } from "./treasury-capital-policy";
import { getRotationCandidates } from "./treasury-rotation";
import { getLiquidityHealth } from "./treasury-liquidity-health";
import { getDailyLossSats } from "../utils/loss-cap";
import { getLndChainBalance } from "../lightning/lnd";
import { runTimeoutBoundLndProbe } from "../lightning/lndProbeRoute";
import { lndFaultAlerts } from "./lndFaultAlerts";
import { readLocalCertExpiry } from "../lightning/readCertExpiry";
import { isLoopAvailable } from "../lightning/loop";
import { ENV } from "../config/env";
import { MANUAL_METRIC_KEYS, listLatestPerMetric } from "../valuation/manualInputStore";

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
    // ⚠ THIS USED TO BE `catch { /* LND unavailable — skip reserve check */ }`,
    // and the silence was two defects, both measured against that code:
    //
    //   (a) An LND fault produced no alert at all. The classifier in
    //       lightning/lndHealth.ts can separate auth from permission on
    //       identical gRPC 2 UNKNOWN; this surface emitted nothing for either.
    //   (b) ONCHAIN_RESERVE_BREACHED / _NEAR above simply vanished, leaving the
    //       returned array BYTE-IDENTICAL to a comfortably-funded treasury. A
    //       capital guardrail read healthy because it was silent, not because it
    //       passed. That is the more dangerous of the two.
    //
    // So: BOTH signals. The probe covers all THREE read-only scopes rather than
    // re-classifying the single onchain:read error above, because one scope
    // cannot distinguish a narrowed credential from a broken one — which is the
    // classifier's whole purpose.
    //
    // Report-only. Nothing here moves capital or gates a decision; alerts are
    // rendered by the treasury Dashboard and read by nothing else.
    //
    // The probe is deadline-bound (LND_PROBE_TIMEOUT_MS, 3s), so it cannot hang
    // the 60s dashboard poll. Note that getLndChainBalance() above and
    // isLoopAvailable() below still carry NO deadline — pre-existing, tracked
    // separately, and not addressed here.
    try {
      const report = await runTimeoutBoundLndProbe(now);
      // The cert is read from LOCAL DISK — no LND call, so it still answers
      // when every gRPC call is failing. That is the whole point: it is what
      // separates a permanently-lapsed cert from a transient blip, both of
      // which the classifier necessarily reports as `connectivity`.
      alerts.push(
        ...lndFaultAlerts(report, now, {
          minOnchainReserveSats: policy.min_onchain_reserve_sats,
          certExpiry: readLocalCertExpiry(now),
        }),
      );
    } catch (probeErr: any) {
      // The producer is not supposed to throw — runLndHealthProbe turns every
      // outcome into a result. But its module resolution CAN fail (measured
      // once in this arc), and on a surface polled every 60s a throw here would
      // turn "some alerts" into a 500 with none. The guardrail still did not
      // run, so that much is still reported.
      console.warn("[treasury-alerts] LND probe failed:", probeErr?.message ?? probeErr);
      alerts.push({
        type: "ONCHAIN_RESERVE_CHECK_SKIPPED",
        severity: "critical",
        message:
          `On-chain reserve check DID NOT RUN and the follow-up LND probe itself failed. ` +
          `The ${policy.min_onchain_reserve_sats} sat floor is unverified; this is not a passing check.`,
        data: {
          min_reserve_sats: policy.min_onchain_reserve_sats,
          reason: "probe_failed",
          probe_error: probeErr?.message ?? String(probeErr),
        },
        at: now,
      });
    }
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

  // --- Loop Out availability vs critical channels ---
  const health = getLiquidityHealth();
  const criticalCount = health.filter(
    (h) => h.is_active && h.health_classification === "critical"
  ).length;

  if (criticalCount > 0) {
    const loop = await isLoopAvailable();
    if (loop.available) {
      alerts.push({
        type: "LOOP_OUT_AVAILABLE",
        severity: "info",
        message: `${criticalCount} critical channel(s) can be rebalanced via Loop Out`,
        data: { critical_channels: criticalCount, loop_version: loop.version },
        at: now,
      });
    } else {
      alerts.push({
        type: "LOOP_NOT_INSTALLED",
        severity: "warning",
        message: `${criticalCount} critical channel(s) need rebalancing but Loop is not available. Check that loopd is running.`,
        data: { critical_channels: criticalCount, error: loop.error },
        at: now,
      });
    }
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

  // --- Valuation manual-input staleness ---
  // The 8 Glassnode-sourced valuation metrics are entered manually daily via
  // /valuation-input. If any metric is > 24h old OR never entered, surface a
  // warning so the operator sees it on the dashboard banner.
  const STALE_THRESHOLD_SECONDS = 24 * 60 * 60;
  const nowSeconds = Math.floor(now / 1000);
  const latestPerMetric = listLatestPerMetric(db);
  const byKey = new Map(latestPerMetric.map((r) => [r.metric_key, r]));

  const staleMetrics: string[] = [];
  const neverEnteredMetrics: string[] = [];
  for (const key of MANUAL_METRIC_KEYS) {
    const row = byKey.get(key);
    if (!row) {
      neverEnteredMetrics.push(key);
    } else if (nowSeconds - row.submitted_at > STALE_THRESHOLD_SECONDS) {
      staleMetrics.push(key);
    }
  }

  if (staleMetrics.length > 0 || neverEnteredMetrics.length > 0) {
    const parts: string[] = [];
    if (neverEnteredMetrics.length > 0) {
      parts.push(`never entered: ${neverEnteredMetrics.join(", ")}`);
    }
    if (staleMetrics.length > 0) {
      parts.push(`> 24h old: ${staleMetrics.join(", ")}`);
    }
    const allUnentered = neverEnteredMetrics.length === MANUAL_METRIC_KEYS.length;
    alerts.push({
      type: "VALUATION_MANUAL_STALE",
      severity: "warning",
      message: allUnentered
        ? "Valuation inputs not yet entered — open the Valuation Inputs page to enter today's values"
        : `Valuation inputs need attention (${parts.join("; ")})`,
      data: {
        stale: staleMetrics,
        never_entered: neverEnteredMetrics,
        total_unresolved: staleMetrics.length + neverEnteredMetrics.length,
      },
      at: now,
    });
  }

  return alerts;
}
