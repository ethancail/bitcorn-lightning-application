// The treasury keypair's operator log, by network — dev-safety R1
// (vault: decisions/2026-11-13-dev-safety-rulings-r1-to-r5-keypair-log-by-network-api-listen-host-harness-lock.md).
//
// Three sites log the Worker-publication instruction: first generation
// (treasuryKeypair.ts) and the startup sync check's two warnings
// (keypairSyncCheck.ts: the Worker has no key; the Worker's key differs).
// On mainnet each message must stay byte-identical to the pre-R1 code, pinned
// by __fixtures__/keypair-log-mainnet.json, which was captured from that code
// (develop @ 7f7530b) with this file's own capture(). Off mainnet, no message
// may carry a command: a dev slot's log must never instruct a production
// secret change.
//
// The key is random per run, so capture() replaces the run's JWK, its `x`
// value and the scratch SECRETS_DIR with placeholders before comparing.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const FIXTURE = path.join(__dirname, "__fixtures__", "keypair-log-mainnet.json");
const TREASURY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
const ENV_KEYS = ["SECRETS_DIR", "BITCOIN_NETWORK", "TREASURY_PUBKEY", "COINBASE_WORKER_URL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

interface Captured {
  generated: string;
  missing: string;
  differs: string;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Runs the real modules on a fresh registry: generates a key in a scratch
// SECRETS_DIR, then runs the startup sync check twice against a stubbed Worker,
// once with no published key and once with a different one.
async function capture(network: string | undefined): Promise<Captured> {
  vi.resetModules();
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "keypair-log-"));
  process.env.SECRETS_DIR = secrets;
  if (network === undefined) delete process.env.BITCOIN_NETWORK;
  else process.env.BITCOIN_NETWORK = network;
  process.env.TREASURY_PUBKEY = TREASURY;
  process.env.COINBASE_WORKER_URL = "https://worker.invalid";

  const lines: string[] = [];
  const record = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  for (const level of ["log", "info", "warn", "debug"] as const) vi.spyOn(console, level).mockImplementation(record);

  const kp = await import("./treasuryKeypair");
  const { startKeypairSyncCheck } = await import("./keypairSyncCheck");
  const { public_key_b64url: x, jwk } = await kp.getTreasuryPublicKeyForCloudflare();

  const one = (prefix: string, contains: string): string => {
    const hits = lines.filter((l) => l.startsWith(prefix) && l.includes(contains));
    expect(hits, `exactly one "${prefix}" line containing "${contains}"; got ${JSON.stringify(lines)}`).toHaveLength(1);
    return hits[0];
  };
  const generated = one("[SUBSCRIPTION_KEYPAIR_GENERATED]", "");

  vi.useFakeTimers();
  const runSync = async (published: unknown, contains: string) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ subscription_public_key: published }), { status: 200 })));
    startKeypairSyncCheck(() => TREASURY);
    await vi.advanceTimersByTimeAsync(12_000);
    await vi.waitFor(() => { one("[SUBSCRIPTION_KEYPAIR_SYNC]", contains); });
    return one("[SUBSCRIPTION_KEYPAIR_SYNC]", contains);
  };
  const missing = await runSync(null, "has no SUBSCRIPTION_PUBLIC_KEY");
  const differs = await runSync({ x: "not-the-local-key" }, "does not match");

  const normalise = (s: string) =>
    s.split(JSON.stringify(jwk)).join("<JWK>").split(x).join("<X>").split(secrets).join("<SECRETS_DIR>");
  return { generated: normalise(generated), missing: normalise(missing), differs: normalise(differs) };
}

describe("R1 — mainnet: the three messages are byte-identical to the pre-R1 code", () => {
  for (const network of ["mainnet", undefined]) {
    it(`BITCOIN_NETWORK=${network ?? "(unset, so env.ts's mainnet default)"}`, async () => {
      const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Captured;
      const got = await capture(network);
      expect(got.generated).toBe(fixture.generated);
      expect(got.missing).toBe(fixture.missing);
      expect(got.differs).toBe(fixture.differs);
    });
  }
});

describe("R1 — off mainnet: no command, and the dev warning instead", () => {
  for (const network of ["regtest", "testnet"]) {
    it(`BITCOIN_NETWORK=${network}`, async () => {
      const got = await capture(network);
      for (const [site, text] of Object.entries(got)) {
        expect(text, site).not.toMatch(/wrangler|secret put|\bdeploy\b/i);
        // Anti-vacuity: the dev warning is there, so "no command" is not just "no line".
        expect(text, site).toMatch(/dev\/regtest key/i);
        expect(text, site).toMatch(/the only Worker is production/i);
        expect(text, site).toMatch(/must not be published there/i);
        expect(text, site).toContain(network);
      }
      // The marker prefixes stay, so log searches still find the lines.
      expect(got.generated).toMatch(/^\[SUBSCRIPTION_KEYPAIR_GENERATED\] /);
      expect(got.missing).toMatch(/^\[SUBSCRIPTION_KEYPAIR_SYNC\] Worker has no SUBSCRIPTION_PUBLIC_KEY set/);
      expect(got.differs).toMatch(/^\[SUBSCRIPTION_KEYPAIR_SYNC\] Worker SUBSCRIPTION_PUBLIC_KEY does not match local keypair/);
    });
  }
});

describe("R1 — the COINBASE_WORKER_URL-unset warning is unchanged", () => {
  for (const network of ["mainnet", "regtest"]) {
    it(`BITCOIN_NETWORK=${network}`, async () => {
      vi.resetModules();
      process.env.BITCOIN_NETWORK = network;
      process.env.TREASURY_PUBKEY = TREASURY;
      process.env.COINBASE_WORKER_URL = "";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { startKeypairSyncCheck } = await import("./keypairSyncCheck");
      vi.useFakeTimers();
      startKeypairSyncCheck(() => TREASURY);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(warn.mock.calls.map((c) => c.join(" "))).toEqual([
        "[SUBSCRIPTION_KEYPAIR_SYNC] COINBASE_WORKER_URL is unset; cannot verify Worker has the matching SUBSCRIPTION_PUBLIC_KEY",
      ]);
    });
  }
});
