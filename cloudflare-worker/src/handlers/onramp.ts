import { SignJWT, importPKCS8 } from "jose";
import { sec1ToPkcs8Pem } from "../lib/sec1ToPkcs8";
import type { Env } from "../lib/types";

export async function handleOnramp(request: Request, env: Env): Promise<Response> {
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
}
