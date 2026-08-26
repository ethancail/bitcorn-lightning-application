import { isLndAvailable, getLndInfo, getLndChannels } from "./lnd";
import { persistNodeInfo } from "./persist";
import { persistPeers, persistChannels } from "./persist-channels";
import { syncInboundPayments } from "./persist-inbound";
import { syncForwardingHistory } from "./persist-forwarded";
import { syncNetworkInvoiceSettlements } from "./network-payments";
import { ENV } from "../config/env";
import { db } from "../db";
import type { NodeRole } from "../types/node";
import { createTickTimer, formatTickTiming } from "./syncTiming";

export function deriveNodeRole(
  pubkey: string,
  hasTreasuryChannel: boolean
): NodeRole {
  // Both sides must be non-empty before comparing, mirroring the treasury
  // check in index.ts (GET /api/subscription/status). TREASURY_PUBKEY
  // defaults to "" when unset and the caller passes `public_key ?? ""`, so an
  // unguarded `===` makes "" === "" true — classifying a node with no
  // identity and no configuration as the treasury. That is the one
  // misclassification that GRANTS privilege: assertTreasury() throws on every
  // other role. Falling through yields member/external, matching the
  // "external" default in migration 010 and persistNodeInfo().
  const isTreasury =
    !!pubkey && !!ENV.treasuryPubkey && pubkey === ENV.treasuryPubkey;
  if (isTreasury) return "treasury";
  if (hasTreasuryChannel) return "member";
  return "external";
}

export async function syncLndState() {
  if (!isLndAvailable()) {
    return { ok: false, reason: "lnd_unavailable" };
  }

  // ⚠ TIMED IN A try/finally SO A FAILED TICK IS STILL MEASURED. The interesting
  // tick is the one where a call hit its deadline; a timer that only recorded
  // clean runs would omit exactly the measurement this exists to collect.
  //
  // ⚠ WHAT THIS DOES AND DOES NOT BOUND. Every LND call below now carries a
  // per-call deadline, which makes this tick FINITE. It does NOT bound the tick
  // within its 15s period: six sequential calls at 3s is 18s, and
  // syncForwardingHistory walks an unbounded number of pages at 3s each. Still
  // strictly better than before — the overlap is now ⌈tick/15s⌉ concurrent runs
  // rather than unbounded accumulation, because a wedge can no longer produce a
  // run that never ends. The per-tick budget is deferred, and these numbers are
  // what make it derivable rather than argued.
  const timer = createTickTimer();
  try {
    const walletInfo = await timer.time("getLndInfo", () => getLndInfo());
    if (ENV.debug) {
      console.log("[lnd] wallet info:", walletInfo);
    }

    await timer.time("persistPeers", () => persistPeers());
    await timer.time("persistChannels", () => persistChannels());

    // Check for treasury channel after channels are persisted
    const { channels } = await timer.time("getLndChannels", () => getLndChannels());
    const treasuryPubkey = ENV.treasuryPubkey;

    const treasuryChannel = channels.find(
      c => c.partner_public_key === treasuryPubkey
    );

    const hasTreasuryChannel = !!treasuryChannel;
    const treasuryChannelActive = treasuryChannel?.is_active ?? false;

    // Compute membership status
    const synced = walletInfo.synced_to_chain ?? false;
    let membershipStatus: string;

    if (!synced) {
      membershipStatus = "unsynced";
    } else if (!hasTreasuryChannel) {
      membershipStatus = "no_treasury_channel";
    } else if (!treasuryChannelActive) {
      membershipStatus = "treasury_channel_inactive";
    } else {
      membershipStatus = "active_member";
    }

    const nodeRole = deriveNodeRole(walletInfo.public_key ?? "", hasTreasuryChannel);
    await timer.time("persistNodeInfo", () =>
      persistNodeInfo(hasTreasuryChannel, membershipStatus, nodeRole),
    );
    await timer.time("syncInboundPayments", () => syncInboundPayments());
    // Paginated: this is pages × the per-page deadline, not one bounded call.
    await timer.time("syncForwardingHistory", () => syncForwardingHistory());
    syncNetworkInvoiceSettlements(); // match pending receives against confirmed inbound payments

    // Clean up stale expansion executions stuck in requested/submitted for >1 hour.
    // These block capital guardrails by inflating pending sats.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    db.prepare(
      `UPDATE treasury_expansion_executions
       SET status = 'failed', error = 'stale — auto-cleaned by sync loop'
       WHERE status IN ('requested', 'submitted') AND created_at < ?`
    ).run(oneHourAgo);

    return { ok: true };
  } finally {
    const line = formatTickTiming(timer.samples(), timer.totalMs(), ENV.syncTimingLevel);
    if (line) console.log(line);
  }
}