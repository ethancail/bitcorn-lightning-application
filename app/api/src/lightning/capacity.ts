// One capacity computation (drive-mode spec P1 item 2, §3.3; R18(4)).
//
//   room to send    = local_balance  − local_reserve
//   room to receive = remote_balance − remote_reserve
//
// lnd's local_balance is already net of the commitment fee and anchor outputs,
// and pending HTLCs are separate outputs, so neither is subtracted again
// (finding 1: lnd v0.20.1 channeldb/channel.go, rpcserver.go). The reserve is
// only a constraint (local_constraints / remote_constraints), so it is the one
// subtraction. In-flight HTLCs and the commitment fee are REPORTED as
// components and never subtracted.
//
// Reserves are read from lnd and stored per channel by persist-channels.ts
// (migrations 064/065). A row synced before those migrations has NULL there
// until the next sync tick (every 15 s); for that window the reserve is taken
// as lnd's default, 1% of capacity, rounded up.

export type CapacityChannel = {
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  local_reserve_sat?: number | null;
  remote_reserve_sat?: number | null;
  pending_outgoing_sat?: number | null;
  pending_incoming_sat?: number | null;
  commit_fee_sat?: number | null;
};

export type Capacity = {
  room_to_send_sats: number;
  room_to_receive_sats: number;
  local_reserve_sats: number;
  remote_reserve_sats: number;
  pending_outgoing_sats: number;
  pending_incoming_sats: number;
  commit_fee_sats: number | null;
};

function reserveOr1Pct(reserve: number | null | undefined, capacity: number): number {
  return reserve ?? Math.ceil(capacity * 0.01);
}

export function capacityOf(ch: CapacityChannel): Capacity {
  const localReserve = reserveOr1Pct(ch.local_reserve_sat, ch.capacity_sat);
  const remoteReserve = reserveOr1Pct(ch.remote_reserve_sat, ch.capacity_sat);
  return {
    room_to_send_sats: Math.max(0, ch.local_balance_sat - localReserve),
    room_to_receive_sats: Math.max(0, ch.remote_balance_sat - remoteReserve),
    local_reserve_sats: localReserve,
    remote_reserve_sats: remoteReserve,
    pending_outgoing_sats: ch.pending_outgoing_sat ?? 0,
    pending_incoming_sats: ch.pending_incoming_sat ?? 0,
    commit_fee_sats: ch.commit_fee_sat ?? null,
  };
}
