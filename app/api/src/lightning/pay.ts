import { payViaPaymentRequest } from "ln-service";
import { getLndClient } from "./lnd";
import { db } from "../db";
import { ENV } from "../config/env";
import { assertTier2RoutingAllowed } from "../subscription/tier2Gate";

/** Look up the active treasury channel ID (returns null on treasury node or if no channel). */
function getTreasuryChannelId(): string | null {
  if (!ENV.treasuryPubkey) return null;
  const row = db.prepare(
    "SELECT channel_id FROM lnd_channels WHERE peer_pubkey = ? AND active = 1 LIMIT 1"
  ).get(ENV.treasuryPubkey) as { channel_id: string } | undefined;
  return row?.channel_id ?? null;
}

export async function payInvoice(paymentRequest: string) {
  // Tier 2 gate: refuse routing for members whose subscription is
  // prepay / routing_lapsed / close_due. May throw Tier2Denied which
  // the route handler maps to a 402 response. Per spec §5.2 the gate
  // attaches at the existing forced-routing chokepoint (V1).
  assertTier2RoutingAllowed();

  const { lnd } = getLndClient();
  const outgoingChannel = getTreasuryChannelId();

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
