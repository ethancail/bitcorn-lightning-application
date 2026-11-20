// P0 Suite D — characterization of credential encryption (credentials.ts):
// the AES-256-GCM round-trip, the master key's creation, and the HKDF-SHA256
// derivation pinned INDEPENDENTLY of the module.
//
// Authority: bitcorn-research/specs/2026-11-18-kraken-autobuy-slice-1-spec.md
// §3 P0, decision D3+. PINS CURRENT BEHAVIOUR.
//
// Why D4 exists: encrypt and decrypt derive the key the same way, so a changed
// HKDF label keeps D1's round-trip green while every blob stored in production
// becomes unreadable. D4 re-derives the key outside the module (by hand, and
// cross-checked with crypto.hkdfSync) and decrypts the blob with it; it is the
// case a label change turns red.
//
// Module state: SECRETS_DIR is read at module load (:20) and the derived key is
// cached at :58 with no reset export. So each case points SECRETS_DIR at a
// fresh temp dir and imports a FRESH module (vi.resetModules + dynamic import).
// No mocks: real crypto, real filesystem (under os.tmpdir()).

import fs from "fs";
import os from "os";
import path from "path";
import { createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Creds = typeof import("./credentials");

let root: string;
let secretsDir: string;

async function freshModule(dir = secretsDir): Promise<Creds> {
  process.env.SECRETS_DIR = dir;
  vi.resetModules();
  return import("./credentials");
}

const masterPath = () => path.join(secretsDir, "master.key");

/** The key the spec says the module derives: HKDF-SHA256, 32 zero bytes of salt, info "coinbase-autobuy", T(1). */
function deriveIndependently(master: Buffer): Buffer {
  const prk = createHmac("sha256", Buffer.alloc(32, 0)).update(master).digest();
  const t1 = createHmac("sha256", prk).update(Buffer.concat([Buffer.from("coinbase-autobuy", "utf8"), Buffer.from([0x01])])).digest();
  return t1.subarray(0, 32);
}

function decryptWith(key: Buffer, blob: { ciphertext: Buffer; nonce: Buffer }): string {
  const tag = blob.ciphertext.subarray(blob.ciphertext.length - 16);
  const enc = blob.ciphertext.subarray(0, blob.ciphertext.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, blob.nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const PEM = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIabc\ndef+/=\n-----END EC PRIVATE KEY-----\n";

let savedSecretsDir: string | undefined;

beforeEach(() => {
  savedSecretsDir = process.env.SECRETS_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-cred-unit-"));
  secretsDir = path.join(root, "secrets");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedSecretsDir === undefined) delete process.env.SECRETS_DIR;
  else process.env.SECRETS_DIR = savedSecretsDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("D · credential encryption", () => {
  it("D1 encrypt -> decrypt round-trips a multi-line PEM", async () => {
    const m = await freshModule();
    expect(m.decrypt(m.encrypt(PEM))).toBe(PEM);
  });

  it("D2 blob shape: 12-byte nonce; ciphertext = plaintext bytes + 16-byte tag; a fresh nonce each call", async () => {
    const m = await freshModule();
    const a = m.encrypt(PEM);
    const b = m.encrypt(PEM);
    expect(a.nonce.length).toBe(12);
    expect(a.ciphertext.length).toBe(Buffer.byteLength(PEM, "utf8") + 16);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("D3 first use creates master.key: 32 bytes, mode 0600, in a new directory with mode 0700 (modulo umask)", async () => {
    expect(fs.existsSync(secretsDir)).toBe(false);
    const m = await freshModule();
    m.encrypt(PEM);
    const umask = process.umask();
    const key = fs.readFileSync(masterPath());
    expect(key.length).toBe(32);
    expect(fs.statSync(masterPath()).mode & 0o777).toBe(0o600 & ~umask);
    expect(fs.statSync(secretsDir).mode & 0o777).toBe(0o700 & ~umask);
  });

  it("D4 an INDEPENDENT HKDF-SHA256 derivation (salt 32 zero bytes, info 'coinbase-autobuy', T(1)) decrypts the module's blob", async () => {
    const m = await freshModule();
    const blob = m.encrypt(PEM);
    const master = fs.readFileSync(masterPath());
    const key = deriveIndependently(master);
    // The hand-rolled HKDF is the RFC 5869 one: Node's hkdfSync agrees.
    expect(Buffer.from(hkdfSync("sha256", master, Buffer.alloc(32, 0), "coinbase-autobuy", 32)).equals(key)).toBe(true);
    expect(decryptWith(key, blob)).toBe(PEM);
  });

  it("D5 a master key shorter than 16 bytes throws 'too short'", async () => {
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(masterPath(), randomBytes(15));
    const m = await freshModule();
    expect(() => m.encrypt(PEM)).toThrow(/too short \(got 15 bytes\)/);
  });

  it("D6 tampering -> credentials_corrupted: a ciphertext byte, a tag byte, a different nonce, a ciphertext under 16 bytes", async () => {
    const m = await freshModule();
    const blob = m.encrypt(PEM);

    const flipCt = Buffer.from(blob.ciphertext);
    flipCt[0] ^= 0x01;
    expect(() => m.decrypt({ ciphertext: flipCt, nonce: blob.nonce })).toThrow(/^credentials_corrupted$/);

    const flipTag = Buffer.from(blob.ciphertext);
    flipTag[flipTag.length - 1] ^= 0x01;
    expect(() => m.decrypt({ ciphertext: flipTag, nonce: blob.nonce })).toThrow(/^credentials_corrupted$/);

    const otherNonce = Buffer.from(blob.nonce);
    otherNonce[0] ^= 0x01;
    expect(() => m.decrypt({ ciphertext: blob.ciphertext, nonce: otherNonce })).toThrow(/^credentials_corrupted$/);

    expect(() => m.decrypt({ ciphertext: Buffer.alloc(15), nonce: blob.nonce })).toThrow(/^credentials_corrupted$/);
  });

  it("D7 [+] the derived key is cached for the module's life (:58-63): replacing master.key on disk changes neither decrypt nor encrypt — but masterKeyFingerprint reads the file fresh", async () => {
    const m = await freshModule();
    const blob1 = m.encrypt(PEM);
    const originalMaster = fs.readFileSync(masterPath());
    const fp1 = m.masterKeyFingerprint();

    fs.writeFileSync(masterPath(), randomBytes(32));

    expect(m.decrypt(blob1)).toBe(PEM);
    const blob2 = m.encrypt(PEM);
    expect(decryptWith(deriveIndependently(originalMaster), blob2)).toBe(PEM);
    expect(m.masterKeyFingerprint()).not.toBe(fp1);
  });

  it("D8 a fresh module over a DIFFERENT master key cannot decrypt the old blob", async () => {
    const m1 = await freshModule();
    const blob = m1.encrypt(PEM);
    fs.writeFileSync(masterPath(), randomBytes(32));
    const m2 = await freshModule();
    expect(() => m2.decrypt(blob)).toThrow(/^credentials_corrupted$/);
  });

  it("D9 masterKeyFingerprint = sha256(master).hex.slice(0, 16)", async () => {
    const m = await freshModule();
    m.encrypt(PEM);
    const master = fs.readFileSync(masterPath());
    expect(m.masterKeyFingerprint()).toBe(createHash("sha256").update(master).digest("hex").slice(0, 16));
  });
});
