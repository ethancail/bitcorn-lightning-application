// L2 / T3 — the treasury tells members whether Tier 3 can close a channel.
//
// `close_enforcement` rides on every status response that carries a tier.
// It comes from tier3Scheduler.ts's CLOSE_ENFORCEMENT, which Stage 6 sets to
// "live" in the same change that adds the real closeChannel call. It must NOT
// follow SUBSCRIPTION_TIER3_LIVE: that flag closes nothing, so a member told
// "live" because of it would be told something false.
//
// Harness: membershipGating.tierState.test.ts's — the real migration runner on
// a temp-dir DB, no LND. ENV is read at import, so the flag-on case resets the
// module graph and imports again with the flag set.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-close-enforcement-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");
process.env.TREASURY_PUBKEY = "02" + "11".repeat(32);
delete process.env.SUBSCRIPTION_TIER3_LIVE;

const MS_PER_DAY = 86_400_000;
const TIERS = ["prepay", "current", "worker_lapsed", "routing_lapsed", "close_due"] as const;
const pubkeyFor = (i: number) => "03" + String(i).padStart(2, "0").repeat(32);

async function loadAndSeed() {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  const { db } = await import("../db");
  db.exec("DELETE FROM subscription;");
  const now = Date.now();
  TIERS.forEach((tier, i) => {
    db.prepare(
      `INSERT INTO subscription (member_pubkey, deposit_address, derivation_path,
                                 paid_through, created_at, current_tier)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(pubkeyFor(i), `bcrt1qclose${i}`, `label-${i}`, now - 65 * MS_PER_DAY, now - 95 * MS_PER_DAY, tier);
  });
  const { computeSubscriptionStatusForPubkey } = await import("./statusHandler");
  const { ENV } = await import("../config/env");
  return { computeSubscriptionStatusForPubkey, ENV };
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  delete process.env.SUBSCRIPTION_TIER3_LIVE;
});

describe("close_enforcement on the status response", () => {
  it.each(TIERS.map((t, i) => [t, i] as const))(
    "%s: a tier-carrying response says dry_run",
    async (_tier, i) => {
      const { computeSubscriptionStatusForPubkey, ENV } = await loadAndSeed();
      expect(ENV.subscriptionTier3Live).toBe(false);
      const status = computeSubscriptionStatusForPubkey(pubkeyFor(i));
      if (status.applicable !== true) throw new Error("expected a tier-carrying response");
      expect(status.close_enforcement).toBe("dry_run");
    },
  );

  it("stays dry_run with SUBSCRIPTION_TIER3_LIVE=true: the flag closes nothing", async () => {
    process.env.SUBSCRIPTION_TIER3_LIVE = "true";
    vi.resetModules();
    const { computeSubscriptionStatusForPubkey, ENV } = await loadAndSeed();
    expect(ENV.subscriptionTier3Live).toBe(true); // the flag really is on in this module graph
    for (let i = 0; i < TIERS.length; i++) {
      const status = computeSubscriptionStatusForPubkey(pubkeyFor(i));
      if (status.applicable !== true) throw new Error("expected a tier-carrying response");
      expect(status.close_enforcement).toBe("dry_run");
    }
  });
});
