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
import { channelDataStalenessAlert } from "./channelDataStaleness";
import { classifyLanePurpose } from "../subscription/lanePurpose";
import { findContactByPubkey } from "../utils/contact-pubkey";
import { classifyNodeLookup } from "../profile/publicAliasOutcome";

export type AlertSeverity = "info" | "warning" | "critical";

export type TreasuryAlert = {
  type: string;
  /**
   * The plain-language heading the dashboard prints. SET WHERE EACH ALERT IS
   * CREATED — here, in channelDataStaleness.ts and in lndFaultAlerts.ts — never
   * derived from `type` by a consumer. Decision: SH1/SH2,
   * bitcorn-research decisions/2026-10-13-ui-redesign-shipping-plan-rulings-sh1-sh8.md.
   * The client prints this and falls back to "Treasury alert"; it does not
   * branch on `type` to choose a heading, so the Loop decision's flip
   * condition (decisions/2026-09-02-loop-unavailability-classification-taxonomy-and-copy.md,
   * "the first consumer that branches on the value") is not met by headings.
   * A heading states only what its type proves: LOOP_NOT_INSTALLED fires for
   * missing credentials and an unreachable daemon alike, so its heading names
   * no cause and no remediation.
   */
  heading: string;
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

/**
 * Age of the cached channel data the capital guardrails read.
 *
 * Two statements rather than a join: lnd_node_info is a singleton and the
 * channel aggregate has to survive an empty table, which an inner join would
 * turn into no row at all — collapsing exactly the case this needs to report.
 */
function readChannelDataAges(): {
  latestChannelUpdatedAt: number | null;
  channelRowCount: number;
  nodeInfoUpdatedAt: number | null;
} {
  const ch = db
    .prepare(
      `SELECT MAX(updated_at) AS latest, COUNT(*) AS n FROM lnd_channels`,
    )
    .get() as { latest: number | null; n: number } | undefined;

  const ni = db
    .prepare(`SELECT updated_at FROM lnd_node_info WHERE id = 1`)
    .get() as { updated_at: number | null } | undefined;

  return {
    latestChannelUpdatedAt: ch?.latest ?? null,
    channelRowCount: ch?.n ?? 0,
    nodeInfoUpdatedAt: ni?.updated_at ?? null,
  };
}

/**
 * Channel peers the server classifier calls `unclassified`. No `active`
 * predicate: an offline peer is still an untagged channel peer, unlike Tier 3's
 * lookup, which needs a channel it can close. Every peer goes through
 * classifyLanePurpose rather than a join on `contacts`, because it is the only
 * source of truth for a lane and contacts.pubkey is stored in any case.
 */
function readUnclassifiedChannelPeers(): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT peer_pubkey FROM lnd_channels ORDER BY peer_pubkey`)
    .all() as Array<{ peer_pubkey: string }>;
  return rows.map((r) => r.peer_pubkey).filter((pubkey) => classifyLanePurpose(pubkey) === "unclassified");
}

/** Keys with a close_due subscription row. Compared exactly, as Tier 3 does. */
function readCloseDuePubkeys(): Set<string> {
  const rows = db
    .prepare(`SELECT member_pubkey FROM subscription WHERE current_tier = 'close_due'`)
    .all() as Array<{ member_pubkey: string }>;
  return new Set(rows.map((r) => r.member_pubkey));
}

/**
 * The best name this node holds for a channel peer. SQLite only: this runs on a
 * surface polled every 60s, so it never makes a live gossip lookup.
 *
 * classifyNodeLookup is reused for the contact's name because older sync-peers
 * runs stored pubkey-derived placeholders in contacts.name, and nothing has
 * rewritten them. The other two stores key on the lowercased pubkey.
 */
function channelPeerName(pubkey: string): string {
  const contact = findContactByPubkey(pubkey);
  if (contact) {
    const lookup = classifyNodeLookup(pubkey, { ok: true, alias: contact.name });
    if (lookup.outcome === "alias") return lookup.alias;
  }
  const key = pubkey.toLowerCase();
  const privateName = db
    .prepare(`SELECT name FROM member_private_name WHERE pubkey = ?`)
    .get(key) as { name: string } | undefined;
  if (privateName) return privateName.name;
  const publicAlias = db
    .prepare(`SELECT alias FROM peer_public_alias WHERE pubkey = ? AND outcome = 'alias'`)
    .get(key) as { alias: string } | undefined;
  if (publicAlias) return publicAlias.alias;
  return pubkey.slice(0, 16);
}

export async function getTreasuryAlerts(): Promise<TreasuryAlert[]> {
  const now = Date.now();
  const alerts: TreasuryAlert[] = [];
  const policy = getCapitalPolicy();

  // --- Channel data staleness (REPORT-ONLY; nothing below refuses on it) ---
  // assertCanExpand() computes deployed capacity from lnd_channels with no age
  // predicate, and stale rows under-count, which makes its deploy-ratio and
  // per-peer checks EASIER to pass. Same shape as ONCHAIN_RESERVE_CHECK_SKIPPED
  // below: the point is that a guardrail reading zeros should not be
  // indistinguishable from one that passed.
  const staleness = channelDataStalenessAlert({ ...readChannelDataAges(), nowMs: now });
  if (staleness) alerts.push(staleness);

  // --- Rotation candidates ---
  const candidates = getRotationCandidates();
  if (candidates.length > 0) {
    const topScore = candidates[0].rotation_score;
    alerts.push({
      type: "ROTATION_CANDIDATES_PRESENT",
      heading: "Channels suggested for rotation",
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

  // --- Channel peers outside subscription scope ---
  // Tier 3's lane guard refuses the close of every peer that is neither merchant
  // nor farmer, and /token allocates with no lane read, so tagging the contact
  // is the only thing that brings such a peer into billing and enforcement.
  // Report-only. No try/catch, like the other SQLite producers here: swallowing
  // a failure would make this read clean because it did not run.
  const unclassifiedPeers = readUnclassifiedChannelPeers();
  if (unclassifiedPeers.length > 0) {
    const closeDue = readCloseDuePubkeys();
    alerts.push({
      type: "CHANNEL_PEERS_UNCLASSIFIED",
      heading: "Channel peers not tagged",
      severity: unclassifiedPeers.some((pubkey) => closeDue.has(pubkey)) ? "critical" : "warning",
      message:
        `${unclassifiedPeers.length} channel peer(s) aren't tagged. Tag each one in Contacts as merchant, ` +
        "farmer or external, so subscription billing and enforcement treat it correctly.",
      data: { count: unclassifiedPeers.length, names: unclassifiedPeers.map(channelPeerName) },
      at: now,
    });
  }

  // --- Daily loss cap ---
  const dailyLoss = getDailyLossSats();
  if (dailyLoss >= policy.max_daily_loss_sats) {
    alerts.push({
      type: "DAILY_LOSS_CAP_EXCEEDED",
      heading: "Daily loss limit reached",
      severity: "critical",
      message: `Daily loss cap exceeded — automation halted: ${dailyLoss} / ${policy.max_daily_loss_sats} sats`,
      data: { daily_loss_sats: dailyLoss, cap_sats: policy.max_daily_loss_sats },
      at: now,
    });
  } else if (dailyLoss >= policy.max_daily_loss_sats * 0.8) {
    alerts.push({
      type: "DAILY_LOSS_CAP_NEAR",
      heading: "Daily loss close to its limit",
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
      heading: "Daily expansion limit reached",
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
      heading: "Daily deployment close to its limit",
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
        heading: "On-chain reserve below its floor",
        severity: "critical",
        message: `On-chain reserve below minimum: ${chain_balance} < ${policy.min_onchain_reserve_sats} sats`,
        data: { chain_balance, min_reserve: policy.min_onchain_reserve_sats },
        at: now,
      });
    } else if (reserveBuffer < 1.2) {
      alerts.push({
        type: "ONCHAIN_RESERVE_NEAR",
        heading: "On-chain reserve close to its floor",
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
    // the 60s dashboard poll. getLndChainBalance() above is now bound too, at
    // the same 3s, inside its lnd.ts wrapper — so reaching this catch site is
    // the EXPECTED outcome of a wedged LND rather than an unreachable one.
    //
    // ⚠ THIS COMMENT USED TO SAY isLoopAvailable() BELOW CARRIED NO DEADLINE.
    // That was never true. It has always passed a 5s gRPC deadline — the
    // `rpcCall("GetInfo", …, 5_000)` inside `isLoopAvailable()` itself
    // (lightning/loop.ts) — and loop.ts
    // bounds every RPC it makes via a real `{ deadline: Date }` call option —
    // 30s by default, 60s for swap initiation. Unlike the Promise.race used on
    // the LND side, a gRPC deadline actually cancels the call. The Loop half of
    // this surface was never at risk; only the LND half was.
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
        heading: "On-chain reserve not checked",
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
      heading: "Rebalance scheduler in simulation mode",
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
        heading: "Loop Out available for critical channels",
        severity: "info",
        message: `${criticalCount} critical channel(s) can be rebalanced via Loop Out`,
        data: { critical_channels: criticalCount, loop_version: loop.version },
        at: now,
      });
    } else {
      alerts.push({
        type: "LOOP_NOT_INSTALLED",
        heading: "Loop unavailable while channels need rebalancing",
        severity: "warning",
        message: `${criticalCount} critical channel(s) need rebalancing but Loop is not available. Check that loopd is running.`,
        data: { critical_channels: criticalCount, error: loop.error },
        at: now,
      });
    }
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
      heading: "Valuation inputs need attention",
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
