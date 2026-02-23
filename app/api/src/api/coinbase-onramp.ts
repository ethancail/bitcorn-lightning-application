// Fetches a Coinbase Onramp session token from the Bitcorn onramp Cloudflare
// Worker. The Worker holds the CDP credentials; this function just calls it.
export async function getCoinbaseSessionToken(
  workerUrl: string,
  address: string
): Promise<string> {
  const response = await fetch(workerUrl, {
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
