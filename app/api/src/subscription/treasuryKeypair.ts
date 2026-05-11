// Treasury-side Ed25519 keypair for JWT signing.
//
// Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §6.1
//
// On first use (lazy init), generate a fresh Ed25519 keypair and
// persist as a JWK file at SECRETS_DIR/subscription_signing.jwk. The
// file is mode 0o600 in a 0o700 directory — same pattern the autobuy
// module established for `master.key`. Once generated, the keypair
// never rotates except by explicit operator action (delete the file).
//
// The public key in raw 32-byte form (base64url-encoded) is what the
// operator publishes to Cloudflare as `SUBSCRIPTION_PUBLIC_KEY`. An
// admin endpoint surfaces this string at first run for the operator
// to copy.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { generateKeyPair, exportJWK, importJWK, type JWK, type KeyLike } from "jose";

const SECRETS_DIR = process.env.SECRETS_DIR ?? "/data/secrets";
const SIGNING_KEY_PATH = join(SECRETS_DIR, "subscription_signing.jwk");

interface SigningKeypair {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicKeyBase64Url: string;
  /** JWK form of the public key, for Cloudflare-secret publication. */
  publicJwk: JWK;
}

let cached: SigningKeypair | null = null;

interface StoredKeyfile {
  privateJwk: JWK;
  publicJwk: JWK;
  created_at: number;
  algorithm: "EdDSA";
}

async function generateAndPersist(): Promise<StoredKeyfile> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const file: StoredKeyfile = {
    privateJwk: await exportJWK(privateKey),
    publicJwk: await exportJWK(publicKey),
    created_at: Date.now(),
    algorithm: "EdDSA",
  };
  const dir = dirname(SIGNING_KEY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(SIGNING_KEY_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
  console.log(`[subscription] generated Ed25519 signing keypair at ${SIGNING_KEY_PATH}`);
  return file;
}

function loadKeyfile(): StoredKeyfile | null {
  if (!existsSync(SIGNING_KEY_PATH)) return null;
  const raw = readFileSync(SIGNING_KEY_PATH, "utf8");
  const parsed = JSON.parse(raw) as StoredKeyfile;
  if (parsed.algorithm !== "EdDSA") {
    throw new Error(
      `[subscription] signing keyfile at ${SIGNING_KEY_PATH} has wrong algorithm: ${parsed.algorithm}`,
    );
  }
  return parsed;
}

/**
 * Loads (or generates on first run) the treasury's Ed25519 signing
 * keypair. Idempotent — subsequent calls return the cached instance.
 */
export async function getTreasurySigningKeypair(): Promise<SigningKeypair> {
  if (cached) return cached;
  const stored = loadKeyfile() ?? (await generateAndPersist());
  const privateKey = (await importJWK(stored.privateJwk, "EdDSA")) as KeyLike;
  const publicKey = (await importJWK(stored.publicJwk, "EdDSA")) as KeyLike;
  // The `x` field of the JWK is the base64url-encoded raw 32-byte
  // public key. That's the form the Cloudflare Worker will import
  // back into a CryptoKey for verification.
  const publicKeyBase64Url = String(stored.publicJwk.x ?? "");
  if (!publicKeyBase64Url) {
    throw new Error("[subscription] public JWK is missing the `x` field");
  }
  cached = {
    privateKey,
    publicKey,
    publicKeyBase64Url,
    publicJwk: stored.publicJwk,
  };
  return cached;
}

/**
 * Returns the public key in the form the operator copies into the
 * `SUBSCRIPTION_PUBLIC_KEY` Cloudflare secret. The Worker reconstructs
 * a CryptoKey from this base64url string via `importJWK({ kty: "OKP",
 * crv: "Ed25519", x: <this> })`.
 */
export async function getTreasuryPublicKeyForCloudflare(): Promise<{
  algorithm: "EdDSA";
  curve: "Ed25519";
  public_key_b64url: string;
  jwk: JWK;
}> {
  const kp = await getTreasurySigningKeypair();
  return {
    algorithm: "EdDSA",
    curve: "Ed25519",
    public_key_b64url: kp.publicKeyBase64Url,
    jwk: kp.publicJwk,
  };
}
