// JWT minting + tier-based authorization for /api/subscription/token.
//
// Source of truth:
//   - bitcorn-research/specs/2026-05-08-member-subscription.md §6
//   - bitcorn-research/decisions/2026-05-11-subscription-stage-5a-
//     architectural-deltas.md (scope rename + broadened issuance)
//
// Issuance logic (Stage 5a, post-deltas):
//   if claimed pubkey == TREASURY_PUBKEY → SELF-MINT scope='full'
//   look up subscription row
//     if NOT EXISTS                        → 402 no_subscription_row
//     if current_tier == 'current'         → mint scope='full',    exp=now+24h
//     if current_tier == 'prepay'          → mint scope='payment', exp=now+24h
//     if current_tier == 'worker_lapsed'   → mint scope='payment', exp=now+24h
//     if current_tier == 'routing_lapsed'  → mint scope='payment', exp=now+24h
//     if current_tier == 'close_due'       → mint scope='payment', exp=now+24h
//
// `payment` scope authorizes subscriber-base Worker endpoints (Onramp,
// commodity prices) but not tier-gated endpoints (valuation). It is
// the recovery-path scope — every subscriber state other than `current`
// receives one so they can buy BTC and pay to advance.
//
// Token shape (§6.2):
//   header  { "alg": "EdDSA", "typ": "JWT" }
//   payload {
//     "iss": "bitcorn-treasury",
//     "sub": <member_pubkey hex>,
//     "scope": "full" | "payment",
//     "iat": <unix>,
//     "exp": <unix, iat + 24h>
//   }
//
// Treasury-self carve-out: when the treasury node calls /token with
// its own pubkey, the tier lookup is bypassed and a full-scope token
// is issued. The treasury is not a subscriber, so there is no
// subscription row to consult; but the treasury needs to authenticate
// its own outgoing Worker calls (e.g., the autobuy scheduler reading
// /valuation/current).

import { SignJWT } from "jose";
import { db } from "../db";
import { ENV } from "../config/env";
import { getTreasurySigningKeypair } from "./treasuryKeypair";

export type TokenScope = "full" | "payment";

export interface MintedToken {
  jwt: string;
  scope: TokenScope;
  issued_at_sec: number;
  expires_at_sec: number;
}

// Post-deltas, the only denial path is no_subscription_row. Lapsed
// tiers now mint payment-scope tokens rather than denying.
export interface IssuanceDenial {
  reason: "no_subscription_row";
}

export type IssuanceResult =
  | { kind: "minted"; token: MintedToken }
  | { kind: "denied"; denial: IssuanceDenial };

const TOKEN_LIFETIME_SEC = 24 * 60 * 60;

/**
 * Maps a subscription tier to the scope a freshly-minted token for
 * that tier should carry. `current` → full; every other subscriber
 * tier → payment. Defensive fallback to payment for unknown tiers
 * (Stage 6 may add tier values; better to issue a recovery-path token
 * than deny a member whose tier the issuer was just updated for).
 *
 * Exported so the tier-transition observer (transitionObserver.ts)
 * uses the same mapping as the issuer — if this mapping ever evolves
 * (new tier, scope rename), both update in lockstep.
 */
export function scopeForTier(tier: string): TokenScope {
  if (tier === "current") return "full";
  return "payment";
}

/**
 * Resolves a member pubkey to a tier + auxiliary state, then mints
 * (or refuses) a token per spec §6.3 as refined by the Stage 5a
 * deltas record. Pure of HTTP — caller wires the result to a 200 /
 * 402 / 500 response.
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
      `SELECT current_tier FROM subscription WHERE member_pubkey = ?`,
    )
    .get(requestedPubkey) as { current_tier: string } | undefined;

  if (!row) {
    return { kind: "denied", denial: { reason: "no_subscription_row" } };
  }

  return {
    kind: "minted",
    token: await mintToken(requestedPubkey, scopeForTier(row.current_tier)),
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
