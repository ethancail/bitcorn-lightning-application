import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// The same master key used elsewhere in the app (e.g. JWT signing). Generated
// on first API run with 32 random bytes and stored at this path. If it doesn't
// exist (fresh install before any other module touched it), we create it here
// rather than silently failing.
//
// SECRETS_DIR is env-configurable (default `/data/secrets`) so local-dev
// instances can point at a writable directory outside the Umbrel volume mount.
// Production behavior on Umbrel is unchanged — the fallback resolves to the
// volume-mounted `/data/secrets` directory.
const SECRETS_DIR = process.env.SECRETS_DIR ?? "/data/secrets";
const MASTER_KEY_PATH = join(SECRETS_DIR, "master.key");

// HKDF "info" context string — domain-separates the auto-buy credential key
// from any other key derived from the same master secret. Changing this
// string invalidates all previously-encrypted blobs.
const HKDF_INFO = "coinbase-autobuy";

function loadOrCreateMasterKey(): Buffer {
  if (existsSync(MASTER_KEY_PATH)) {
    const buf = readFileSync(MASTER_KEY_PATH);
    if (buf.length < 16) {
      throw new Error(`[credentials] master key at ${MASTER_KEY_PATH} is too short (got ${buf.length} bytes)`);
    }
    return buf;
  }
  // First run — create a 32-byte secret and persist it with restrictive mode.
  const dir = dirname(MASTER_KEY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(MASTER_KEY_PATH, key, { mode: 0o600 });
  console.log(`[credentials] initialized master key at ${MASTER_KEY_PATH}`);
  return key;
}

// HKDF-SHA256 extract-then-expand. Node 15+ has crypto.hkdfSync, but we
// implement by hand to avoid version-gating and to make the derivation
// explicit for code review.
function hkdfSha256(masterKey: Buffer, info: string, lengthBytes: number): Buffer {
  // Extract: PRK = HMAC-SHA256(salt=0*32, IKM=masterKey)
  const salt = Buffer.alloc(32, 0);
  const prk = createHmac("sha256", salt).update(masterKey).digest();
  // Expand: T(1) = HMAC-SHA256(PRK, info || 0x01), output first lengthBytes bytes
  const infoBuf = Buffer.from(info, "utf8");
  const t1 = createHmac("sha256", prk).update(Buffer.concat([infoBuf, Buffer.from([0x01])])).digest();
  return t1.subarray(0, lengthBytes);
}

let cachedKey: Buffer | null = null;
function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const master = loadOrCreateMasterKey();
  cachedKey = hkdfSha256(master, HKDF_INFO, 32);
  return cachedKey;
}

export interface EncryptedBlob {
  ciphertext: Buffer; // ciphertext || authTag  (GCM convention)
  nonce: Buffer;      // 12 bytes
}

/**
 * Encrypt a plaintext PEM. Returns ciphertext (with appended 16-byte auth
 * tag) and a fresh 12-byte nonce. Caller persists both in the DB row.
 */
export function encrypt(plaintext: string): EncryptedBlob {
  const key = getEncryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, authTag]), nonce };
}

/**
 * Decrypt a blob. Throws "credentials_corrupted" if the auth tag doesn't
 * verify — the caller (route handler) maps that to a 500 response that
 * prompts the operator to reconnect their Coinbase credentials.
 */
export function decrypt(blob: EncryptedBlob): string {
  const key = getEncryptionKey();
  if (blob.ciphertext.length < 16) {
    throw new Error("credentials_corrupted");
  }
  const authTag = blob.ciphertext.subarray(blob.ciphertext.length - 16);
  const enc = blob.ciphertext.subarray(0, blob.ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, blob.nonce);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("credentials_corrupted");
  }
}

// Helper for debugging — NEVER call this in a running API. Returns a hash of
// the master key so you can compare across runs without exposing it.
export function masterKeyFingerprint(): string {
  return createHash("sha256").update(loadOrCreateMasterKey()).digest("hex").slice(0, 16);
}
