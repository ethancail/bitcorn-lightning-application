// JWT minting + tier-based authorization for /api/subscription/token.
//
// Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §6
//
// Issuance logic (§6.3):
//   if current_tier == 'current'        → mint scope='full', exp=now+24h
//   if current_tier == 'prepay'         → mint scope='prepay', exp=now+24h
//   if current_tier == 'worker_lapsed'  → 402 (paid_through + deposit_address)
//   otherwise                           → 402
//
// Token shape (§6.2):
//   header  { "alg": "EdDSA", "typ": "JWT" }
//   payload {
//     "iss": "bitcorn-treasury",
//     "sub": <member_pubkey hex>,
//     "scope": "full" | "prepay",
//     "iat": <unix>,
//     "exp": <unix, iat + 24h>
//   }
//
// Treasury-self carve-out: when the treasury node calls /token with
// its own pubkey, the tier lookup is bypassed and a full-scope token
// is issued. The treasury is not a subscriber, so there is no
// subscription row to consult; but the treasury needs to authenticate
// its own outgoing Worker calls (e.g., the autobuy scheduler reading
// /valuation/current). Locked in interactive Stage 4 decision: "treasury
// self-mints a full-scope token."

import { SignJWT } from "jose";
import { db } from "../db";
import { ENV } from "../config/env";
import { getTreasurySigningKeypair } from "./treasuryKeypair";

export type TokenScope = "full" | "prepay";

export interface MintedToken {
  jwt: string;
  scope: TokenScope;
  issued_at_sec: number;
  expires_at_sec: number;
}

export interface IssuanceDenial {
  reason: "worker_lapsed" | "routing_lapsed" | "close_due" | "no_subscription_row";
  tier: string | null;
  paid_through: number | null;
  deposit_address: string | null;
}

export type IssuanceResult =
  | { kind: "minted"; token: MintedToken }
  | { kind: "denied"; denial: IssuanceDenial };

const TOKEN_LIFETIME_SEC = 24 * 60 * 60;

/**
 * Resolves a member pubkey to a tier + auxiliary state, then mints
 * (or refuses) a token per §6.3. Pure of HTTP — caller wires the
 * result to a 200 / 402 / 500 response.
 */
export async function issueTokenForPubkey(
  memberPubkey: string,
): Promise<IssuanceResult> {
  const treasuryPubkey = (ENV.treasuryPubkey ?? "").toLowerCase();
  const requestedPubkey = memberPubkey.toLowerCase();

  // Treasury self-mint carve-out. The treasury is not a subscriber
  // (no subscription row, excluded from backfill per §3.0), but it
  // needs full-scope to read /valuation/* from the Worker for its
  // own internal scheduling.
  if (treasuryPubkey && requestedPubkey === treasuryPubkey) {
    return { kind: "minted", token: await mintToken(requestedPubkey, "full") };
  }

  const row = db
    .prepare(
      `SELECT current_tier, paid_through, deposit_address
       FROM subscription WHERE member_pubkey = ?`,
    )
    .get(requestedPubkey) as
      | {
          current_tier: string;
          paid_through: number;
          deposit_address: string;
        }
      | undefined;

  if (!row) {
    return {
      kind: "denied",
      denial: {
        reason: "no_subscription_row",
        tier: null,
        paid_through: null,
        deposit_address: null,
      },
    };
  }

  if (row.current_tier === "current") {
    return { kind: "minted", token: await mintToken(requestedPubkey, "full") };
  }
  if (row.current_tier === "prepay") {
    return { kind: "minted", token: await mintToken(requestedPubkey, "prepay") };
  }

  // worker_lapsed / routing_lapsed / close_due → 402 with details
  // per spec §6.3. The body shape is the same so the member-side UI
  // can render a uniform "your subscription needs attention" panel.
  return {
    kind: "denied",
    denial: {
      reason: row.current_tier as IssuanceDenial["reason"],
      tier: row.current_tier,
      paid_through: row.paid_through,
      deposit_address: row.deposit_address,
    },
  };
}

async function mintToken(
  memberPubkeyLower: string,
  scope: TokenScope,
): Promise<MintedToken> {
  const kp = await getTreasurySigningKeypair();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_LIFETIME_SEC;
  const jwt = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer("bitcorn-treasury")
    .setSubject(memberPubkeyLower)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(kp.privateKey);
  return {
    jwt,
    scope,
    issued_at_sec: now,
    expires_at_sec: exp,
  };
}
