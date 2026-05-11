// Challenge-auth for POST /api/subscription/token.
//
// Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §6.3
//
// The member proves control of its node identity by signing a
// time-bounded challenge string with LND's signMessage (secp256k1
// ECDSA on the message). The treasury verifies via verifyMessage,
// which returns the pubkey that signed.
//
// Wire format (plain string, locked in interactive Stage 4 decision):
//
//     bitcorn:token-request:<member_pubkey_hex>:<unix_seconds>
//
// Body shape:
//     { challenge: <string>, signature: <hex> }
//
// Constraints:
// - The challenge string must match the format exactly.
// - The pubkey embedded in the challenge must equal the pubkey
//   returned by verifyMessage.
// - The timestamp must be within ±CHALLENGE_SKEW_SEC of now.

import { lndVerifyMessage } from "../lightning/lnd";

const CHALLENGE_PREFIX = "bitcorn:token-request:";
const CHALLENGE_SKEW_SEC = 60;

export interface ChallengeVerificationResult {
  verified_pubkey: string;
}

export class ChallengeAuthError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "malformed_challenge"
      | "claimed_pubkey_mismatch"
      | "timestamp_out_of_window"
      | "signature_invalid",
  ) {
    super(message);
    this.name = "ChallengeAuthError";
  }
}

interface ParsedChallenge {
  claimed_pubkey: string;
  timestamp_sec: number;
}

function parseChallenge(challenge: string): ParsedChallenge {
  if (!challenge.startsWith(CHALLENGE_PREFIX)) {
    throw new ChallengeAuthError(
      `challenge must start with "${CHALLENGE_PREFIX}"`,
      "malformed_challenge",
    );
  }
  const rest = challenge.slice(CHALLENGE_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) {
    throw new ChallengeAuthError(
      "challenge is missing `<pubkey>:<timestamp>` suffix",
      "malformed_challenge",
    );
  }
  const claimed_pubkey = rest.slice(0, lastColon);
  const timestampStr = rest.slice(lastColon + 1);
  // 33-byte compressed secp256k1 pubkey → 66 hex chars
  if (!/^[0-9a-fA-F]{66}$/.test(claimed_pubkey)) {
    throw new ChallengeAuthError(
      "claimed pubkey is not a 66-char hex string",
      "malformed_challenge",
    );
  }
  if (!/^\d+$/.test(timestampStr)) {
    throw new ChallengeAuthError(
      "challenge timestamp must be a positive integer (unix seconds)",
      "malformed_challenge",
    );
  }
  const timestamp_sec = parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp_sec) || timestamp_sec <= 0) {
    throw new ChallengeAuthError(
      "challenge timestamp is invalid",
      "malformed_challenge",
    );
  }
  return { claimed_pubkey: claimed_pubkey.toLowerCase(), timestamp_sec };
}

function assertTimestampInWindow(
  timestamp_sec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  const skew = Math.abs(nowSec - timestamp_sec);
  if (skew > CHALLENGE_SKEW_SEC) {
    throw new ChallengeAuthError(
      `challenge timestamp is outside the ±${CHALLENGE_SKEW_SEC}s window ` +
        `(skew=${skew}s)`,
      "timestamp_out_of_window",
    );
  }
}

/**
 * Verifies a challenge-signature pair and returns the verified pubkey
 * (lowercase hex). Throws `ChallengeAuthError` on any failure.
 *
 * Network IO: calls LND's verifyMessage RPC. Pure-function callers
 * that need to test parsing in isolation should call `parseChallenge`
 * directly.
 */
export async function verifyChallengeSignature(
  challenge: string,
  signature: string,
): Promise<ChallengeVerificationResult> {
  const parsed = parseChallenge(challenge);
  assertTimestampInWindow(parsed.timestamp_sec);

  let signedBy: string;
  try {
    signedBy = await lndVerifyMessage(challenge, signature);
  } catch (err: any) {
    throw new ChallengeAuthError(
      `signature failed LND verification: ${err?.message ?? String(err)}`,
      "signature_invalid",
    );
  }

  if (signedBy.toLowerCase() !== parsed.claimed_pubkey) {
    throw new ChallengeAuthError(
      `signature was made by ${signedBy.slice(0, 16)}…, but challenge ` +
        `claims pubkey ${parsed.claimed_pubkey.slice(0, 16)}…`,
      "claimed_pubkey_mismatch",
    );
  }

  return { verified_pubkey: signedBy.toLowerCase() };
}

// Exposed for unit tests / debugging.
export const _challengeAuthInternals = { parseChallenge, assertTimestampInWindow };
