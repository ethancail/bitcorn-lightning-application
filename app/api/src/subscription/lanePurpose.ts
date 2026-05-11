// Server-side lane-purpose classifier for subscription scope.
//
// Per spec §3.0 + decisions/2026-05-08-subscription-scope-external-peer-exclusion.md:
// the subscription system is bounded by lane purpose. Only members
// whose channel lane is `merchant_lane` or `farmer_lane` get
// subscription rows. `external_peer` (curated list, e.g. ACINQ; or
// tagged as such) and `unclassified` peers are exempt entirely — no
// row, no enforcement, no Tier 3 close.
//
// This logic mirrors the frontend at app/web/src/components/liquidity/
// transform.ts and the inline derivation in app/web/src/App.tsx. The
// canonical lane vocabulary lives in BITCORN_CONTEXT.md §2 ("Lane
// model"). A future consolidation could share the classifier across
// frontend and backend; for now the duplication is documented and
// intentional, because backend changes that touch payment paths must
// not depend on a frontend bundle.

import { db } from "../db";

/** The four lane-purpose values used across the codebase. */
export type LanePurpose =
  | "merchant_lane"
  | "farmer_lane"
  | "external_peer"
  | "unclassified";

// Curated external-pubkey list. Mirrors EXTERNAL_PUBKEYS in
// app/web/src/components/liquidity/types.ts and the inline list in
// App.tsx. If the curated list grows, update all three places.
const EXTERNAL_PUBKEYS = new Set<string>([
  "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f", // ACINQ
]);

/**
 * Classifies a peer pubkey by lane purpose. Reads `contacts.tags`
 * directly from SQLite; no external dependency. Returns the same
 * vocabulary the rebalancing model uses.
 */
export function classifyLanePurpose(pubkey: string): LanePurpose {
  if (EXTERNAL_PUBKEYS.has(pubkey)) return "external_peer";
  const row = db
    .prepare("SELECT tags FROM contacts WHERE pubkey = ?")
    .get(pubkey) as { tags: string | null } | undefined;
  if (!row) return "unclassified";
  const tags = (row.tags ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tags.includes("external") || tags.includes("external-peer")) return "external_peer";
  if (tags.includes("merchant") || tags.includes("merchant-lane")) return "merchant_lane";
  if (tags.includes("farmer") || tags.includes("farmer-lane")) return "farmer_lane";
  return "unclassified";
}

/**
 * True iff the peer's lane purpose makes them a subscription
 * subscriber. False for `external_peer` and `unclassified` (those
 * are exempt per §3.0).
 */
export function isInSubscriptionScope(pubkey: string): boolean {
  const lane = classifyLanePurpose(pubkey);
  return lane === "merchant_lane" || lane === "farmer_lane";
}
