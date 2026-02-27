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

      // Daily loss cap: check once per tick before any LND I/O
      try {
        assertDailyLossCapNotExceeded(ENV.rebalanceDefaultMaxFeeSats);
      } catch (err) {
        if (err instanceof DailyLossCapError) {
          console.warn("[rebalance-scheduler] daily loss cap reached — skipping:", err.message);
          return;
        }
        throw err;
      }

      const { channels } = await getLndChannels();
      const byId = new Map(channels.map((c) => [c.id, c]));

      for (const target of receivers) {
        const incoming = byId.get(target.channel_id);
        if (!incoming) continue;

        const incomingSnap = snapshotChannelLiquidity(incoming);

        // Pre-filter and rank donor candidates by local ratio (mirrors rebalance-auto.ts)
        const maxFee = ENV.rebalanceDefaultMaxFeeSats;
        const buffer = ENV.rebalanceSafetyBufferSats;
        const candidateTokens = Math.min(ENV.rebalanceDefaultTokens, ENV.rebalanceMaxTokens);
        const outgoingCandidates = channels
          .filter((c) => c.is_active)
          .filter((c) => c.id !== incoming.id)
          .filter((c) => c.partner_public_key !== incoming.partner_public_key)
          .map((c) => ({ ch: c, snap: snapshotChannelLiquidity(c) }))
          .filter((x) => x.snap.local_available >= candidateTokens + maxFee + buffer)
          .sort((a, b) => b.snap.local_ratio_ppm - a.snap.local_ratio_ppm);

        for (const { ch: outgoing, snap: outgoingSnap } of outgoingCandidates) {
          const maxByOutgoing = Math.max(
            0,
            outgoingSnap.local_available - maxFee - buffer
          );
          const maxByIncoming = Math.max(
            0,
            incomingSnap.remote_available - buffer
          );

          const tokens = Math.min(
            ENV.rebalanceDefaultTokens,
            ENV.rebalanceMaxTokens,
            maxByOutgoing,
            maxByIncoming
          );

          if (tokens <= 0) continue;

          // Fee PPM guard: reject if fee/amount ratio is uneconomic
          const feePpm = Math.round((maxFee / tokens) * 1_000_000);
          if (feePpm > ENV.rebalanceMaxFeePpm) {
            if (ENV.debug) {
              console.log(
                `[rebalance-scheduler] skipping pair — fee PPM too high: ${feePpm}ppm > ${ENV.rebalanceMaxFeePpm}ppm max ` +
                  `(tokens=${tokens}, maxFee=${maxFee})`
              );
            }
            continue;
          }

          try {
            assertRebalancePairIsViable({
              outgoing: outgoingSnap,
              incoming: incomingSnap,
              tokens,
              maxFeeSats: maxFee,
            });
          } catch {
            continue;
          }

          if (ENV.rebalanceSchedulerDryRun) {
            console.log("[rebalance-scheduler][dry-run] would rebalance:", {
              outgoing_channel: outgoing.id,
              incoming_channel: incoming.id,
              tokens,
              fee_ppm: feePpm,
              max_fee_sats: maxFee,
            });
            return;
          }

          await executeCircularRebalance({
            tokens,
            outgoing_channel: outgoing.id,
            incoming_channel: incoming.id,
            max_fee_sats: maxFee,
          });

          return;
        }
      }
    } catch (e) {
      if (ENV.debug) console.error("[rebalance-scheduler] error:", e);
    } finally {
      running = false;
    }
  }, ENV.rebalanceSchedulerIntervalMs);
}
