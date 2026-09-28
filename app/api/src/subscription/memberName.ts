// The member's Bitcorn-level name, carried to the treasury under a second
// signature on POST /api/subscription/token.
//
// Spec: bitcorn-research specs/2026-09-25-member-name-signed-transport-spec.md
// §5-§7 (decision D8). Two halves live here:
//
//   TREASURY — processMemberName(): verify → normalize → validate → block →
//   store, into member_private_name (058). Runs in the /token handler AFTER the
//   challenge verified and BEFORE the mint.
//
//   MEMBER — the member_name_status store (059): what the treasury last said
//   about the name this node sent, for Settings' generic rejected message.
//
// ⚠ NOTHING HERE MAY COST THE MEMBER THEIR TOKEN (D8 call 5). processMemberName
// never throws: every outcome is a status, and an unexpected error is logged
// as a short code — never the name, never LND text (057's last_error
// precedent) — and yields NO status. It returns before the mint and the
// handler mints on the verified pubkey alone, so no outcome here can change
// whether or which token is minted.
//
// ⚠ ORDER (D8 call 5): the name signature is verified over the EXACT received
// bytes FIRST; only then is the name normalized. Normalizing first and
// rebuilding the signed string from the normalized form would fail to verify
// any name the member signed un-normalized.
//
// ⚠ "rejected" NEVER SAYS WHY, on the wire or on screen. One value covers the
// blocklist and every other cause alike, so a member cannot probe the
// operator's blocked_aliases through the response (2026-06-12 §4).

import { db } from "../db";
import { lndVerifyMessage } from "../lightning/lnd";
import { isAliasBlocked } from "../profile/aliasValidation";
import { normalizeBitcornName, validateBitcornName } from "../profile/nameValidation";
import { getBlockedAliasList } from "../profile/profileStore";
import { buildNameSignedString } from "./challengeGrammar";
import type { ChallengeVerificationResult } from "./challengeAuth";

/** The additive `name_status` on a /token 200 (§5.3; meanings PROPOSED). */
export type MemberNameStatus = "accepted" | "rejected" | "none";

export const MEMBER_NAME_STATUSES: readonly MemberNameStatus[] = ["accepted", "rejected", "none"];

export interface PrivateNameRow {
  pubkey: string;
  name: string;
  signed_at: number;
  received_at: number;
}

// ─── Treasury: verify, validate, block, store ─────────────────────────────

/**
 * Decide and (maybe) store the name a /token request carried. Returns the
 * `name_status` for the 200 body, or `undefined` on an unexpected internal
 * error — the member then records nothing and shows nothing. Never throws.
 *
 *   no `name` field                         → "none", nothing written
 *   bad/missing name or name_signature,
 *   a signature not by the verified pubkey,
 *   invalid, blocked, or not newer than a
 *   DIFFERENT stored name                   → "rejected"
 *   the treasury now holds exactly this
 *   normalized name                         → "accepted"
 */
export async function processMemberName(
  body: { challenge: string; name?: unknown; name_signature?: unknown },
  verified: ChallengeVerificationResult,
): Promise<MemberNameStatus | undefined> {
  try {
    if (body.name === undefined) return "none";
    return await decideMemberName(body.challenge, body.name, body.name_signature, verified);
  } catch (err: any) {
    const code = typeof err?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : "internal_error";
    console.warn(`[member-name] name processing failed (${code}); token unaffected`);
    return undefined;
  }
}

async function decideMemberName(
  challenge: string,
  name: unknown,
  nameSignature: unknown,
  verified: ChallengeVerificationResult,
): Promise<MemberNameStatus> {
  if (typeof name !== "string" || name.length === 0) return "rejected";
  if (typeof nameSignature !== "string" || nameSignature.length === 0) return "rejected";

  // 1. The EXACT received bytes, rebuilt — never parsed out of a signed string.
  let signedBy: string;
  try {
    signedBy = await lndVerifyMessage(buildNameSignedString(challenge, name), nameSignature);
  } catch {
    return "rejected";
  }
  // ⚠ Only the recovered pubkey is compared. LND's `valid` flag ("a node with
  // active channels in the graph") is deliberately NOT honored here either:
  // it would reject every channel-less member (D8 §10).
  if (signedBy.toLowerCase() !== verified.verified_pubkey) return "rejected";

  // 2. Then normalize and validate — the member route's own rules.
  const normalized = normalizeBitcornName(name);
  if (!validateBitcornName(normalized).valid) return "rejected";

  // 3. Then the TREASURY operator's blocklist (empty until seeded).
  if (isAliasBlocked(normalized, getBlockedAliasList())) return "rejected";

  // 4. The monotonic write, then read back what is actually held.
  upsertPrivateName(verified.verified_pubkey, normalized, verified.timestamp_sec, Math.floor(Date.now() / 1000));
  return getPrivateName(verified.verified_pubkey)?.name === normalized ? "accepted" : "rejected";
}

/**
 * ⚠ The ordering lives in the statement's WHERE, not in a read-then-write, so
 * two concurrent requests cannot interleave around it: a row changes only for
 * a STRICTLY NEWER signed_at.
 */
function upsertPrivateName(pubkey: string, name: string, signedAt: number, receivedAt: number): void {
  db.prepare(
    `INSERT INTO member_private_name (pubkey, name, signed_at, received_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       name = excluded.name, signed_at = excluded.signed_at, received_at = excluded.received_at
     WHERE excluded.signed_at > member_private_name.signed_at`,
  ).run(pubkey.toLowerCase(), name, signedAt, receivedAt);
}

function getPrivateName(pubkey: string): PrivateNameRow | undefined {
  return db
    .prepare("SELECT pubkey, name, signed_at, received_at FROM member_private_name WHERE pubkey = ?")
    .get(pubkey.toLowerCase()) as PrivateNameRow | undefined;
}

/** Every stored name, for the roster's private-name column (§7.1). */
export function listPrivateNames(): PrivateNameRow[] {
  return db
    .prepare("SELECT pubkey, name, signed_at, received_at FROM member_private_name ORDER BY pubkey")
    .all() as PrivateNameRow[];
}

// ─── Member: what the treasury said about the name this node sent ─────────

/**
 * Record the treasury's `name_status` for the name this node sent (§4 step 5).
 * The response was read through an erased cast, so the value is checked
 * here: anything but the three known values records NOTHING — an old
 * treasury that sends no name_status never produces a false message.
 */
export function recordMemberNameStatus(memberPubkey: string, nameSent: string, status: unknown): void {
  if (typeof status !== "string" || !(MEMBER_NAME_STATUSES as readonly string[]).includes(status)) return;
  db.prepare(
    `INSERT INTO member_name_status (member_pubkey, name_sent, status, received_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(member_pubkey) DO UPDATE SET
       name_sent = excluded.name_sent, status = excluded.status, received_at = excluded.received_at`,
  ).run(memberPubkey, nameSent, status, Math.floor(Date.now() / 1000));
}

/**
 * The treasury's status FOR THE CURRENT NAME, for GET /api/profile/name (§7.2).
 * ⚠ name_sent must equal the current name: a status is about one name, and a
 * verdict on an earlier name must not describe the one saved since.
 */
export function getTreasuryNameStatus(
  memberPubkey: string,
  currentName: string | null,
): "accepted" | "rejected" | null {
  if (currentName === null) return null;
  const row = db
    .prepare("SELECT name_sent, status FROM member_name_status WHERE member_pubkey = ?")
    .get(memberPubkey) as { name_sent: string; status: string } | undefined;
  if (!row || row.name_sent !== currentName) return null;
  return row.status === "accepted" || row.status === "rejected" ? row.status : null;
}
