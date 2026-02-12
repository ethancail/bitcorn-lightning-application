import { isLndAvailable, getLndInfo, getLndChannels } from "./lnd";
import { persistNodeInfo } from "./persist";
import { persistPeers, persistChannels } from "./persist-channels";
import { ENV } from "../config/env";

export async function syncLndState() {
  if (!isLndAvailable()) {
    return { ok: false, reason: "lnd_unavailable" };
  }

  const walletInfo = await getLndInfo();
  console.log("[lnd] wallet info:", walletInfo);

  await persistPeers();
  await persistChannels();

  // Check for treasury channel after channels are persisted
  const { channels } = await getLndChannels();
  const treasuryPubkey = ENV.treasuryPubkey;
  const hasTreasuryChannel = channels.some(
    c => c.partner_public_key === treasuryPubkey
  );

  await persistNodeInfo(hasTreasuryChannel);

  return { ok: true };
}