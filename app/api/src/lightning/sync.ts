import { isLndAvailable } from "./lnd";
import { persistNodeInfo } from "./persist";

export async function syncLndState() {
  if (!isLndAvailable()) {
    return { ok: false, reason: "lnd_unavailable" };
  }

  await persistNodeInfo();

  return { ok: true };
}
