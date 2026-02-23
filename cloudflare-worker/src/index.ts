// Bitcorn Lightning — Coinbase Onramp Session Token Worker
//
// This Worker generates Coinbase Onramp session tokens on behalf of all
// Bitcorn Lightning nodes. It holds the CDP API credentials as Cloudflare
// secrets so they never appear in any git repo or on user machines.
//
// Deploy:
//   cd cloudflare-worker
//   npm install
//   wrangler secret put CDP_KEY_NAME      # paste your key name
//   wrangler secret put CDP_PRIVATE_KEY   # paste your full PEM (one line with \n)
//   wrangler deploy
//
// The deployed URL (https://bitcorn-onramp.<you>.workers.dev) goes into
// COINBASE_WORKER_URL in the app's docker-compose.yml.

import { SignJWT, importPKCS8 } from "jose";

interface Env {
  CDP_KEY_NAME: string;
  CDP_PRIVATE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let address: string;
    try {
      const body = (await request.json()) as { address?: string };
      address = body.address ?? "";
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!address) {
      return new Response("Missing address", { status: 400 });
    }

    try {
      const privateKeyPem = env.CDP_PRIVATE_KEY.replace(/\\n/g, "\n");
      const privateKey = await importPKCS8(privateKeyPem, "ES256");

      const now = Math.floor(Date.now() / 1000);
      const jwt = await new SignJWT({
        sub: env.CDP_KEY_NAME,
        iss: "cdp",
        nbf: now,
        exp: now + 120,
        uri: "POST api.developer.coinbase.com/onramp/v1/token",
      })
        .setProtectedHeader({
          alg: "ES256",
          kid: env.CDP_KEY_NAME,
          nonce: crypto.randomUUID().replace(/-/g, ""),
        })
        .sign(privateKey);

      const tokenRes = await fetch(
        "https://api.developer.coinbase.com/onramp/v1/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({
            destination_wallets: [{ address, blockchains: ["bitcoin"] }],
          }),
        }
      );

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        console.error(`Coinbase token API error: ${tokenRes.status} ${text}`);
        return new Response("Failed to get session token", { status: 502 });
      }

      const { token } = (await tokenRes.json()) as { token: string };
      return Response.json({ sessionToken: token });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response("Internal error", { status: 500 });
    }
  },
};
