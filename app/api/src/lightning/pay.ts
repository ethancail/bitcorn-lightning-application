import { payViaPaymentRequest } from "ln-service";
import { getLndClient } from "./lnd";
import { db } from "../db";
import { ENV } from "../config/env";

/** Look up the active treasury channel ID (returns null on treasury node or if no channel). */
function getTreasuryChannelId(): string | null {
  if (!ENV.treasuryPubkey) return null;
  const row = db.prepare(
    "SELECT channel_id FROM lnd_channels WHERE peer_pubkey = ? AND active = 1 LIMIT 1"
  ).get(ENV.treasuryPubkey) as { channel_id: string } | undefined;
  return row?.channel_id ?? null;
}

export async function payInvoice(paymentRequest: string) {
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
