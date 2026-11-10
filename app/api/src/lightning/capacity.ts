// One capacity computation (drive-mode spec P1 item 2, §3.3; R18(4); R23(i)).
//
//   room to send    = local_balance  − local_reserve  [− funder headroom]
//   room to receive = remote_balance − remote_reserve
//
// lnd's local_balance is already net of the commitment fee and anchor outputs,
// and pending HTLCs are separate outputs, so neither is subtracted again
// (finding 1: lnd v0.20.1 channeldb/channel.go, rpcserver.go). The reserve is
// a constraint (local_constraints / remote_constraints). In-flight HTLCs are
// REPORTED as components and never subtracted.
//
// Funder headroom (R23(i), measured on regtest 2026-11-04: a funder's room was
// 4,530 sats above what lnd would send). From lnd v0.20.1-beta, an outgoing
// HTLC of `amt` is accepted iff, for the funder (initiator),
//
//   ourBalance + c − amt − B ≥ reserve, where
//     c = FeeForWeight(fpkw, W + n·172)       the last commitment's fee, added
//         back by computeView (lnwallet/channel.go:4736-4744);
//     B = FeeForWeight(2·fpkw, W + (n+2)·172)  CalcFeeBuffer (channel.go:3677-
//         3687) over a view that already holds the new HTLC (validateAddHtlc,
//         channel.go:6217-6243, 3836-3844; applyCommitFee with FeeBuffer,
//         channel.go:3745-3780; the reserve check, channel.go:3907-3933);
//     W = CommitWeight(type): 1124 anchors, 968 taproot, 724 legacy
//         (lnwallet/commitment.go:475-487; input/size.go:260-266);
//     172 = HTLCWeight (input/size.go:270); n = non-dust HTLCs in flight.
//
// So lnd's maximum is local − reserve − (B − c). ln-service gives neither the
// fee rate nor n's dust split, only the commitment's actual fee A, which is c
// or c + 1 (msat rounding of the two balances), plus trimmed dust HTLCs. From
// c ≤ A: fpkw < (A+1)·1000/(W + n·172) ≤ (A+1)·1000/W, and
//   B − c ≤ fpkw·(W + (n+4)·172)/1000 + 1 < (A+1)·(W + 688)/W + 1
// (with n taken as 0, the bound only grows with n, since (x+688)/x falls). So
//   headroom = ceil((A+1)·(W + 688)/W) + 1  ≥  B − c  always,
// which never overstates; with nothing in flight it is ~5 sats under lnd's
// figure. Each non-dust HTLC in flight understates by a further ~fpkw·0.105
// sats (263 at 2,500 sat/kw) — safe, and gone when it resolves.
//
// A non-funder pays no commitment fee and lnd keeps no buffer on its side
// (channel.go:3883-3905): room is local − reserve. But the funder must still
// afford the commitment fee of one more HTLC without dipping under its own
// reserve (channel.go:3934-3940), or lnd adds no non-dust HTLC at all; that
// extra fee is FeeForWeight(fpkw, 172) + ≤1 < (A+1)·172/W + 1.
//
// Reserves, the commit fee, the commitment type and the initiator flag are
// read from lnd and stored per channel by persist-channels.ts (migrations
// 064-067, 070). A row synced before those migrations has NULL there until the
// next sync tick (every 15 s). For that window: the reserve is taken as lnd's
// default, 1% of capacity, rounded up; an unknown initiator is treated as the
// funder; a funder with no commit fee yet gets room 0; an unknown type takes
// the smallest weight, 724, which gives the largest headroom. Each choice can
// only understate.

export type CapacityChannel = {
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  local_reserve_sat?: number | null;
  remote_reserve_sat?: number | null;
  pending_outgoing_sat?: number | null;
  pending_incoming_sat?: number | null;
  commit_fee_sat?: number | null;
  commitment_type?: string | null;
  /** 1 = this node opened (funded) the channel; 0 = the peer did (migration 070). */
  is_initiator?: number | null;
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

const HTLC_WEIGHT = 172; // input.HTLCWeight, lnd input/size.go:270

/** lnd's CommitWeight(chanType), lnwallet/commitment.go:475-487, by
 *  ln-service's type name. Unknown → the smallest, which overstates headroom. */
function commitWeight(type: string | null | undefined): number {
  switch (type) {
    case "anchor":
    case "anchor_with_lease_constraint":
      return 1124; // input.AnchorCommitWeight, size.go:263
    case "simplified_taproot":
      return 968; // input.TaprootCommitWeight, size.go:266
    default:
      return 724; // input.CommitWeight, size.go:260
  }
}

/** The funder's fee headroom, ceil((A+1)(W+688)/W) + 1 (R23(i)); see the
 *  header for the derivation. Exported for drive-mode P3's minimum-connection
 *  formula (transfers/minimumConnection.ts), so H has one source. */
export function funderHeadroomSats(commitFeeSat: number, commitmentType: string | null | undefined): number {
  const w = commitWeight(commitmentType);
  return Math.ceil(((commitFeeSat + 1) * (w + 4 * HTLC_WEIGHT)) / w) + 1;
}

/** Room to send under lnd's add-HTLC rule; see the header for the derivation. */
function roomToSend(ch: CapacityChannel, localReserve: number, remoteReserve: number): number {
  const base = ch.local_balance_sat - localReserve;
  const w = commitWeight(ch.commitment_type);
  const isFunder = ch.is_initiator !== 0; // NULL (not yet synced) → funder
  if (isFunder) {
    if (ch.commit_fee_sat == null) return 0;
    const headroom = funderHeadroomSats(ch.commit_fee_sat, ch.commitment_type);
    return Math.max(0, base - headroom);
  }
  if (ch.commit_fee_sat != null) {
    const funderExtraFee = Math.ceil(((ch.commit_fee_sat + 1) * HTLC_WEIGHT) / w) + 1;
    if (ch.remote_balance_sat - remoteReserve < funderExtraFee) return 0;
  }
  return Math.max(0, base);
}

export function capacityOf(ch: CapacityChannel): Capacity {
  const localReserve = reserveOr1Pct(ch.local_reserve_sat, ch.capacity_sat);
  const remoteReserve = reserveOr1Pct(ch.remote_reserve_sat, ch.capacity_sat);
  return {
    room_to_send_sats: roomToSend(ch, localReserve, remoteReserve),
    room_to_receive_sats: Math.max(0, ch.remote_balance_sat - remoteReserve),
    local_reserve_sats: localReserve,
    remote_reserve_sats: remoteReserve,
    pending_outgoing_sats: ch.pending_outgoing_sat ?? 0,
    pending_incoming_sats: ch.pending_incoming_sat ?? 0,
    commit_fee_sats: ch.commit_fee_sat ?? null,
  };
}
