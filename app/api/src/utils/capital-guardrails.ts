import { db } from "../db";
import { getCapitalPolicy } from "../api/treasury-capital-policy";
import { getLndChainBalance, getLndPendingChannels } from "../lightning/lnd";

const MIN_CHANNEL_SATS = 100_000;
const MAX_CHANNEL_SATS = 2_000_000;

/** Thrown when a capital guardrail policy is violated. */
export class CapitalGuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapitalGuardrailError";
  }
}

/** Pending capacity from our own execution records (requested/submitted). */
function getDbPendingSats(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(requested_capacity_sats), 0) AS v
       FROM treasury_expansion_executions
       WHERE status IN ('requested', 'submitted')`
    )
    .get() as { v: number };
  return row?.v ?? 0;
}

/** Total pending sats = DB pending + LND pending opens (source of truth for locked funds). */
function getTotalPendingSats(lndPendingOpenSats: number): number {
  return getDbPendingSats() + lndPendingOpenSats;
}

function getDeployedSats(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(capacity_sat), 0) AS v FROM lnd_channels`
    )
    .get() as { v: number };
  return row?.v ?? 0;
}

function getPeerDeployedSats(peerPubkey: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(capacity_sat), 0) AS v
       FROM lnd_channels
       WHERE peer_pubkey = ?`
    )
    .get(peerPubkey) as { v: number } | undefined;
  const channelSats = row?.v ?? 0;

  const pendingRow = db
    .prepare(
      `SELECT COALESCE(SUM(requested_capacity_sats), 0) AS v
       FROM treasury_expansion_executions
       WHERE peer_pubkey = ? AND status IN ('requested', 'submitted')`
    )
    .get(peerPubkey) as { v: number } | undefined;
  const pendingSats = pendingRow?.v ?? 0;

  return channelSats + pendingSats;
}

/** DB count of requested/submitted expansions. */
function getDbPendingOpensCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS v
       FROM treasury_expansion_executions
       WHERE status IN ('requested', 'submitted')`
    )
    .get() as { v: number };
  return row?.v ?? 0;
}

/** Pending opens count: DB + LND so we never undercount when some opens are from outside the app.
 *  Conservative: may overcount when all pending are from this app (same channel in both), but ensures
 *  we treat "1 from app + 1 external" as 2 pending, not 1. */
function getTotalPendingOpensCount(lndOpeningCount: number): number {
  return getDbPendingOpensCount() + lndOpeningCount;
}

/** Sum capacity of LND pending-opening channels to a given peer. */
function getLndPendingOpenSatsToPeer(
  pendingChannels: Array<{ is_opening?: boolean; capacity?: number; partner_public_key: string }>,
  peerPubkey: string
): number {
  return pendingChannels
    .filter((ch) => ch.is_opening === true && ch.partner_public_key === peerPubkey)
    .reduce((sum, ch) => sum + (ch.capacity ?? 0), 0);
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

function getDailyDeploySats(): number {
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

function getLastPeerExpansionAt(peerPubkey: string): number | null {
  const row = db
    .prepare(
      `SELECT MAX(created_at) AS created_at
       FROM treasury_expansion_executions
       WHERE peer_pubkey = ? AND status IN ('requested', 'submitted', 'succeeded')`
    )
    .get(peerPubkey) as { created_at: number | null };
  return row?.created_at ?? null;
}

/**
 * Asserts that opening a channel to the given peer with the given capacity
 * does not violate any capital guardrail. Call immediately before openTreasuryChannel().
 * @throws CapitalGuardrailError with a descriptive message on policy violation
 */
export async function assertCanExpand(
  peerPubkey: string,
  capacitySats: number
): Promise<void> {
  // Sanity: capacity in range
  if (!Number.isFinite(capacitySats) || capacitySats < MIN_CHANNEL_SATS || capacitySats > MAX_CHANNEL_SATS) {
    throw new CapitalGuardrailError(
      `Invalid capacity_sats: must be between ${MIN_CHANNEL_SATS} and ${MAX_CHANNEL_SATS}`
    );
  }

  const policy = getCapitalPolicy();
  const [confirmedBalance, pendingChannels] = await Promise.all([
    getLndChainBalance().then((r) => r.chain_balance),
    getLndPendingChannels(),
  ]);
  const channels = pendingChannels.pending_channels ?? [];
  const lndPendingOpenSats = channels
    .filter((ch) => ch.is_opening === true)
    .reduce((sum, ch) => sum + (ch.capacity ?? 0), 0);
  const pendingSats = getTotalPendingSats(lndPendingOpenSats);
  const pendingOpensCount = getTotalPendingOpensCount(
    channels.filter((ch) => ch.is_opening === true).length
  );
  const deployedSats = getDeployedSats();
  const peerDeployedSats =
    getPeerDeployedSats(peerPubkey) + getLndPendingOpenSatsToPeer(channels, peerPubkey);
  const expansionsToday = getExpansionsTodayCount();
  const dailyDeploySats = getDailyDeploySats();
  const lastPeerAt = getLastPeerExpansionAt(peerPubkey);

  // A. Min on-chain reserve: after this open, (balance - pending) - new_capacity >= min_reserve
  // We treat "after" as: confirmed - (pending + capacitySats) >= min_reserve
  const balanceAfterReserving = confirmedBalance - pendingSats - capacitySats;
  if (balanceAfterReserving < policy.min_onchain_reserve_sats) {
    throw new CapitalGuardrailError(
      `Policy violation: min on-chain reserve would be breached (would have ${balanceAfterReserving} sats, min ${policy.min_onchain_reserve_sats})`
    );
  }

  // A. Max deploy ratio: (deployed + pending + new) <= confirmed * max_deploy_ratio
  const maxDeploySats = Math.floor(
    (confirmedBalance * policy.max_deploy_ratio_ppm) / 1_000_000
  );
  const totalDeployedAfter = deployedSats + pendingSats + capacitySats;
  if (totalDeployedAfter > maxDeploySats) {
    throw new CapitalGuardrailError(
      `Policy violation: max deploy ratio would be exceeded (deployed+pending+new=${totalDeployedAfter}, max=${maxDeploySats})`
    );
  }

  // A. Max pending opens
  if (pendingOpensCount >= policy.max_pending_opens) {
    throw new CapitalGuardrailError(
      `Policy violation: pending opens limit reached (${pendingOpensCount}/${policy.max_pending_opens})`
    );
  }

  // B. Max sats per peer
  if (peerDeployedSats + capacitySats > policy.max_peer_capacity_sats) {
    throw new CapitalGuardrailError(
      `Policy violation: max sats per peer exceeded (peer would have ${peerDeployedSats + capacitySats}, max ${policy.max_peer_capacity_sats})`
    );
  }

  // B. Peer cooldown
  if (lastPeerAt != null && policy.peer_cooldown_minutes > 0) {
    const cooldownMs = policy.peer_cooldown_minutes * 60 * 1000;
    const elapsed = Date.now() - lastPeerAt;
    if (elapsed < cooldownMs) {
      const minutesLeft = Math.ceil((cooldownMs - elapsed) / 60000);
      throw new CapitalGuardrailError(
        `Policy violation: peer cooldown active (opened ${Math.floor(elapsed / 60000)} min ago, ${minutesLeft} min remaining)`
      );
    }
  }

  // C. Max expansions per day
  if (expansionsToday >= policy.max_expansions_per_day) {
    throw new CapitalGuardrailError(
      `Policy violation: max expansions per day reached (${expansionsToday}/${policy.max_expansions_per_day})`
    );
  }

  // C. Max sats per day
  if (dailyDeploySats + capacitySats > policy.max_daily_deploy_sats) {
    throw new CapitalGuardrailError(
      `Policy violation: max daily deploy would be exceeded (daily=${dailyDeploySats}, new=${capacitySats}, max=${policy.max_daily_deploy_sats})`
    );
  }
}
