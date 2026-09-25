// The one gossip-graph alias lookup.
//
// Spec: bitcorn-research specs/2026-09-24-public-alias-refresh-spec.md §6.3.
// Both the treasury's public-alias refresh and POST /api/contacts/sync-peers
// call this, so there is one call site, one classifier and one deadline.
//
// A raw ln-service call off getLndClient()'s handle, not an lnd.ts wrapper, so
// it binds its own deadline — listed in bypassSites.test.ts's EXPECTED_BYPASS.
// getNode is not outcome-ambiguous (it moves nothing), so it is bounded, not
// held.
//
// ⚠ The deadline stops OUR wait, not the gRPC call (callDeadline.ts header).
// And ln-service's getNode also issues a getWalletVersion RPC per call, so one
// lookup is two RPCs.
//
// NEVER THROWS: every failure — including getLndClient() itself throwing when
// the LND files are missing — is classified as `failed` with a code.

import { getNode } from "ln-service";
import { getLndClient } from "./lnd";
import { withDeadline, LND_GOSSIP_CALL_TIMEOUT_MS } from "./callDeadline";
import { lndFaultDetail } from "./lndHealth";
import { classifyNodeLookup, type NodeAliasOutcome } from "../profile/publicAliasOutcome";

export async function lookupNodeAlias(pubkey: string): Promise<NodeAliasOutcome> {
  let outcome: NodeAliasOutcome;
  try {
    const { lnd } = getLndClient();
    const node = await withDeadline(
      "nodeAlias:getNode",
      () => getNode({ lnd, public_key: pubkey, is_omitting_channels: true }),
      LND_GOSSIP_CALL_TIMEOUT_MS,
    );
    outcome = classifyNodeLookup(pubkey, { ok: true, alias: node.alias });
  } catch (error) {
    outcome = classifyNodeLookup(pubkey, { ok: false, error });
    if (outcome.outcome === "failed") {
      // The stored/returned value is a code; the full detail goes to the log
      // only, flattened by lndFaultDetail (ln-service arrays print nothing
      // useful through err.message).
      console.warn(`[nodeAlias] lookup failed for ${pubkey.slice(0, 12)}…:`, lndFaultDetail(error));
    }
  }
  return outcome;
}
