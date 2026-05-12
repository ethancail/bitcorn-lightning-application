// Startup self-fetch sync check for the treasury Ed25519 keypair.
//
// Source of truth:
//   - bitcorn-research/specs/2026-05-11-subscription-stage-5a-jwt-fix-
//     and-member-ui.md §3.2
//
// On treasury startup, the API fetches its own /treasury-info via the
// configured Worker URL and compares the published `subscription_
// public_key` against the local keypair's public half. Mismatches are
// logged at WARN with operator runbook guidance.
//
// The check is best-effort: a failed fetch (Worker briefly down,
// network blip) logs INFO and moves on. Stage 5b will elevate this
// from log inspection to an admin-UI banner.
//
// Member nodes skip this check — they don't own the keypair, and the
// member-side jwtVerify self-heal on bad_signature handles the runtime
// equivalent.

import { ENV } from "../config/env";
import { getTreasuryPublicKeyForCloudflare } from "./treasuryKeypair";

const FETCH_TIMEOUT_MS = 3000;
// Don't run the check until the sync loop has populated lnd_node_info
// (we need the local pubkey to know if we're on treasury). The Stage
// 4.5 tokenRefresh scheduler waits 10s for the same reason; we offset
// by another 2s so log lines order sensibly during boot.
const STARTUP_DELAY_MS = 12 * 1000;

interface TreasuryInfoPayload {
  subscription_public_key?: { x?: string } | null;
}

export function startKeypairSyncCheck(getLocalPubkey: () => string | null): void {
  setTimeout(async () => {
    try {
      const local = (getLocalPubkey() ?? "").toLowerCase();
      const treasury = (ENV.treasuryPubkey ?? "").toLowerCase();
      if (!local) {
        console.info(
          `[SUBSCRIPTION_KEYPAIR_SYNC] local pubkey not yet known; skipping startup check`,
        );
        return;
      }
      if (!treasury || local !== treasury) {
        // Member node — sync check doesn't apply.
        return;
      }
      if (!ENV.coinbaseWorkerUrl) {
        console.warn(
          `[SUBSCRIPTION_KEYPAIR_SYNC] COINBASE_WORKER_URL is unset; cannot verify Worker has the matching SUBSCRIPTION_PUBLIC_KEY`,
        );
        return;
      }
      await runSyncCheck();
    } catch (err: any) {
      console.warn(
        `[SUBSCRIPTION_KEYPAIR_SYNC] check threw:`,
        err?.message ?? err,
      );
    }
  }, STARTUP_DELAY_MS);
}

async function runSyncCheck(): Promise<void> {
  const local = await getTreasuryPublicKeyForCloudflare();
  const localX = local.public_key_b64url;

  const url = `${ENV.coinbaseWorkerUrl.replace(/\/+$/, "")}/treasury-info`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let body: TreasuryInfoPayload | null = null;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.info(
        `[SUBSCRIPTION_KEYPAIR_SYNC] /treasury-info returned ${res.status}; will retry next startup`,
      );
      return;
    }
    body = (await res.json()) as TreasuryInfoPayload;
  } catch (err: any) {
    console.info(
      `[SUBSCRIPTION_KEYPAIR_SYNC] could not reach Worker for sync check; will retry next startup (${err?.message ?? err})`,
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  const publishedX = body?.subscription_public_key?.x ?? null;
  if (!publishedX) {
    console.warn(
      `[SUBSCRIPTION_KEYPAIR_SYNC] Worker has no SUBSCRIPTION_PUBLIC_KEY set; ` +
        `member-side JWT validation will fail until you publish it. ` +
        `Run: cd cloudflare-worker && wrangler secret put SUBSCRIPTION_PUBLIC_KEY (paste ${localX} when prompted, no trailing newline) && wrangler deploy`,
    );
    return;
  }
  if (publishedX !== localX) {
    console.warn(
      `[SUBSCRIPTION_KEYPAIR_SYNC] Worker SUBSCRIPTION_PUBLIC_KEY does not match local keypair. ` +
        `Likely cause: the local keypair was rotated but the Worker secret was not re-published. ` +
        `Run: cd cloudflare-worker && wrangler secret put SUBSCRIPTION_PUBLIC_KEY (paste ${localX} when prompted, no trailing newline) && wrangler deploy`,
    );
    return;
  }
  console.debug(`[SUBSCRIPTION_KEYPAIR_SYNC] in sync`);
}
