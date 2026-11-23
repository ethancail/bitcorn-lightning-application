// kraken-autobuy P2: the per-label key cache in credentials.ts (spec §2, D4).
//
// Suite D (credentials.test.ts) pins the Coinbase label and stays byte-unchanged;
// these cases pin what a second label adds. Same harness as Suite D: each case
// points SECRETS_DIR at a fresh temp dir and imports a FRESH module, because the
// derived keys are cached for the module's life with no reset export. No mocks.
//
// L4 is the recon's failure: with one cache slot, whichever label is used first
// fills it, and the second label silently gets the first label's key. L1 and L2
// alone cannot catch that when Kraken happens to be used first, so L4 uses
// Coinbase first.

import fs from "fs";
import os from "os";
import path from "path";
import { createDecipheriv, createHmac, hkdfSync, randomBytes } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Creds = typeof import("./credentials");

let root: string;
let secretsDir: string;
let savedSecretsDir: string | undefined;

async function freshModule(): Promise<Creds> {
  process.env.SECRETS_DIR = secretsDir;
  vi.resetModules();
  return import("./credentials");
}

const masterPath = () => path.join(secretsDir, "master.key");

/** HKDF-SHA256, 32 zero bytes of salt, the given info, T(1): derived outside the module. */
function deriveIndependently(master: Buffer, info: string): Buffer {
  const prk = createHmac("sha256", Buffer.alloc(32, 0)).update(master).digest();
  const t1 = createHmac("sha256", prk).update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([0x01])])).digest();
  return t1.subarray(0, 32);
}

function decryptWith(key: Buffer, blob: { ciphertext: Buffer; nonce: Buffer }): string {
  const tag = blob.ciphertext.subarray(blob.ciphertext.length - 16);
  const enc = blob.ciphertext.subarray(0, blob.ciphertext.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, blob.nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const SECRET = "kraken-private-key-base64+/==";
const PEM = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIabc\n-----END EC PRIVATE KEY-----\n";

beforeEach(() => {
  savedSecretsDir = process.env.SECRETS_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-cred-labels-"));
  secretsDir = path.join(root, "secrets");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedSecretsDir === undefined) delete process.env.SECRETS_DIR;
  else process.env.SECRETS_DIR = savedSecretsDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("L · per-label credential keys", () => {
  it("L1 the Kraken label's key is an INDEPENDENT HKDF-SHA256 derivation with info 'kraken-autobuy'", async () => {
    const m = await freshModule();
    const blob = m.encrypt(SECRET, "kraken-autobuy");
    const master = fs.readFileSync(masterPath());
    const key = deriveIndependently(master, "kraken-autobuy");
    expect(Buffer.from(hkdfSync("sha256", master, Buffer.alloc(32, 0), "kraken-autobuy", 32)).equals(key)).toBe(true);
    expect(decryptWith(key, blob)).toBe(SECRET);
    expect(() => decryptWith(deriveIndependently(master, "coinbase-autobuy"), blob)).toThrow();
  });

  it("L2 a blob decrypts only under its own label: the other label throws credentials_corrupted, both ways", async () => {
    const m = await freshModule();
    const kraken = m.encrypt(SECRET, "kraken-autobuy");
    const coinbase = m.encrypt(PEM, "coinbase-autobuy");
    expect(m.decrypt(kraken, "kraken-autobuy")).toBe(SECRET);
    expect(m.decrypt(coinbase, "coinbase-autobuy")).toBe(PEM);
    expect(() => m.decrypt(kraken, "coinbase-autobuy")).toThrow(/^credentials_corrupted$/);
    expect(() => m.decrypt(coinbase, "kraken-autobuy")).toThrow(/^credentials_corrupted$/);
  });

  it("L3 each label's key is cached for the module's life (Suite D's D7, per label): replacing master.key changes neither label", async () => {
    const m = await freshModule();
    const k1 = m.encrypt(SECRET, "kraken-autobuy");
    const c1 = m.encrypt(PEM, "coinbase-autobuy");
    const originalMaster = fs.readFileSync(masterPath());

    fs.writeFileSync(masterPath(), randomBytes(32));

    expect(m.decrypt(k1, "kraken-autobuy")).toBe(SECRET);
    expect(m.decrypt(c1, "coinbase-autobuy")).toBe(PEM);
    expect(decryptWith(deriveIndependently(originalMaster, "kraken-autobuy"), m.encrypt(SECRET, "kraken-autobuy"))).toBe(SECRET);
    expect(decryptWith(deriveIndependently(originalMaster, "coinbase-autobuy"), m.encrypt(PEM, "coinbase-autobuy"))).toBe(PEM);
  });

  it("L4 Coinbase used FIRST, then Kraken: Kraken still gets its own key, not the cached Coinbase one", async () => {
    const m = await freshModule();
    m.decrypt(m.encrypt(PEM)); // fills the Coinbase label's cache entry first
    const kraken = m.encrypt(SECRET, "kraken-autobuy");
    const master = fs.readFileSync(masterPath());
    expect(decryptWith(deriveIndependently(master, "kraken-autobuy"), kraken)).toBe(SECRET);
    expect(() => decryptWith(deriveIndependently(master, "coinbase-autobuy"), kraken)).toThrow();
  });

  it("L5 with no label, encrypt and decrypt use the Coinbase label", async () => {
    const m = await freshModule();
    const unlabelled = m.encrypt(PEM);
    expect(m.decrypt(unlabelled, "coinbase-autobuy")).toBe(PEM);
    expect(m.decrypt(m.encrypt(PEM, "coinbase-autobuy"))).toBe(PEM);
    expect(() => m.decrypt(unlabelled, "kraken-autobuy")).toThrow(/^credentials_corrupted$/);
    const master = fs.readFileSync(masterPath());
    expect(decryptWith(deriveIndependently(master, "coinbase-autobuy"), unlabelled)).toBe(PEM);
  });
});
