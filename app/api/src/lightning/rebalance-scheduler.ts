/**
 * Automated circular rebalance scheduler: on the treasury node, periodically
 * finds outbound-starved/critical channels, picks a donor, and runs one rebalance.
 * Respects cooldown and never overlaps runs.
 */

import { ENV } from "../config/env";
import { getNodeInfo } from "../api/read";
import { assertTreasury } from "../utils/role";
import { getLiquidityHealth } from "../api/treasury-liquidity-health";
import { getLndChannels } from "./lnd";
import {
  snapshotChannelLiquidity,
  assertRebalancePairIsViable,
} from "../utils/rebalance-liquidity";
import { executeCircularRebalance } from "./rebalance-circular";
import { assertDailyLossCapNotExceeded, DailyLossCapError } from "../utils/loss-cap";
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

      const health = getLiquidityHealth();

      const receivers = health
        .filter((h) => h.is_active)
        .filter(
          (h) =>
            h.health_classification === "outbound_starved" ||
            h.health_classification === "critical"
        )
        .sort((a, b) => a.imbalance_ratio - b.imbalance_ratio);

      if (!receivers.length) return;

      const { channels } = await getLndChannels();
      const byId = new Map(channels.map((c) => [c.id, c]));

      for (const target of receivers) {
        const incoming = byId.get(target.channel_id);
        if (!incoming) continue;

        const outgoing = channels
          .filter((c) => c.is_active)
          .filter((c) => c.id !== incoming.id)
          .filter((c) => c.partner_public_key !== incoming.partner_public_key)
          .map((c) => ({ ch: c, snap: snapshotChannelLiquidity(c) }))
          .sort((a, b) => b.snap.local_ratio_ppm - a.snap.local_ratio_ppm)[0]
          ?.ch;

        if (!outgoing) continue;

        const incomingSnap = snapshotChannelLiquidity(incoming);
        const outgoingSnap = snapshotChannelLiquidity(outgoing);

        const maxByOutgoing = Math.max(
          0,
          outgoingSnap.local_available -
            ENV.rebalanceDefaultMaxFeeSats -
            ENV.rebalanceSafetyBufferSats
        );
        const maxByIncoming = Math.max(
          0,
          incomingSnap.remote_available - ENV.rebalanceSafetyBufferSats
        );

        const tokens = Math.min(
          ENV.rebalanceDefaultTokens,
          ENV.rebalanceMaxTokens,
          maxByOutgoing,
          maxByIncoming
        );

        if (tokens <= 0) continue;

        try {
          assertRebalancePairIsViable({
            outgoing: outgoingSnap,
            incoming: incomingSnap,
            tokens,
            maxFeeSats: ENV.rebalanceDefaultMaxFeeSats,
          });
        } catch {
          continue;
        }

        // Daily loss cap: halt automation if fee spend would exceed the cap
        try {
          assertDailyLossCapNotExceeded(ENV.rebalanceDefaultMaxFeeSats);
        } catch (err) {
          if (err instanceof DailyLossCapError) {
            console.warn("[rebalance-scheduler] daily loss cap reached — skipping:", err.message);
            return;
          }
          throw err;
        }

        if (ENV.rebalanceSchedulerDryRun) {
          console.log("[rebalance-scheduler][dry-run] would rebalance:", {
            outgoing_channel: outgoing.id,
            incoming_channel: incoming.id,
            tokens,
            max_fee_sats: ENV.rebalanceDefaultMaxFeeSats,
          });
          return;
        }

        await executeCircularRebalance({
          tokens,
          outgoing_channel: outgoing.id,
          incoming_channel: incoming.id,
          max_fee_sats: ENV.rebalanceDefaultMaxFeeSats,
        });

        return;
      }
    } catch (e) {
      if (ENV.debug) console.error("[rebalance-scheduler] error:", e);
    } finally {
      running = false;
    }
  }, ENV.rebalanceSchedulerIntervalMs);
}
