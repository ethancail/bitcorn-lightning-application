// Coinbase Onramp session token generation.
// Builds a CDP-signed JWT and exchanges it for a one-time session token
// that can be passed to pay.coinbase.com as ?sessionToken=<token>.
//
// CDP JWT spec: https://docs.cdp.coinbase.com/advanced-trade/docs/rest-api-auth
// Onramp token API: POST https://api.developer.coinbase.com/onramp/v1/token

import * as crypto from "crypto";

const TOKEN_HOST = "api.developer.coinbase.com";
const TOKEN_PATH = "/onramp/v1/token";

function buildCdpJwt(keyName: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "ES256",
    kid: keyName,
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  const payload = {
    sub: keyName,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri: `POST ${TOKEN_HOST}${TOKEN_PATH}`,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  // ieee-p1363 produces the raw r||s format required by the ES256 JWT spec
  const signature = sign.sign(
    { key: privateKeyPem, dsaEncoding: "ieee-p1363" },
    "base64url"
  );

  return `${signingInput}.${signature}`;
}

export async function getCoinbaseSessionToken(
  keyName: string,
  privateKeyPem: string,
  address: string
): Promise<string> {
  const jwt = buildCdpJwt(keyName, privateKeyPem);

  const response = await fetch(`https://${TOKEN_HOST}${TOKEN_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      destination_wallets: [{ address, blockchains: ["bitcoin"] }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Coinbase token API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}
