// Client half of per-action confirmation. Mirrors
// app/api/src/utils/action-confirmation.ts — see docs/API.md for the contract.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE HAZARD THIS FILE IS SHAPED AROUND
//
// The one way this mechanism fails in normal use is a UI that hashes something
// OTHER than what it sends. Then every legitimate action 409s, the copy blames
// the user, and the failure looks like tampering.
//
// So `confirmationFor` takes the SERIALIZED REQUEST BODY — the exact string
// going on the wire — and derives the value from it. It is called from one
// place, inside apiFetch, after the body exists and before it is sent. A form
// cannot get this wrong because a form never computes it. There is one artifact,
// not two derivations of one truth.
//
// ⚠ DO NOT add a per-form or per-call-site override. The moment a caller can
// pass its own confirmation, the body and the hash have separate sources again.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY viem's sha256 AND NOT crypto.subtle — MEASURED, NOT ASSUMED
//
// `crypto.subtle` is undefined outside a secure context. Umbrel serves this app
// over plain HTTP on a LAN/tailnet host, so on the address the operator actually
// uses it is simply not there. Measured in Chrome 2026-08-20 against a
// plain-HTTP page on a tailnet IP (100.90.172.18, the same CGNAT 100.64/10 range
// as a real node):
//
//     { origin: "http://100.90.172.18:8731", isSecureContext: false,
//       hasCrypto: true, hasSubtle: false, hasGetRandomValues: true }
//
// and the loopback control on the same server: isSecureContext true, subtle
// present. Note `getRandomValues` survives while `subtle` does not — gating is
// per-member, so a `typeof crypto !== "undefined"` guard passes and then throws.
//
// This is the same wall the Coinbase Wallet SDK hits; see
// stablecoin/secureContext.ts, which documents it for crypto.randomUUID.
//
// viem is already a dependency and its sha256 is pure JS (@noble/hashes). It is
// used UNCONDITIONALLY — no secure-context branch, no native fast path. Two
// implementations would mean the one the operator exercises is the less-tested
// one, and a divergence between them would surface as a 409 nobody can explain.
// actionConfirmation.test.ts asserts correctness with crypto.subtle DELETED from
// the global, so "optimizing" back to the native API cannot pass silently.
// ═══════════════════════════════════════════════════════════════════════════

import { sha256 } from "viem";

export const CONFIRMATION_HEADER = "x-bitcorn-confirm";

export type FieldKind = "text" | "number" | "boolean";

export type Field = {
  name: string;
  from: "body" | "path";
  kind: FieldKind;
  optional?: boolean;
};

export type Matcher =
  | { kind: "exact"; url: string }
  | { kind: "prefix"; url: string }
  | { kind: "wrap"; prefix: string; suffix: string };

export type ConfirmedRoute = { method: string; match: Matcher; fields: Field[] };

/**
 * The routes this UI can reach that require a confirmation.
 *
 * ⚠ MUST AGREE WITH THE SERVER, field-for-field and IN ORDER. It is not
 * derived from it — the two run in different processes — so agreement is
 * enforced by test instead: actionConfirmation.parity.test.ts imports the
 * server's CONFIRMED_ROUTES and asserts every route reachable from this UI
 * matches entry for entry. A drift fails there, not in production.
 *
 * Only the eight routes with a real UI caller are listed. /api/pay,
 * /api/treasury/rebalance/{loop-out,circular} and
 * /api/lightning/open-recommended-channel have no caller in this app (the last
 * three via client methods nothing invokes), so listing them here would be
 * dead data that the parity test would then have to special-case.
 */
export const UI_CONFIRMED_ROUTES: ConfirmedRoute[] = [
  {
    method: "POST",
    match: { kind: "exact", url: "/api/treasury/expansion/execute" },
    fields: [
      { name: "peer_pubkey", from: "body", kind: "text" },
      { name: "capacity_sats", from: "body", kind: "number" },
      { name: "dry_run", from: "body", kind: "boolean", optional: true },
    ],
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/treasury/rotation/execute" },
    fields: [
      { name: "channel_id", from: "body", kind: "text" },
      { name: "is_force_close", from: "body", kind: "boolean", optional: true },
      { name: "dry_run", from: "body", kind: "boolean", optional: true },
    ],
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/member/open-channel" },
    fields: [
      { name: "capacity_sats", from: "body", kind: "number" },
      { name: "partner_socket", from: "body", kind: "text", optional: true },
    ],
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/network/pay" },
    fields: [{ name: "payment_request", from: "body", kind: "text" }],
  },
  {
    method: "POST",
    match: { kind: "wrap", prefix: "/api/member-liquidity/recommendations/", suffix: "/approve" },
    fields: [{ name: "recommendation_id", from: "path", kind: "text" }],
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/swaps/loop-out" },
    fields: [
      { name: "swap_request_id", from: "body", kind: "text" },
      { name: "destination_address", from: "body", kind: "text" },
    ],
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/swaps/loop-in" },
    fields: [{ name: "swap_request_id", from: "body", kind: "text" }],
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/admin/swaps/loop-out" },
    fields: [
      { name: "swap_request_id", from: "body", kind: "text" },
      { name: "destination_address", from: "body", kind: "text", optional: true },
    ],
  },
];

function matches(m: Matcher, url: string): boolean {
  switch (m.kind) {
    case "exact":
      return url === m.url;
    case "prefix":
      return url.startsWith(m.url);
    case "wrap":
      return url.startsWith(m.prefix) && url.endsWith(m.suffix);
  }
}

export function findUiConfirmedRoute(method: string, url: string): ConfirmedRoute | null {
  for (const r of UI_CONFIRMED_ROUTES) if (r.method === method && matches(r.match, url)) return r;
  return null;
}

const UNSAFE = /[&=\r\n]/;

function pathSegment(m: Matcher, url: string): string | null {
  if (m.kind !== "wrap") return null;
  return url.slice(m.prefix.length, url.length - m.suffix.length);
}

export type DeriveResult =
  | { ok: true; value: string; canonical: string }
  | { ok: false; reason: string; field?: string };

/**
 * Derive the confirmation from the SERIALIZED body actually being sent.
 *
 * `serializedBody` is the request's own `body` string, parsed here rather than
 * accepting an object, so there is no path by which a caller hands over an
 * object that differs from what it serialized.
 *
 * Canonicalisation matches the server exactly: `name=value` in field-list
 * order joined by `&`; ABSENT (missing/undefined/null) contributes no token;
 * PRESENT always contributes one; numbers normalise through Number() and refuse
 * empty; booleans mirror the route's `=== true`; text is never trimmed.
 */
export function confirmationFor(
  route: ConfirmedRoute,
  url: string,
  serializedBody: string | null | undefined
): DeriveResult {
  let parsed: unknown = null;
  if (serializedBody != null && serializedBody.length > 0) {
    try {
      parsed = JSON.parse(serializedBody);
    } catch {
      return { ok: false, reason: "body_not_json" };
    }
  }

  const needsBody = route.fields.some((f) => f.from === "body");
  if (needsBody && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
    return { ok: false, reason: "not_an_object" };
  }
  const bag = (parsed ?? {}) as Record<string, unknown>;

  const parts: string[] = [];
  for (const f of route.fields) {
    const raw = f.from === "path" ? pathSegment(route.match, url) : bag[f.name];

    if (raw === undefined || raw === null) {
      if (f.optional) continue;
      return { ok: false, reason: "missing_field", field: f.name };
    }

    let normalised: string;
    if (f.kind === "boolean") {
      normalised = raw === true ? "true" : "false";
    } else if (f.kind === "number") {
      if (raw === "") return { ok: false, reason: "bad_number", field: f.name };
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, reason: "bad_number", field: f.name };
      normalised = String(n);
    } else {
      if (typeof raw !== "string") return { ok: false, reason: "missing_field", field: f.name };
      normalised = raw;
      if (normalised === "" && !f.optional) return { ok: false, reason: "missing_field", field: f.name };
    }

    if (UNSAFE.test(normalised)) return { ok: false, reason: "unsafe_value", field: f.name };
    parts.push(`${f.name}=${normalised}`);
  }

  if (parts.length === 0) return { ok: false, reason: "missing_field", field: "(all)" };

  const canonical = parts.join("&");
  // sha256 returns "0x…"; the header carries bare hex, as the shell idiom does.
  const value = sha256(new TextEncoder().encode(canonical)).slice(2);
  return { ok: true, value, canonical };
}
