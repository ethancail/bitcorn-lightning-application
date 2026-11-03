import { payViaPaymentRequest } from "ln-service";
import { getLndClient } from "./lnd";
import { getHubChannel } from "./hubChannel";
import { assertTier2RoutingAllowed } from "../subscription/tier2Gate";

/** The hub channel's ID (drive-mode P1 item 1): null on the treasury node,
 *  which has no channel to itself, and when no hub channel is active — the
 *  payment then carries no pin (R18(2), C8). */
function getTreasuryChannelId(): string | null {
  return getHubChannel()?.channel_id ?? null;
}

export async function payInvoice(paymentRequest: string) {
  // Tier 2 gate: refuse routing for members whose subscription is
  // prepay / routing_lapsed / close_due. May throw Tier2Denied which
  // the route handler maps to a 402 response. Per spec §5.2 the gate
  // attaches at the existing forced-routing chokepoint (V1).
  assertTier2RoutingAllowed();

  const { lnd } = getLndClient();
  const outgoingChannel = getTreasuryChannelId();

  // ⚠ HELD — NO DEADLINE, DELIBERATELY. This is the one raw ln-service call site
  // in the app that is NOT bounded; the other seven are. It is in
  // HELD_UNBOUNDED_CALLS (lightning/callDeadline.ts): a deadline cannot cancel
  // the call, so abandoning an in-flight payment leaves the outcome UNKNOWN —
  // the HTLC may already have settled. Retrying would be a double spend, not
  // retrying would be a lost payment, and nothing local can distinguish them.
  // A hung payment is a real cost, accepted knowingly against a worse one.
  // Pinned by lightning/heldCalls.test.ts.
  const result = await payViaPaymentRequest({
    lnd,
    request: paymentRequest,
    ...(outgoingChannel ? { outgoing_channel: outgoingChannel } : {}),
  });

  return {
    id: result.id,
    tokens: result.tokens,
    fee: result.fee,
    confirmed_at: result.confirmed_at,
  };
}
