// Allocates a fresh subscription deposit address for a member.
//
// Path B (V8 fallback): uses LND's `createChainAddress` — the address
// is owned by LND's hot wallet but logically segregated by the
// per-member label stored in `subscription.derivation_path`.
//
// Allocation is gated by the first-run acknowledgement (see
// firstRunGate.ts) so addresses cannot be derived before the operator
// opts into the segregation model.
//
// Two modes per spec §3 / §10 step 3:
// - "fresh"       — new member, paid_through = created_at, current_tier = 'prepay',
//                   no ledger row. The dispatch identifies prepay state by the
//                   absence of any `subscription_payment` row for the member.
// - "grandfather" — pre-existing member at flip-day, paid_through = now(),
//                   current_tier = 'current', PLUS a sentinel admin_override
//                   ledger row so the dispatch's "no payment row → prepay"
//                   check correctly routes them away from prepay.

import { db } from "../db";
import { createLndChainAddress } from "../lightning/lnd";
import { assertFirstRunAcknowledged } from "./firstRunGate";
import { subscriptionLabel } from "./labels";

export interface AllocationResult {
  member_pubkey: string;
  deposit_address: string;
  label: string;
  paid_through: number;
  current_tier: "prepay" | "current";
  created_at: number;
}

/**
 * Inserts a fresh `subscription` row for a member. Idempotent: if a
 * row already exists for the pubkey, returns the existing row without
 * allocating a new address.
 */
export async function allocateSubscriptionForMember(
  memberPubkey: string,
  mode: "fresh" | "grandfather",
): Promise<AllocationResult> {
  assertFirstRunAcknowledged();

  const existing = db
    .prepare(
      `SELECT member_pubkey, deposit_address, derivation_path AS label,
              paid_through, current_tier, created_at
       FROM subscription WHERE member_pubkey = ?`,
    )
    .get(memberPubkey) as AllocationResult | undefined;
  if (existing) return existing;

  const { address } = await createLndChainAddress();
  const label = subscriptionLabel(memberPubkey);
  const now = Date.now();

  // Insert the subscription row + (for grandfather mode) the sentinel
  // ledger row in a single transaction so the dispatch can never see
  // a half-grandfathered state.
  const insertSubscription = db.prepare(
    `INSERT INTO subscription (
        member_pubkey, deposit_address, derivation_path,
        paid_through, created_at, current_tier
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertGrandfatherSentinel = db.prepare(
    `INSERT INTO subscription_payment (
        member_pubkey, amount_sats, received_at,
        period_extension_days, kind, admin_reason
     ) VALUES (?, 0, ?, 0, 'admin_override', 'Stage 2 grandfather backfill at flip-day')`,
  );

  const tier = mode === "grandfather" ? "current" : "prepay";
  const allocate = db.transaction(() => {
    insertSubscription.run(memberPubkey, address, label, now, now, tier);
    if (mode === "grandfather") {
      insertGrandfatherSentinel.run(memberPubkey, now);
    }
  });
  allocate();

  return {
    member_pubkey: memberPubkey,
    deposit_address: address,
    label,
    paid_through: now,
    current_tier: tier,
    created_at: now,
  };
}
