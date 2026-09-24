// The outcome of one gossip-graph alias lookup — pure, no I/O.
//
// Spec: bitcorn-research specs/2026-09-24-public-alias-refresh-spec.md §4
// (decision D7). Turns ONE getNode result or thrown error into exactly one of
// four outcomes. Shared by the treasury's public-alias refresh and by
// sync-peers, via lightning/nodeAlias.ts, so there is one classifier.
//
// ─── THE TWO PUBKEY-DERIVED FORMS ARE NOT NAMES ─────────────────────────────
//
// LND's default alias is the first 20 hex characters of the pubkey
// (lndDefaultAlias). It arrives as a SUCCESSFUL getNode answer — there is no
// field or flag that says "default" — so it cannot be caught by error handling.
// It is recognised BY VALUE: the trimmed, lowercased alias against
// lndDefaultAlias of the lowercased pubkey.
//
// The 8…6 placeholder is the form sync-peers used to write into contacts when
// a lookup failed. Nothing generates it any more; the clause stays so that
// "never stored as a name" holds even if a node announces that exact string.

import { lndDefaultAlias } from "./aliasValidation";

export type NodeAliasOutcome =
  | { outcome: "alias"; alias: string }
  | { outcome: "none_announced" }
  | { outcome: "not_in_graph" }
  | { outcome: "failed"; code: string };

export type NodeLookupSettled = { ok: true; alias: unknown } | { ok: false; error: unknown };

/** The route's former placeholder, lowercased: `pk.slice(0,8)…pk.slice(-6)`. */
function placeholderFor(lowerPubkey: string): string {
  return `${lowerPubkey.slice(0, 8)}…${lowerPubkey.slice(-6)}`;
}

/**
 * A short code for a failed lookup — never free text from LND.
 *
 * ln-service throws `[status, 'Name', {err}]` arrays; the code is the first two
 * elements (`503:FailedToRetrieveNodeDetails`). The third element carries
 * LND's own error, which is deliberately dropped: it is detail, and the store
 * holds codes. withDeadline's rejection leads with `ETIMEDOUT:`, which maps to
 * `ETIMEDOUT`. Any other throw maps to `exception`.
 */
function failureCode(error: unknown): string {
  if (Array.isArray(error)) {
    const [status, name] = error;
    return typeof name === "string" ? `${status}:${name}` : String(status);
  }
  if (error instanceof Error && error.message.startsWith("ETIMEDOUT")) return "ETIMEDOUT";
  return "exception";
}

export function classifyNodeLookup(pubkey: string, settled: NodeLookupSettled): NodeAliasOutcome {
  if (!settled.ok) {
    const e = settled.error;
    // Matched on BOTH elements. D7 §2 accepts that this rests on ln-service's
    // own wording (`'unable to find node'` → [404, 'NodeIsUnknown']); a
    // second, looser match is deliberately not added.
    if (Array.isArray(e) && e[0] === 404 && e[1] === "NodeIsUnknown") {
      return { outcome: "not_in_graph" };
    }
    return { outcome: "failed", code: failureCode(e) };
  }

  const alias = typeof settled.alias === "string" ? settled.alias.trim() : "";
  const lower = pubkey.toLowerCase();
  if (
    alias === "" ||
    alias.toLowerCase() === lndDefaultAlias(lower) ||
    alias.toLowerCase() === placeholderFor(lower)
  ) {
    return { outcome: "none_announced" };
  }
  return { outcome: "alias", alias };
}
