// Fetches a Coinbase Onramp session token from the Bitcorn onramp Cloudflare
// Worker. The Worker holds the CDP credentials; this function just calls it.
//
// Worker-side: subscriber-base scope per the Stage 5a deltas. Any valid
// Bearer (payment or full) authorizes Onramp — the recovery-path
// rationale for lapsed members needing to buy BTC to renew.
//
// Routes through workerFetch() per spec §7.3 ("the only path Worker
// calls take"). workerFetch attaches the cached Bearer automatically
// and retries once on 401 bad_signature/expired.

import { workerFetch } from "../lib/workerFetch";

export async function getCoinbaseSessionToken(address: string): Promise<string> {
  const response = await workerFetch("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Session token worker error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { sessionToken: string };
  return data.sessionToken;
}
