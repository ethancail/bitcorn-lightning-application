/**
 * Automated Loop Out rebalance scheduler: on the treasury node, periodically
 * finds critical channels (>85% local) and initiates submarine swaps via
 * loopd to restore receive capacity. Monitors in-flight swaps each tick.
 */

import { ENV } from "../config/env";
import { getNodeInfo } from "../api/read";
import { assertTreasury } from "../utils/role";
import {
  assertDailyLossCapNotExceeded,
  DailyLossCapError,
} from "../utils/loss-cap";
import { isLoopAvailable } from "./loop";
import { autoLoopOutRebalance, monitorLoopSwaps } from "./rebalance-loop";
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

      // Check Loop availability — graceful skip if not installed
      const loop = await isLoopAvailable();
      if (!loop.available) {
        if (ENV.debug)
          console.log(
            "[rebalance-scheduler] Loop not available, skipping:",
            loop.error
          );
        return;
      }

      // Monitor in-flight swaps every tick (regardless of cooldown)
      try {
        await monitorLoopSwaps();
      } catch (err) {
        if (ENV.debug)
          console.error("[rebalance-scheduler] monitor error:", err);
      }

      if (hasRecentSucceededRebalance(ENV.rebalanceCooldownMinutes)) return;

      // Daily loss cap: check once per tick before any swap initiation
      try {
        assertDailyLossCapNotExceeded(0);
      } catch (err) {
        if (err instanceof DailyLossCapError) {
          console.warn(
            "[rebalance-scheduler] daily loss cap reached — skipping:",
            err.message
          );
          return;
        }
        throw err;
      }

      if (ENV.rebalanceSchedulerDryRun) {
        // In dry-run mode: log what would happen with quote estimates
        const { getLiquidityHealth } = await import(
          "../api/treasury-liquidity-health"
        );
        const { getLoopOutQuote } = await import("./loop");
        const health = getLiquidityHealth();
        const critical = health.filter(
          (h) => h.is_active && h.health_classification === "critical"
        );
        for (const ch of critical) {
          const targetLocal = Math.floor(ch.capacity_sats * 0.5);
          const amount = Math.max(
            ENV.loopMinRebalanceSats,
            ch.local_sats - targetLocal
          );
          try {
            const quote = await getLoopOutQuote(amount);
            console.log("[rebalance-scheduler][dry-run] would Loop Out:", {
              channel_id: ch.channel_id,
              amount_sats: amount,
              estimated_cost: quote.total_cost_sats,
              imbalance_ratio: ch.imbalance_ratio,
            });
          } catch {
            console.log("[rebalance-scheduler][dry-run] quote failed:", {
              channel_id: ch.channel_id,
              amount_sats: amount,
            });
          }
        }
        return;
      }

      const { results, skipped } = await autoLoopOutRebalance();

      if (ENV.debug) {
        if (results.length > 0) {
          console.log(
            "[rebalance-scheduler] Loop Out results:",
            results.map((r) => ({
              channel_id: r.channel_id,
              status: r.status,
              amount_sats: r.amount_sats,
              total_cost_sats: r.total_cost_sats,
            }))
          );
        }
        if (skipped.length > 0) {
          console.log("[rebalance-scheduler] skipped:", skipped);
        }
      }
    } catch (e) {
      if (ENV.debug) console.error("[rebalance-scheduler] error:", e);
    } finally {
      running = false;
    }
  }, ENV.rebalanceSchedulerIntervalMs);
}
