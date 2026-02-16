import { db } from "../db";
import { ENV } from "../config/env";

export type TreasuryMetrics = {
  as_of: number;

  all_time: {
    inbound_sats: number;
    outbound_sats: number;
    outbound_fees_sats: number;
    forwarded_fees_sats: number;
    rebalance_costs_sats: number;
    net_sats: number;
  };

  last_24h: {
    inbound_sats: number;
    outbound_sats: number;
    outbound_fees_sats: number;
    forwarded_fees_sats: number;
    rebalance_costs_sats: number;
    net_sats: number;
  };

  liquidity: {
    channels_total: {
      local_sats: number;
      remote_sats: number;
      capacity_sats: number;
      active_count: number;
      total_count: number;
    };
    treasury_channel: null | {
      peer_pubkey: string;
      local_sats: number;
      remote_sats: number;
      capacity_sats: number;
      is_active: boolean;
      updated_at: number;
    };
  };

  /** Layer 2 — Capital efficiency: how hard capital is working, runway. */
  capital_efficiency: {
    /** Total local liquidity across all channels (capital deployed). */
    capital_deployed_sats: number;
    /** Forwarding fees / capital deployed (revenue yield ratio). */
    revenue_yield: number;
    /** Revenue per 1M sats deployed — normalized LSP comparison metric. */
    revenue_per_1m_sats_deployed: number;
    /** Days until liquidity exhaustion at current burn rate; null if not net outbound. */
    runway_days: number | null;
  };
};

function sumNumber(sql: string, params: any[] = []): number {
  const row = db.prepare(sql).get(...params) as any;
  const v = row ? row.v : 0;
  return typeof v === "number" ? v : 0;
}

export function getTreasuryMetrics(): TreasuryMetrics {
  const now = Date.now();
  const since24h = now - 24 * 60 * 60 * 1000;

  // INBOUND: confirmed invoices we've received (revenue)
  const inboundAll = sumNumber(
    `SELECT COALESCE(SUM(tokens), 0) AS v FROM payments_inbound`
  );
  const inbound24 = sumNumber(
    `SELECT COALESCE(SUM(tokens), 0) AS v FROM payments_inbound WHERE settled_at >= ?`,
    [since24h]
  );

  // OUTBOUND: payments we've sent (spend)
  const outboundAll = sumNumber(
    `SELECT COALESCE(SUM(tokens), 0) AS v
     FROM payments_outbound
     WHERE status = 'succeeded'`
  );
  const outbound24 = sumNumber(
    `SELECT COALESCE(SUM(tokens), 0) AS v
     FROM payments_outbound
     WHERE status = 'succeeded' AND created_at >= ?`,
    [since24h]
  );

  // OUTBOUND FEES: fees we paid when sending
  const outboundFeesAll = sumNumber(
    `SELECT COALESCE(SUM(fee), 0) AS v
     FROM payments_outbound
     WHERE status = 'succeeded'`
  );
  const outboundFees24 = sumNumber(
    `SELECT COALESCE(SUM(fee), 0) AS v
     FROM payments_outbound
     WHERE status = 'succeeded' AND created_at >= ?`,
    [since24h]
  );

  // FORWARDED FEES: routing income earned as an intermediate hop
  const forwardedFeesAll = sumNumber(
    `SELECT COALESCE(SUM(fee), 0) AS v FROM payments_forwarded`
  );
  const forwardedFees24 = sumNumber(
    `SELECT COALESCE(SUM(fee), 0) AS v FROM payments_forwarded WHERE created_at >= ?`,
    [since24h]
  );

  // REBALANCE COSTS: circular rebalance, loop, manual — reduces true net
  const rebalanceCostsAll = sumNumber(
    `SELECT COALESCE(SUM(fee_paid_sats), 0) AS v FROM treasury_rebalance_costs`
  );
  const rebalanceCosts24 = sumNumber(
    `SELECT COALESCE(SUM(fee_paid_sats), 0) AS v FROM treasury_rebalance_costs WHERE created_at >= ?`,
    [since24h]
  );

  const netAll =
    inboundAll + forwardedFeesAll - outboundAll - outboundFeesAll - rebalanceCostsAll;
  const net24 =
    inbound24 + forwardedFees24 - outbound24 - outboundFees24 - rebalanceCosts24;

  // Liquidity snapshot (from your persisted channels table)
  const channelsTotals = db
    .prepare(
      `SELECT
         COALESCE(SUM(capacity_sat), 0) AS capacity_sats,
         COALESCE(SUM(local_balance_sat), 0) AS local_sats,
         COALESCE(SUM(remote_balance_sat), 0) AS remote_sats,
         COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active_count,
         COUNT(*) AS total_count
       FROM lnd_channels`
    )
    .get() as any;

  const capitalDeployed = channelsTotals?.local_sats ?? 0;

  // Layer 2 — Capital efficiency
  const revenueYield =
    capitalDeployed > 0 ? forwardedFeesAll / capitalDeployed : 0;
  const revenuePer1mSats =
    capitalDeployed > 0
      ? (forwardedFeesAll / capitalDeployed) * 1_000_000
      : 0;
  const avgDailyOutbound = outbound24;
  const isNetOutbound = outbound24 > inbound24;
  const runwayDays: number | null =
    isNetOutbound && avgDailyOutbound > 0 && capitalDeployed > 0
      ? capitalDeployed / avgDailyOutbound
      : null;

  let treasuryChannel: TreasuryMetrics["liquidity"]["treasury_channel"] = null;

  if (ENV.treasuryPubkey) {
    const row = db
      .prepare(
        `SELECT
           peer_pubkey,
           capacity_sat AS capacity_sats,
           local_balance_sat AS local_sats,
           remote_balance_sat AS remote_sats,
           active AS is_active,
           updated_at
         FROM lnd_channels
         WHERE peer_pubkey = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(ENV.treasuryPubkey) as any;

    if (row) {
      treasuryChannel = {
        peer_pubkey: row.peer_pubkey,
        local_sats: row.local_sats ?? 0,
        remote_sats: row.remote_sats ?? 0,
        capacity_sats: row.capacity_sats ?? 0,
        is_active: !!row.is_active,
        updated_at: row.updated_at ?? 0,
      };
    }
  }

  return {
    as_of: now,
    all_time: {
      inbound_sats: inboundAll,
      outbound_sats: outboundAll,
      outbound_fees_sats: outboundFeesAll,
      forwarded_fees_sats: forwardedFeesAll,
      rebalance_costs_sats: rebalanceCostsAll,
      net_sats: netAll,
    },
    last_24h: {
      inbound_sats: inbound24,
      outbound_sats: outbound24,
      outbound_fees_sats: outboundFees24,
      forwarded_fees_sats: forwardedFees24,
      rebalance_costs_sats: rebalanceCosts24,
      net_sats: net24,
    },
    liquidity: {
      channels_total: {
        local_sats: channelsTotals?.local_sats ?? 0,
        remote_sats: channelsTotals?.remote_sats ?? 0,
        capacity_sats: channelsTotals?.capacity_sats ?? 0,
        active_count: channelsTotals?.active_count ?? 0,
        total_count: channelsTotals?.total_count ?? 0,
      },
      treasury_channel: treasuryChannel,
    },
    capital_efficiency: {
      capital_deployed_sats: capitalDeployed,
      revenue_yield: Math.round(revenueYield * 1e6) / 1e6,
      revenue_per_1m_sats_deployed: Math.round(revenuePer1mSats * 2) / 2,
      runway_days: runwayDays != null ? Math.round(runwayDays * 10) / 10 : null,
    },
  };
}
