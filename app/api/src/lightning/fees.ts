import { updateRoutingFees } from "ln-service";
import { getLndClient } from "./lnd";
import { ENV } from "../config/env";

export async function applyTreasuryFeePolicy(
  base_fee_msat: number,
  fee_rate_ppm: number
): Promise<void> {
  const { lnd } = getLndClient();
  const base_fee_mtokens = String(base_fee_msat);

  if (ENV.debug) {
    console.log("[treasury] applying fee policy:", {
      base_fee_msat,
      fee_rate_ppm,
    });
  }

  await updateRoutingFees({
    lnd,
    base_fee_mtokens,
    fee_rate: fee_rate_ppm,
  });
}
