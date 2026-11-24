// outgoing-channel-pin (D2b): a member payment's treasury pin must reach LND
// as the REPEATED field outgoing_chan_ids (SendPaymentRequest field 19), never
// as the singular outgoing_chan_id (field 8).
//
// ─── WHY ────────────────────────────────────────────────────────────────────
//
// LND ≥0.21 declares field 8 `reserved`. A client that still sends it is not
// refused: the bytes land in the message's unknown fields and nothing reads
// them, so the payment goes out with NO first-hop restriction and no error.
// LND 0.20 and 0.21 both read field 19. lightning@11.1.0 (under ln-service
// 58.1.0) sends field 8 when given `outgoing_channel`, and field 19 when given
// `outgoing_channels` (subscribe_to_pay.js, the outgoingChannelIds task and
// the params block).
//
// ─── WHAT IS REAL AND WHAT IS STUBBED ───────────────────────────────────────
//
// REAL: payInvoice, and ln-service/lightning's payViaPaymentRequest →
// subscribeToPayViaRequest → subscribeToPay → lnd.router.sendPaymentV2(params).
// The params captured below are the object lightning hands the gRPC client.
// Mocking ln-service would make this test blind to the very translation it
// guards; hubChannel.sites.test.ts pins WHICH channel, this pins HOW it is sent.
//
// STUBBED, at the app's own module seams only:
//   - ./lnd getLndClient       → a fake lnd: router.sendPaymentV2 only (that is
//                                all isLnd() checks and all the path calls when
//                                max_timeout_height is unset — getHeight is
//                                skipped)
//   - ./hubChannel getHubChannel → the hub row, or null
//   - ./payFeeLimit memberMaxFeeMtokens → a fixed limit (it reads the node role
//                                from SQLite; the limit is not under test)
//   - ../subscription/tier2Gate → no-op (it reads subscription state)
//
// The fake stream ends with a sentinel error, and every case asserts that
// exact sentinel comes back out of payInvoice. A bare "it rejected" would also
// be satisfied by subscribeToPay's own synchronous validation throws, which
// fire BEFORE sendPaymentV2 — exactly the vacuous pass to rule out.

import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hub: null as null | { channel_id: string },
  maxFee: "5000" as string | null,
  sendPaymentV2: null as any,
}));

vi.mock("./lnd", () => ({
  getLndClient: () => ({ lnd: { router: { sendPaymentV2: state.sendPaymentV2 } } }),
}));
vi.mock("./hubChannel", () => ({ getHubChannel: () => state.hub }));
vi.mock("./payFeeLimit", () => ({ memberMaxFeeMtokens: () => state.maxFee }));
vi.mock("../subscription/tier2Gate", () => ({ assertTier2RoutingAllowed: () => {} }));

const { payInvoice } = await import("./pay");
const { parsePaymentRequest } = await import("ln-service");

// A regtest BOLT11 for 100,000 sats, signed with a throwaway key derived from
// sha256("bitcorn outgoing-channel-pin test key") via ln-service's
// createUnsignedRequest/createSignedRequest. Never funded, never paid: no LND
// sees it. lightning does not check expiry client-side, so it stays valid.
const REQUEST =
  "lnbcrt1m1p40lrvqpp5ylydfnl0nfr7ycnvg3lny6lsyjt8xc4j4tne65atvckq3z9hc0ls9qrssqdpgda6hgem0d9hxwttrdpskumn9dskhq6twyp6x2um5sp5cw04mqmq4k37ln9rcs9us6qxh7eck3k6h07zjrakf0d7nuu2cewsnp4qfnh6ex9n7kmn2un6m49elnuaay8f9umreu5v0z4gqf3cn8nedrgscqzpgvlm4mlygy9cfpsctf80jtallv6hguh3mc0p2mkhrqppcfawjlggn54383xhauffcuj9kgw4209k80tkskq0tudtahay27ukcqpgmeqcqyavka3";
const AMOUNT_MTOKENS = "100000000";

const HUB_CHANNEL = "943963x1975x1";
// Independent oracle for lightning's chanNumber: BOLT 7's short channel ID as
// a uint64, (block << 40) | (tx << 16) | output, in decimal. Not computed with
// bolt07, so a shared formatting bug cannot make both sides agree.
const HUB_CHANNEL_NUMBER = ((943963n << 40n) | (1975n << 16n) | 1n).toString();

const SENTINEL = [599, "TestStubEndsPaymentHere"];

function fakeSendPaymentV2() {
  return vi.fn((_params: Record<string, unknown>) => {
    const sub = new EventEmitter();
    setImmediate(() => sub.emit("error", SENTINEL));
    return sub;
  });
}

async function payAndCapture(): Promise<Record<string, unknown>> {
  await expect(payInvoice(REQUEST, AMOUNT_MTOKENS)).rejects.toEqual(SENTINEL);
  // Anti-vacuity: the payment actually reached the gRPC boundary, once.
  expect(state.sendPaymentV2).toHaveBeenCalledTimes(1);
  return state.sendPaymentV2.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  state.sendPaymentV2 = fakeSendPaymentV2();
  state.hub = null;
  state.maxFee = "5000";
});

describe("pay.ts outgoing-channel pin (D2b) — what lightning sends to SendPaymentV2", () => {
  it("runs on Node 24 (the app's runtime: .nvmrc, API Dockerfile)", () => {
    expect(process.versions.node.split(".")[0]).toBe("24");
  });

  it("the fixture parses as a regtest request for 100,000 sats", () => {
    const parsed = parsePaymentRequest({ request: REQUEST });
    expect(parsed.network).toBe("regtest");
    expect(parsed.mtokens).toBe(AMOUNT_MTOKENS);
  });

  it("member with a hub channel: the pin goes out as outgoing_chan_ids, outgoing_chan_id unset", async () => {
    state.hub = { channel_id: HUB_CHANNEL };

    const params = await payAndCapture();

    expect(params.payment_request).toBe(REQUEST);
    // Soft, so a red run reports BOTH fields: which one was set is the reason.
    expect.soft(params.outgoing_chan_ids).toEqual([HUB_CHANNEL_NUMBER]);
    expect.soft(params.outgoing_chan_id).toBeUndefined();
    // The fee limit rides the same call, unchanged by the pin fix.
    expect(params.fee_limit_msat).toBe("5000");
  });

  it("no hub channel (the treasury's own path): neither pin field is set", async () => {
    state.hub = null;
    state.maxFee = null;

    const params = await payAndCapture();

    expect(params.payment_request).toBe(REQUEST);
    expect(params.outgoing_chan_ids).toBeUndefined();
    expect(params.outgoing_chan_id).toBeUndefined();
  });
});
