// Host-run command: acknowledge a changed subscription deposit address on a
// MEMBER node (bitcorn-research specs/2026-11-10-treasury-price-trust-spec.md
// §6.4). Deliberately not an HTTP route — see subscription/addressAcknowledge.ts.
//
// Run inside the member's API container (the image compiles src/ to dist/):
//
//     node dist/cli/acknowledge-deposit-address.js <new-deposit-address>
//
// It refreshes this node's subscription token (which also resolves the
// treasury URL in this process: the running API's copy lives in its own
// memory), fetches a fresh status through the one verifying fetch, and pins
// the address only if that status is verified and states exactly it. It
// prints what it did and exits 0 on a pin (or nothing to do), 1 otherwise.

import { acknowledgeDepositAddressChange } from "../subscription/addressAcknowledge";

async function main(): Promise<number> {
  const address = process.argv[2];
  if (!address || process.argv.length > 3) {
    console.error("usage: node dist/cli/acknowledge-deposit-address.js <new-deposit-address>");
    return 2;
  }
  const { db } = await import("../db");
  const { getNodeInfo } = await import("../api/read");
  const node = getNodeInfo();
  if (!node?.pubkey) {
    console.error("This node's pubkey is not known yet (LND has not synced). Nothing was pinned.");
    return 1;
  }
  if (node.node_role === "treasury") {
    console.error("This is the treasury node; it has no subscription address to acknowledge. Nothing was pinned.");
    return 1;
  }
  const { refreshLocalToken } = await import("../subscription/tokenRefresh");
  const refreshed = await refreshLocalToken();
  if (!refreshed.ok) {
    console.warn(`Token refresh did not complete (${refreshed.reason}); trying the cached token.`);
  }
  const { fetchLocalSubscriptionStatus } = await import("../subscription/memberStatusClient");
  const outcome = await acknowledgeDepositAddressChange({
    address,
    memberPubkey: node.pubkey.toLowerCase(),
    fetchStatus: () => fetchLocalSubscriptionStatus(),
    db,
    nowSec: Math.floor(Date.now() / 1000),
  });
  if (outcome.ok && outcome.action === "pinned") {
    console.log(`Pinned ${outcome.address} (was ${outcome.previous ?? "nothing"}). Payments to it are allowed again.`);
    return 0;
  }
  if (outcome.ok) {
    console.log(`${outcome.address} is already the pinned address. Nothing to do.`);
    return 0;
  }
  console.error(`Refused (${outcome.code}): ${outcome.detail}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("acknowledge-deposit-address failed:", err?.message ?? String(err));
    process.exit(1);
  },
);
