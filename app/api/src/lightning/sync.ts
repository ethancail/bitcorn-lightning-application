import { isLndAvailable, getLndInfo } from "./lnd";
import { persistNodeInfo } from "./persist";
import { persistPeers, persistChannels } from "./persist-channels";

export async function syncLndState() {
  if (!isLndAvailable()) {
    return { ok: false, reason: "lnd_unavailable" };
  }

  const walletInfo = await getLndInfo();
  console.log("[lnd] wallet info:", walletInfo);

  await persistNodeInfo();
  await persistPeers();
  await persistChannels();

  return { ok: true };
}