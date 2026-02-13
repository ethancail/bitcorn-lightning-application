import { isLndAvailable, getLndInfo, getLndChannels } from "./lnd";
import { persistNodeInfo } from "./persist";
import { persistPeers, persistChannels } from "./persist-channels";
import { syncInboundPayments } from "./persist-inbound";
import { syncForwardingHistory } from "./persist-forwarded";
import { ENV } from "../config/env";

export async function syncLndState() {
  if (!isLndAvailable()) {
    return { ok: false, reason: "lnd_unavailable" };
  }

  const walletInfo = await getLndInfo();
  if (ENV.debug) {
    console.log("[lnd] wallet info:", walletInfo);
  }

  await persistPeers();
  await persistChannels();

  // Check for treasury channel after channels are persisted
  const { channels } = await getLndChannels();
  const treasuryPubkey = ENV.treasuryPubkey;
  
  const treasuryChannel = channels.find(
    c => c.partner_public_key === treasuryPubkey
  );
  
  const hasTreasuryChannel = !!treasuryChannel;
  const treasuryChannelActive = treasuryChannel?.is_active ?? false;
  
  // Compute membership status
  const synced = walletInfo.synced_to_chain ?? false;
  let membershipStatus: string;
  
  if (!synced) {
    membershipStatus = "unsynced";
  } else if (!hasTreasuryChannel) {
    membershipStatus = "no_treasury_channel";
  } else if (!treasuryChannelActive) {
    membershipStatus = "treasury_channel_inactive";
  } else {
    membershipStatus = "active_member";
  }

  await persistNodeInfo(hasTreasuryChannel, membershipStatus);
  await syncInboundPayments();
  await syncForwardingHistory();

  return { ok: true };
}