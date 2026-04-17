// HMAC-SHA256 signature utilities for the POST /valuation/manual endpoint.
// Canonical string: <ISO timestamp>\n<hex SHA-256 of JSON body>
// Signature: HMAC-SHA256 of canonical string with VALUATION_SUBMIT_HMAC, hex-encoded.

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return hex(digest);
}

export async function canonicalString(timestamp: string, body: string): Promise<string> {
  return `${timestamp}\n${await sha256Hex(body)}`;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signHmac(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(await canonicalString(timestamp, body)));
  return hex(sig);
}

export async function verifyHmac(
  secret: string,
  timestamp: string,
  body: string,
  signatureHex: string,
): Promise<boolean> {
  if (!/^[0-9a-f]+$/i.test(signatureHex) || signatureHex.length % 2 !== 0) return false;
  const sigBytes = new Uint8Array(signatureHex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
  }
  const key = await importKey(secret);
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(await canonicalString(timestamp, body)));
}
