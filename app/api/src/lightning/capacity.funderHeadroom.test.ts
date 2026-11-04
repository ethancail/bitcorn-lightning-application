// Drive-mode P1, R23(i) (D1.2's funder gap): room to send is NEVER above what
// lnd will actually send, and at most 1,000 sats below it, for a member who
// funded (initiated) the hub channel and for one who did not.
//
// The reference below is lnd v0.20.1-beta's own acceptance rule for adding an
// outgoing HTLC, written out independently of capacity.ts so the test does not
// grade the fix against itself:
//   - validateAddHtlc validates a view that already contains the new HTLC,
//     with the FeeBuffer (lnwallet/channel.go:6217-6243, 3836-3844);
//   - computeView adds the last commitment's fee back to the initiator's
//     balance (channel.go:4736-4744) and weighs CommitWeight(type) + 172 per
//     non-dust HTLC (channel.go:4854; lnwallet/commitment.go:475-487;
//     input/size.go:260-270);
//   - applyCommitFee with FeeBuffer subtracts CalcFeeBuffer, which is 2× the
//     fee rate over that weight plus one more HTLC (channel.go:3677-3687,
//     3745-3780);
//   - the result must stay at or above the channel reserve; for a non-
//     initiator, the initiator's balance after the higher commitment fee must
//     too (channel.go:3907-3940, 3883-3905).
// The probe binary search of 2026-11-04 measured lnd's real maximum on regtest:
// Farmer1 (funder) 6,483,936, Merchant1 (non-funder) 1,445,270 — both equal to
// this reference on those channels' numbers, below.

import { describe, expect, it } from "vitest";
import { capacityOf, type CapacityChannel } from "./capacity";

const HTLC_WEIGHT = 172; // input/size.go:270
const BASE_WEIGHT: Record<string, number> = {
  anchor: 1124, // input.AnchorCommitWeight, size.go:263
  anchor_with_lease_constraint: 1124,
  simplified_taproot: 968, // input.TaprootCommitWeight, size.go:266
  original: 724, // input.CommitWeight, size.go:260
  original_with_static_to_remote: 724,
};

const feeForWeight = (feePerKw: number, w: number) => Math.floor((feePerKw * w) / 1000);

type Ref = {
  ourMsat: number;
  theirMsat: number;
  reserve: number;
  remoteReserve: number;
  feePerKw: number;
  type: string;
  nHtlcs: number; // non-dust HTLCs already on the commitment
  initiator: boolean;
};

/** lnd's largest acceptable outgoing (non-dust) HTLC, in sats. */
function lndMaxSend(r: Ref): number {
  const w = BASE_WEIGHT[r.type];
  const tipFee = feeForWeight(r.feePerKw, w + r.nHtlcs * HTLC_WEIGHT);
  if (r.initiator) {
    // View with the new HTLC: weight w + (n+1)·172; CalcFeeBuffer adds one more.
    const buffer = feeForWeight(2 * r.feePerKw, w + (r.nHtlcs + 2) * HTLC_WEIGHT);
    const msat = r.ourMsat + tipFee * 1000 - buffer * 1000 - r.reserve * 1000;
    return Math.max(0, Math.floor(msat / 1000));
  }
  // Non-initiator: the initiator pays the higher commitment fee (NoBuffer) and
  // must stay at or above its reserve, or no non-dust HTLC can be added.
  const theirAfter =
    r.theirMsat + tipFee * 1000 - feeForWeight(r.feePerKw, w + (r.nHtlcs + 1) * HTLC_WEIGHT) * 1000;
  if (theirAfter < r.remoteReserve * 1000) return 0;
  return Math.max(0, Math.floor((r.ourMsat - r.reserve * 1000) / 1000));
}

/** The channel row the sync stores for that state. `extraFee` is the msat
 *  rounding lnd's commit_fee carries over the computed fee (0 or 1 sat). */
function rowFor(r: Ref, extraFee: 0 | 1): CapacityChannel {
  const w = BASE_WEIGHT[r.type];
  return {
    capacity_sat: 10_000_000,
    local_balance_sat: Math.floor(r.ourMsat / 1000),
    remote_balance_sat: Math.floor(r.theirMsat / 1000),
    local_reserve_sat: r.reserve,
    remote_reserve_sat: r.remoteReserve,
    commit_fee_sat: feeForWeight(r.feePerKw, w + r.nHtlcs * HTLC_WEIGHT) + extraFee,
    commitment_type: r.type,
    is_initiator: r.initiator ? 1 : 0,
    pending_outgoing_sat: 0,
    pending_incoming_sat: 0,
  };
}

describe("R23(i) — the regtest channels of 2026-11-04", () => {
  it("funder (Farmer1, 132x1x0): room to send ≤ lnd's measured maximum 6,483,936, within 1,000", () => {
    const farmer1: CapacityChannel = {
      capacity_sat: 10_000_000,
      local_balance_sat: 6_588_466,
      remote_balance_sat: 3_408_063,
      local_reserve_sat: 100_000,
      remote_reserve_sat: 100_000,
      commit_fee_sat: 2_811, // lncli commit_fee; the computed fee is 2,810
      commitment_type: "anchor",
      is_initiator: 1,
      pending_outgoing_sat: 0,
      pending_incoming_sat: 0,
    };
    const lndMax = 6_483_936;
    expect(lndMaxSend({ ourMsat: 6_588_466_000, theirMsat: 3_408_063_000, reserve: 100_000, remoteReserve: 100_000, feePerKw: 2500, type: "anchor", nHtlcs: 0, initiator: true }))
      .toBe(lndMax); // the reference reproduces the measurement
    const room = capacityOf(farmer1).room_to_send_sats;
    expect(room, "room to send must not exceed what lnd will send").toBeLessThanOrEqual(lndMax);
    expect(lndMax - room).toBeLessThanOrEqual(1_000);
  });

  it("non-funder (Merchant1, 126x1x0): room to send = lnd's measured maximum 1,445,270", () => {
    const merchant1: CapacityChannel = {
      capacity_sat: 10_000_000,
      local_balance_sat: 1_545_270,
      remote_balance_sat: 8_451_260,
      local_reserve_sat: 100_000,
      remote_reserve_sat: 100_000,
      commit_fee_sat: 2_810,
      commitment_type: "anchor",
      is_initiator: 0,
      pending_outgoing_sat: 0,
      pending_incoming_sat: 0,
    };
    const lndMax = 1_445_270;
    const room = capacityOf(merchant1).room_to_send_sats;
    expect(room).toBeLessThanOrEqual(lndMax);
    expect(lndMax - room).toBeLessThanOrEqual(1_000);
  });
});

describe("R23(i) — never above lnd, across fee rates, types and in-flight HTLCs", () => {
  const feeRates = [253, 1000, 2500, 2501, 7777, 12_500, 50_000];
  const balances = [6_588_466_123, 1_545_270_999, 300_000_000, 9_000_000_500];
  const types = Object.keys(BASE_WEIGHT);
  const cases: Array<Ref & { extraFee: 0 | 1 }> = [];
  for (const initiator of [true, false])
    for (const type of types)
      for (const feePerKw of feeRates)
        for (const ourMsat of balances)
          for (const nHtlcs of [0, 1, 3])
            for (const extraFee of [0, 1] as const)
              cases.push({
                ourMsat, theirMsat: 10_000_000_000 - ourMsat - 2_000_000, reserve: 100_000, remoteReserve: 100_000,
                feePerKw, type, nHtlcs, initiator, extraFee,
              });

  it(`room to send ≤ lnd's maximum in all ${2 * 5 * 7 * 4 * 3 * 2} states; within 1,000 with no HTLC in flight`, () => {
    const over: string[] = [];
    const tooLow: string[] = [];
    for (const c of cases) {
      const lndMax = lndMaxSend(c);
      const room = capacityOf(rowFor(c, c.extraFee)).room_to_send_sats;
      const tag = `${c.initiator ? "funder" : "non-funder"} ${c.type} ${c.feePerKw}sat/kw our=${c.ourMsat}msat n=${c.nHtlcs} +${c.extraFee}`;
      if (room > lndMax) over.push(`${tag}: room ${room} > lnd ${lndMax}`);
      if (c.nHtlcs === 0 && lndMax - room > 1_000) tooLow.push(`${tag}: room ${room}, lnd ${lndMax}`);
    }
    expect(over, "overstated (the bug)").toEqual([]);
    expect(tooLow, "more than 1,000 below lnd with nothing in flight").toEqual([]);
  });

  it("non-funder whose funder cannot afford one more HTLC's fee: room 0, as lnd refuses", () => {
    const r: Ref = {
      ourMsat: 9_000_000_000, theirMsat: 100_000_000 + 100_000, reserve: 100_000, remoteReserve: 100_000,
      feePerKw: 2500, type: "anchor", nHtlcs: 0, initiator: false,
    };
    expect(lndMaxSend(r)).toBe(0);
    expect(capacityOf(rowFor(r, 0)).room_to_send_sats).toBe(0);
  });
});
