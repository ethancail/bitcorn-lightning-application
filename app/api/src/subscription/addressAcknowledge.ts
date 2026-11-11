// Acknowledging a changed subscription deposit address — the host-only path.
//
// Source of truth: bitcorn-research specs/2026-11-10-treasury-price-trust-
// spec.md §6.4 (D4), held by ruling 4 and released by Ethan's ruling (a) on
// query QA, 2026-11-10: no legitimate address change exists in routine use.
//
// ⚠ NOT AN HTTP ROUTE, AND MUST NEVER BECOME ONE. Port 3101 authenticates no
// caller, and per-action confirmation proves parameter knowledge only; both
// addresses such a route would echo are readable from the member's own status
// proxy. Any LAN or private-origin caller could then re-pin, and D4 — the pin
// that holds against a compromised treasury — would be undone. It runs only as
// a command inside the member's API container (cli/acknowledge-deposit-
// address.ts). Control C11 fails if a non-test module other than that command
// reaches it.
//
// THE ECHO RULE (pay-from-node spec §6 Q6): the operator names the new address;
// a FRESH verified status must state exactly that address; only then is an
// `acknowledged` pin appended. Unverified, not applicable, or a different
// address: nothing is written.

import type Database from "better-sqlite3";
import type { VerifiedStatusResult } from "./memberStatusClient";
import { appendAcknowledgedPin, getCurrentPin } from "./depositAddressPin";

export type AcknowledgeOutcome =
  | { ok: true; action: "pinned"; address: string; previous: string | null }
  | { ok: true; action: "already_pinned"; address: string }
  | {
      ok: false;
      code: "status_unverified" | "status_unavailable" | "not_applicable" | "address_mismatch";
      detail: string;
    };

export async function acknowledgeDepositAddressChange(args: {
  address: string;
  memberPubkey: string;
  fetchStatus: () => Promise<VerifiedStatusResult>;
  db: Database.Database;
  nowSec: number;
}): Promise<AcknowledgeOutcome> {
  const fetched = await args.fetchStatus();
  if (!fetched.ok) {
    return fetched.code === "status_unverified"
      ? {
          ok: false,
          code: "status_unverified",
          detail: `the treasury's status is ${fetched.verdict}${fetched.verification_reason ? ` (${fetched.verification_reason})` : ""}; nothing was pinned`,
        }
      : { ok: false, code: "status_unavailable", detail: `${fetched.detail}; nothing was pinned` };
  }
  const s = fetched.status as { applicable?: unknown; deposit_address?: unknown };
  if (s.applicable !== true || typeof s.deposit_address !== "string" || s.deposit_address.length === 0) {
    return { ok: false, code: "not_applicable", detail: "the treasury states no deposit address for this node; nothing was pinned" };
  }
  if (s.deposit_address !== args.address) {
    return {
      ok: false,
      code: "address_mismatch",
      detail: `the treasury's verified status states ${s.deposit_address}, not ${args.address}; nothing was pinned`,
    };
  }
  const current = getCurrentPin(args.db, args.memberPubkey);
  if (current?.deposit_address === args.address) {
    return { ok: true, action: "already_pinned", address: args.address };
  }
  appendAcknowledgedPin(args.db, args.memberPubkey, args.address, args.nowSec);
  return { ok: true, action: "pinned", address: args.address, previous: current?.deposit_address ?? null };
}
