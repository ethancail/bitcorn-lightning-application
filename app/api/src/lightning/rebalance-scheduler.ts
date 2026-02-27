/**
 * Automated keysend push rebalance scheduler: on the treasury node, periodically
 * finds critical channels (>85% local) and pushes sats to members via keysend.
 * Respects cooldown and never overlaps runs.
 */

import { ENV } from "../config/env";
import { getNodeInfo } from "../api/read";
import { assertTreasury } from "../utils/role";
import { assertDailyLossCapNotExceeded, DailyLossCapError } from "../utils/loss-cap";
import { autoKeysendRebalance } from "./rebalance-keysend";
import { db } from "../db";

let running = false;

function hasRecentSucceededRebalance(minutes: number): boolean {
  const since = Date.now() - minutes * 60_000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM treasury_rebalance_executions
       WHERE status = 'succeeded' AND created_at >= ?`
    )
    .get(since) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

export function startRebalanceScheduler(): void {
  if (!ENV.rebalanceSchedulerEnabled) return;

  setInterval(async () => {
    if (running) return;

    try {
      running = true;

      const node = getNodeInfo();
      if (node?.node_role !== "treasury") return;
      assertTreasury(node.node_role);

      if (hasRecentSucceededRebalance(ENV.rebalanceCooldownMinutes)) return;

      // Daily loss cap: check once per tick before any LND I/O
      try {
        assertDailyLossCapNotExceeded(0);
      } catch (err) {
        if (err instanceof DailyLossCapError) {
          console.warn("[rebalance-scheduler] daily loss cap reached — skipping:", err.message);
          return;
        }
        throw err;
      }

      if (ENV.rebalanceSchedulerDryRun) {
        // In dry-run mode, import health and log what would happen
        const { getLiquidityHealth } = await import("../api/treasury-liquidity-health");
        const health = getLiquidityHealth();
        const critical = health.filter((h) => h.is_active && h.health_classification === "critical");
        if (critical.length > 0) {
          console.log("[rebalance-scheduler][dry-run] would keysend push to critical channels:", critical.map((c) => ({
            channel_id: c.channel_id,
            imbalance_ratio: c.imbalance_ratio,
            local_sats: c.local_sats,
            capacity_sats: c.capacity_sats,
          })));
        }
        return;
      }

      const { results } = await autoKeysendRebalance();

      if (results.length > 0 && ENV.debug) {
        console.log("[rebalance-scheduler] keysend results:", results.map((r) => ({
          channel_id: r.channel_id,
          status: r.status,
          amount_sats: r.amount_sats,
          fee_paid_sats: r.fee_paid_sats,
        })));
      }
    } catch (e) {
      if (ENV.debug) console.error("[rebalance-scheduler] error:", e);
    } finally {
      running = false;
    }
  }, ENV.rebalanceSchedulerIntervalMs);
}
