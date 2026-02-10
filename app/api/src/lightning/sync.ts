import { isLndAvailable } from "./lnd";
import { persistNodeInfo } from "./persist";
import { persistPeers, persistChannels } from "./persist-channels";

export async function syncLndState() {
  if (!isLndAvailable()) {
    return { ok: false, reason: "lnd_unavailable" };
  }

  await persistNodeInfo();
  await persistPeers();
  await persistChannels();

  return { ok: true };
}