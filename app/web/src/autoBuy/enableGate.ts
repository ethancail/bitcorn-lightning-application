// Whether the Auto-Buy "Enable" button may be pressed (kraken-autobuy P4e).
//
// It mirrors POST /api/autobuy/enable on the ACTIVE provider's credentials, so
// the button and the server agree: Coinbase needs its key; Kraken needs its key
// AND the node's withdraw address matched to a saved Kraken address. Both need
// the whitelist confirmed and fewer than 3 consecutive failures (the threshold-3
// hardcode is E7, unchanged here). The server still decides.

import type { AutoBuyStatus } from "../api/client";

export function canEnableAutoBuy(status: AutoBuyStatus): boolean {
  const cfg = status.config;
  if (!cfg) return false;
  const hasCredentials = cfg.provider === "kraken"
    ? !!status.kraken_credentials?.address_matched
    : !!status.credentials;
  return hasCredentials && !!cfg.withdraw_address_whitelisted_at && cfg.consecutive_failures < 3;
}
