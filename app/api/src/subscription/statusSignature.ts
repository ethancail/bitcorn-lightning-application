// The signed subscription-status response: the treasury's signing step and the
// member's verdict. Pure and db-free (LND is injected), so both halves are
// testable without a node.
//
// Source of truth: bitcorn-research specs/2026-11-10-treasury-price-trust-
// spec.md §1–§4 (D1, D2, D5). The signed string's grammar lives in
// challengeGrammar.ts, with the other two signed strings.
//
// TRANSPORT (§1.3): headers only, so the body stays byte-identical for members
// that predate this — an old member casts the body and uses it, and its proxy
// forwards it to its web, so any change to the body's shape breaks it.
//   request  X-Bitcorn-Status-Nonce:     <32 lowercase hex>
//   response X-Bitcorn-Status-Signature: <LND signmessage zbase32>
//            Cache-Control: no-store

import crypto from "crypto";
import { buildTreasuryStatusSignedString } from "./challengeGrammar";

/** Node lowercases incoming header names. */
export const STATUS_NONCE_HEADER = "x-bitcorn-status-nonce";
export const STATUS_SIGNATURE_HEADER = "x-bitcorn-status-signature";

const NONCE_RE = /^[0-9a-f]{32}$/;
const PUBKEY_RE = /^[0-9a-f]{66}$/;
// LND signmessage output: a 65-byte compact signature, zbase32 — exactly 104
// characters of this alphabet. Anything else is refused as `invalid` before
// LND is asked: LND answers a non-zbase32 signature with an RPC error, which
// would otherwise read as "LND unavailable" (rpcserver.go VerifyMessage).
const LND_SIGNATURE_RE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{104}$/;

export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** A fresh member nonce: 16 random bytes as 32 lowercase hex (§1.2). */
export function newStatusNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function singleHeader(v: string | string[] | undefined | null): string | null {
  return typeof v === "string" ? v : null;
}

// ─── Treasury side (§2) ─────────────────────────────────────────────────────

export interface SignedStatusResponse {
  headers: Record<string, string>;
  /** The bytes that were hashed and must be written, unchanged. */
  body: Buffer;
  signed: boolean;
}

/**
 * Serialize the payload ONCE and, if the request carries a well-formed nonce,
 * sign those exact bytes for `memberPubkey`.
 *
 * - No nonce, or a malformed one: today's response, unsigned, logged at no
 *   level (the old-member path, §10). A nonce-free signature would be a
 *   replayable artifact with no consumer, so none is made.
 * - Signing fails (LND error or deadline): the SAME bytes, unsigned, and one
 *   log line. Not a 503: that would turn a treasury LND hiccup into a status
 *   outage for every member, old members included (§2).
 */
export async function buildSignedStatusResponse(args: {
  payload: unknown;
  memberPubkey: string;
  nonceHeader: string | string[] | undefined;
  sign: (message: string) => Promise<string>;
  log?: (line: string) => void;
}): Promise<SignedStatusResponse> {
  const body = Buffer.from(JSON.stringify(args.payload), "utf8");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  };
  const nonce = singleHeader(args.nonceHeader);
  if (nonce == null || !NONCE_RE.test(nonce)) return { headers, body, signed: false };
  try {
    const message = buildTreasuryStatusSignedString(
      args.memberPubkey.toLowerCase(),
      nonce,
      sha256Hex(body),
    );
    headers["X-Bitcorn-Status-Signature"] = await args.sign(message);
    return { headers, body, signed: true };
  } catch (err: any) {
    (args.log ?? console.warn)(
      `[subscription] status signing failed: ${err?.message ?? String(err)}`,
    );
    return { headers, body, signed: false };
  }
}

// ─── Member side (§3.1 step 4) ──────────────────────────────────────────────

export type StatusVerdict =
  | { verdict: "verified" }
  | { verdict: "unsigned" }
  | { verdict: "invalid"; detail: string }
  | { verdict: "unverifiable"; reason: "key_unset" | "lnd_unavailable"; detail: string };

/**
 * The verdict on a status body, BEFORE anything parses it. Rebuilds the
 * signed string from this member's own inputs — its expected pubkey, the nonce
 * IT drew for this call, and the hash of the bytes it received — and asks LND
 * whose key signed it. There is no fallback key (§3.2): unset is
 * `unverifiable`, never "accept".
 */
export async function verifyStatusBytes(args: {
  bytes: Buffer;
  signatureHeader: string | null | undefined;
  expectedTreasuryKey: string | null | undefined;
  expectedMemberPubkey: string | null | undefined;
  nonce: string;
  verify: (message: string, signature: string) => Promise<string>;
}): Promise<StatusVerdict> {
  const key = (args.expectedTreasuryKey ?? "").toLowerCase();
  if (!PUBKEY_RE.test(key)) {
    return { verdict: "unverifiable", reason: "key_unset", detail: "TREASURY_PUBKEY is unset or malformed" };
  }
  const member = (args.expectedMemberPubkey ?? "").toLowerCase();
  if (!PUBKEY_RE.test(member)) {
    // This node's own pubkey comes from LND (lnd_node_info); not known yet.
    return { verdict: "unverifiable", reason: "lnd_unavailable", detail: "this node's pubkey is not known yet" };
  }
  const signature = args.signatureHeader;
  if (signature == null || signature === "") return { verdict: "unsigned" };
  if (!LND_SIGNATURE_RE.test(signature)) {
    return { verdict: "invalid", detail: "signature header is not an LND signature" };
  }
  const message = buildTreasuryStatusSignedString(member, args.nonce, sha256Hex(args.bytes));
  let signedBy: string;
  try {
    signedBy = await args.verify(message, signature);
  } catch (err: any) {
    const detail = typeof err?.message === "string" ? err.message : JSON.stringify(err);
    // ln-service throws this when LND recovers no pubkey from a well-formed
    // signature (rpcserver.go returns Valid:false with no pubkey): the
    // signature does not verify, which is `invalid`, not an LND outage.
    if (/ExpectedPublicKeyInVerifyMessageResponse/.test(detail ?? "")) {
      return { verdict: "invalid", detail: "LND recovered no signer from the signature" };
    }
    return { verdict: "unverifiable", reason: "lnd_unavailable", detail: detail ?? "lnd verify failed" };
  }
  if (typeof signedBy !== "string" || signedBy.toLowerCase() !== key) {
    return { verdict: "invalid", detail: "signature is not the treasury's" };
  }
  return { verdict: "verified" };
}

/** Strict UTF-8 then JSON; null on either failure or a non-object (§3.1 step 5). */
export function parseStatusBytes(bytes: Buffer): Record<string, unknown> | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
