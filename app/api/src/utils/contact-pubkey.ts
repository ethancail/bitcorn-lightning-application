import { db } from "../db";

// Contact pubkeys and their case.
//
// `contacts.pubkey` is BINARY-collated and, before the billing-pubkey-case
// fix, was stored as entered, while LND reports keys lowercase. So rows may
// exist in any case, and two rows may differ only by case. Nothing rewrites
// them (no migration, by ruling): new input is lowercased at write time, and
// reads compare case-insensitively with a deterministic tie-break.
//
// Spec: bitcorn-research specs/2026-10-28-billing-pubkey-case-normalization-
// spec.md §2.1, §2.3. The web mirrors both the rule and the tie-break
// (app/web/src/api/client.ts, findContact and contactPubkeyError).

export const CONTACT_PUBKEY_REFUSAL =
  "Node ID must be 66 hexadecimal characters (0-9, a-f), starting with 02 or 03.";

/**
 * Normalize a pubkey taken from user input: trim, lowercase, then require a
 * compressed secp256k1 key — 66 hex characters starting 02 or 03. Returns
 * null when the input is refused. Not for URL parameters (PATCH/DELETE compare
 * only) and not for LND's values (sync-peers trusts them).
 */
export function normalizeContactPubkey(input: string): string | null {
  const pubkey = input.trim().toLowerCase();
  return /^0[23][0-9a-f]{64}$/.test(pubkey) ? pubkey : null;
}

export type ContactRow = {
  id: number;
  pubkey: string;
  name: string;
  notes: string | null;
  tags: string | null;
  source: string;
  created_at: number;
  updated_at: number;
};

/**
 * The single contacts row for a pubkey, matched case-insensitively. Among case
 * twins: the `manual` row first, then the lowest id (ruling 1). Every reader
 * that resolves a peer to its contact — lane classification, payment error
 * names — goes through here, so they cannot disagree about which twin counts.
 */
export function findContactByPubkey(pubkey: string): ContactRow | undefined {
  return db
    .prepare(
      `SELECT * FROM contacts WHERE lower(pubkey) = ?
       ORDER BY CASE WHEN source = 'manual' THEN 0 ELSE 1 END, id ASC
       LIMIT 1`,
    )
    .get(pubkey.toLowerCase()) as ContactRow | undefined;
}
