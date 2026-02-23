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

// Cloudflare Workers use the Web Crypto API which only accepts PKCS#8 format
// ("-----BEGIN PRIVATE KEY-----"). CDP keys come in SEC1 format
// ("-----BEGIN EC PRIVATE KEY-----"). This function wraps the SEC1 DER in a
// PKCS#8 AlgorithmIdentifier envelope for P-256 (secp256r1).
function sec1ToPkcs8Pem(sec1Pem: string): string {
  // Strip PEM header/footer lines and all whitespace to get raw base64
  const b64 = sec1Pem
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("-----"))
    .join("")
    .replace(/\s/g, "");

  // Log any characters that aren't valid base64 (helps debug encoding issues)
  const invalidChars = [...b64].filter((c) => !/[A-Za-z0-9+/=]/.test(c));
  if (invalidChars.length > 0) {
    console.error("Invalid base64 char codes:", invalidChars.map((c) => c.charCodeAt(0)));
  }

  // Strip any non-base64 characters defensively before decoding
  const b64clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const sec1Der = Uint8Array.from(atob(b64clean), (c) => c.charCodeAt(0));

  const derLen = (n: number): number[] =>
    n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, (n >> 8) & 0xff, n & 0xff];

  // AlgorithmIdentifier: SEQUENCE { OID id-ecPublicKey, OID prime256v1 }
  const algId = [
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ];

  const octet = [0x04, ...derLen(sec1Der.length), ...sec1Der];
  const inner = [0x02, 0x01, 0x00, ...algId, ...octet]; // version + algId + key
  const pkcs8Der = new Uint8Array([0x30, ...derLen(inner.length), ...inner]);

  const b64out = btoa(String.fromCharCode(...pkcs8Der));
  const lines = (b64out.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

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
      const keyName = env.CDP_KEY_NAME.replace(/^["']|["']$/g, "");
      const sec1Pem = env.CDP_PRIVATE_KEY
        .replace(/^["']|["']$/g, "") // strip surrounding quotes if copied from JSON
        .replace(/\\n/g, "\n");
      const pkcs8Pem = sec1Pem.includes("BEGIN EC PRIVATE KEY")
        ? sec1ToPkcs8Pem(sec1Pem)
        : sec1Pem; // already PKCS#8, use as-is
      const privateKey = await importPKCS8(pkcs8Pem, "ES256");

      const now = Math.floor(Date.now() / 1000);
      const jwt = await new SignJWT({
        sub: keyName,
        iss: "cdp",
        nbf: now,
        exp: now + 120,
        uri: "POST api.developer.coinbase.com/onramp/v1/token",
      })
        .setProtectedHeader({ alg: "ES256", kid: keyName })
        .sign(privateKey);

      // Log JWT header + payload (not signature) to aid debugging
      const [hdr, pay] = jwt.split(".");
      console.log("JWT header:", atob(hdr.replace(/-/g, "+").replace(/_/g, "/")));
      console.log("JWT payload:", atob(pay.replace(/-/g, "+").replace(/_/g, "/")));

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
      console.error("Worker error:", err instanceof Error ? err.message : err);
      return new Response("Internal error", { status: 500 });
    }
  },
};
