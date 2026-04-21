// Cloudflare Workers use the Web Crypto API which only accepts PKCS#8 format
// ("-----BEGIN PRIVATE KEY-----"). CDP keys come in SEC1 format
// ("-----BEGIN EC PRIVATE KEY-----"). This function wraps the SEC1 DER in a
// PKCS#8 AlgorithmIdentifier envelope for P-256 (secp256r1).
export function sec1ToPkcs8Pem(sec1Pem: string): string {
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
