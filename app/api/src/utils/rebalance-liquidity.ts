/**
 * Liquidity snapshot and viability checks for circular rebalance.
 * Enforces minimum remote ratio on incoming and local ratio on outgoing,
 * plus available balance checks (after reserves and safety buffer).
 */

import { ENV } from "../config/env";

export type ChannelLiquiditySnapshot = {
  id: string;
  capacity: number;
  is_active: boolean;

  local_balance: number;
  remote_balance: number;
  local_reserve: number;
  remote_reserve: number;

  local_available: number;
  remote_available: number;

  local_ratio_ppm: number;
  remote_ratio_ppm: number;
};

const clamp0 = (n: number) => (n < 0 ? 0 : n);

/** Input shape for LND/ln-service channel (no index signature so Channel is assignable). */
export type ChannelLiquidityInput = {
  id?: string;
  capacity?: number;
  local_balance?: number;
  remote_balance?: number;
  local_reserve?: number;
  remote_reserve?: number;
  is_active?: boolean;
};

/** Build a liquidity snapshot from an LND/ln-service channel object. */
export function snapshotChannelLiquidity(ch: ChannelLiquidityInput): ChannelLiquiditySnapshot {
  const capacity = Number(ch.capacity ?? 0);
  const local = Number(ch.local_balance ?? 0);
  const remote = Number(ch.remote_balance ?? 0);

  const ext = ch as ChannelLiquidityInput & { local_reserve_sats?: number; remote_reserve_sats?: number };
  const localReserve = Number(ext.local_reserve_sats ?? ch.local_reserve ?? 0);
  const remoteReserve = Number(ext.remote_reserve_sats ?? ch.remote_reserve ?? 0);

  const localAvail = clamp0(local - localReserve);
  const remoteAvail = clamp0(remote - remoteReserve);

  const localRatio = capacity > 0 ? Math.floor((local * 1_000_000) / capacity) : 0;
  const remoteRatio = capacity > 0 ? Math.floor((remote * 1_000_000) / capacity) : 0;

  return {
    id: String(ch.id ?? ""),
    capacity,
    is_active: !!ch.is_active,
    local_balance: local,
    remote_balance: remote,
    local_reserve: localReserve,
    remote_reserve: remoteReserve,
    local_available: localAvail,
    remote_available: remoteAvail,
    local_ratio_ppm: localRatio,
    remote_ratio_ppm: remoteRatio,
  };
}

const INCOMING_HINT =
  " This channel cannot receive inbound; pick a channel with higher remote.";
const OUTGOING_HINT =
  " This channel cannot spend outbound; pick one with higher local.";

/**
 * Throws if the outgoing/incoming pair is not viable for a circular rebalance
 * (active, min ratios, and available balances for tokens + fee + buffer).
 */
export function assertRebalancePairIsViable(args: {
  outgoing: ChannelLiquiditySnapshot;
  incoming: ChannelLiquiditySnapshot;
  tokens: number;
  maxFeeSats: number;
}): void {
  const { outgoing, incoming, tokens, maxFeeSats } = args;
  const buffer = ENV.rebalanceSafetyBufferSats;

  if (!outgoing.is_active) {
    throw new Error(`Outgoing channel is not active: ${outgoing.id}.${OUTGOING_HINT}`);
  }
  if (!incoming.is_active) {
    throw new Error(`Incoming channel is not active: ${incoming.id}.${INCOMING_HINT}`);
  }

  if (incoming.remote_ratio_ppm < ENV.rebalanceMinIncomingRemoteRatioPpm) {
    throw new Error(
      `Incoming channel has insufficient remote ratio: ${incoming.remote_ratio_ppm}ppm (min ${ENV.rebalanceMinIncomingRemoteRatioPpm}ppm). ` +
        `remote_balance=${incoming.remote_balance}, capacity=${incoming.capacity}.${INCOMING_HINT}`
    );
  }

  if (outgoing.local_ratio_ppm < ENV.rebalanceMinOutgoingLocalRatioPpm) {
    throw new Error(
      `Outgoing channel has insufficient local ratio: ${outgoing.local_ratio_ppm}ppm (min ${ENV.rebalanceMinOutgoingLocalRatioPpm}ppm). ` +
        `local_balance=${outgoing.local_balance}, capacity=${outgoing.capacity}.${OUTGOING_HINT}`
    );
  }

  if (incoming.remote_available < tokens + buffer) {
    throw new Error(
      `Incoming channel lacks remote available for ${tokens} sats. ` +
        `remote_available=${incoming.remote_available}, need>=${tokens + buffer}.${INCOMING_HINT}`
    );
  }

  if (outgoing.local_available < tokens + maxFeeSats + buffer) {
    throw new Error(
      `Outgoing channel lacks local available for ${tokens} sats + fee. ` +
        `local_available=${outgoing.local_available}, need>=${tokens + maxFeeSats + buffer}.${OUTGOING_HINT}`
    );
  }
}

/** Score for outgoing channel (higher = better to spend from). */
export function scoreOutgoing(outgoing: ChannelLiquiditySnapshot): number {
  return outgoing.local_ratio_ppm;
}

/** Score for incoming channel (higher = better to receive into). */
export function scoreIncoming(incoming: ChannelLiquiditySnapshot): number {
  return incoming.remote_ratio_ppm;
}
