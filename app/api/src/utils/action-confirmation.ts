// Per-action confirmation for capital-moving routes on port 3101.
//
// WHAT THIS IS. A capital-moving route requires the caller to send a
// confirmation value derived from that same request's own consequential
// caller-supplied fields. The server recomputes the value from what ACTUALLY
// ARRIVED and compares. Nothing is stored, nothing is issued, no login.
//
// WHAT IT PROVES, precisely: PARAMETER KNOWLEDGE. It stops a blind scanner, a
// replay carrying different parameters, and a mis-click. It does NOT stop an
// in-page script, and it does NOT stop a determined caller on the tailnet who
// can read the request they are about to send — such a caller can compute the
// value as easily as the UI can. That is understood and accepted: treasury
// reads stay open, and anyone on the LAN or tailnet can read the dashboard.
//
// DO NOT "STRENGTHEN" THIS INTO AN AUTH MECHANISM. It is not one, and dressing
// it up as one would be worse than leaving it honest — a secret in this shape
// would live in the page and in shell history. Caller authentication and the
// capital-guardrail layer are separate arcs; this module must not grow into
// either. See utils/capital-guardrails.ts for the limits that DO bind
// automation, which this cannot and must not replace.
//
// Decision recorded 2026-08-18 (Alternative B, no-secret form).

import crypto from "crypto";

/** Header carrying the caller-computed confirmation value. */
export const CONFIRMATION_HEADER = "x-bitcorn-confirm";

export const CONFIRMATION_REQUIRED = {
  status: 400 as const,
  error: "confirmation_required" as const,
};

export const CONFIRMATION_MISMATCH = {
  status: 409 as const,
  error: "confirmation_mismatch" as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Route table — DATA, not control flow.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `number` fields are normalised through Number() before hashing, so a caller
 * may send 250000 or "250000" and get the same value — which is exactly what
 * the routes themselves do (`Number(parsed.capacity_sats)`). `text` fields are
 * hashed as they arrived, with NO trimming: trimming would map " " to "" and
 * reopen the empty-collapse hole this module exists partly to close.
 */
export type FieldKind = "text" | "number";

export type Field = {
  name: string;
  from: "body" | "path";
  kind: FieldKind;
  /** Optional fields are hashed only when present; presence is itself covered. */
  optional?: boolean;
};

export type Matcher =
  | { kind: "exact"; url: string }
  /** Dispatch matches these with startsWith(url) alone. */
  | { kind: "prefix"; url: string }
  /** Dispatch matches these with startsWith(prefix) && endsWith(suffix). */
  | { kind: "wrap"; prefix: string; suffix: string };

export type ConfirmedRoute = {
  method: "POST" | "PATCH" | "DELETE" | "PUT";
  match: Matcher;
  /** 1 = parameter echo (body carries the consequence). 2 = selector echo. */
  shape: 1 | 2;
  fields: Field[];
  /** Why these fields and not others. */
  note: string;
};

/**
 * The twelve capital-moving routes that take a confirmation.
 *
 * Derived from dispatch reachability to an outflow primitive — see
 * action-confirmation.coverage.test.ts, which re-derives this set from the
 * TypeScript AST and fails if it drifts from what is written here.
 *
 * THREE reachable routes are deliberately absent, and their absence is enforced
 * as EXEMPT_MUTATIONS entries rather than left implicit: /api/autobuy/execute-now,
 * /api/treasury/rebalance/loop-out/auto, and /api/subscription/pay-from-node take
 * NO consequential caller-supplied parameter, so there is nothing to prove
 * knowledge of. An intent nonce was considered for them and declined.
 */
export const CONFIRMED_ROUTES: ConfirmedRoute[] = [
  {
    method: "POST",
    match: { kind: "exact", url: "/api/treasury/expansion/execute" },
    shape: 1,
    fields: [
      { name: "peer_pubkey", from: "body", kind: "text" },
      { name: "capacity_sats", from: "body", kind: "number" },
    ],
    note: "Opens a channel to peer_pubkey for capacity_sats. Both are the consequence.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/treasury/rotation/execute" },
    shape: 1,
    fields: [{ name: "channel_id", from: "body", kind: "text" }],
    note: "Closes channel_id. The channel identity IS the consequence; force/fee are modifiers.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/treasury/rebalance/loop-out" },
    shape: 1,
    fields: [
      { name: "channel_id", from: "body", kind: "text" },
      { name: "amount_sats", from: "body", kind: "number" },
    ],
    note: "Loop Out of amount_sats from channel_id.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/treasury/rebalance/circular" },
    shape: 1,
    fields: [
      { name: "outgoing_channel", from: "body", kind: "text" },
      { name: "incoming_channel", from: "body", kind: "text" },
      { name: "tokens", from: "body", kind: "number" },
    ],
    note: "Moves `tokens` out of outgoing_channel and back in via incoming_channel.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/pay" },
    shape: 1,
    fields: [{ name: "payment_request", from: "body", kind: "text" }],
    note: "The invoice fixes destination and amount; it is the whole consequence.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/member/open-channel" },
    shape: 1,
    fields: [
      { name: "capacity_sats", from: "body", kind: "number" },
      { name: "partner_socket", from: "body", kind: "text", optional: true },
    ],
    note:
      "Peer is ENV.treasuryPubkey (server-side), so capacity_sats is the only required " +
      "caller consequence. partner_socket is an optional connect hint and is covered when sent.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/lightning/open-recommended-channel" },
    shape: 1,
    fields: [
      { name: "peer_id", from: "body", kind: "text" },
      { name: "local_funding_amount_sat", from: "body", kind: "number" },
    ],
    note: "Opens a channel to peer_id for local_funding_amount_sat.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/network/pay" },
    shape: 1,
    fields: [{ name: "payment_request", from: "body", kind: "text" }],
    note: "As /api/pay — the invoice is the consequence.",
  },
  {
    method: "POST",
    match: {
      kind: "wrap",
      prefix: "/api/member-liquidity/recommendations/",
      suffix: "/approve",
    },
    shape: 2,
    fields: [{ name: "recommendation_id", from: "path", kind: "text" }],
    note:
      "Selector echo: the amount and peer live in the stored recommendation, not the " +
      "request. The id is the only caller-supplied field, and choosing it IS the act.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/swaps/loop-out" },
    shape: 2,
    fields: [
      { name: "swap_request_id", from: "body", kind: "text" },
      { name: "destination_address", from: "body", kind: "text" },
    ],
    note:
      "Selector echo plus destination: the amount comes from the stored quote, but " +
      "destination_address is caller-supplied and is where the coins land.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/swaps/loop-in" },
    shape: 2,
    fields: [{ name: "swap_request_id", from: "body", kind: "text" }],
    note: "Selector echo: amount comes from the stored quote; Loop In has no destination.",
  },
  {
    method: "POST",
    match: { kind: "exact", url: "/api/admin/swaps/loop-out" },
    shape: 2,
    fields: [
      { name: "swap_request_id", from: "body", kind: "text" },
      { name: "destination_address", from: "body", kind: "text", optional: true },
    ],
    note:
      "As /api/swaps/loop-out, but destination_address is optional here (absent = default " +
      "sweep address). Presence is covered, so omitting it changes the value.",
  },
];

/**
 * Mutation dispatch sites that do NOT take a confirmation.
 *
 * DERIVED, not authored: this is the complement of CONFIRMED_ROUTES within the
 * full mutation-dispatch enumeration of index.ts, and the coverage test
 * re-derives that enumeration from the AST and asserts this list matches it
 * exactly. Adding a mutation route to index.ts without classifying it here
 * fails the test; it also fails CLOSED at runtime (see classifyMutation).
 */
export const EXEMPT_MUTATIONS: Array<{ method: string; match: Matcher; why: string }> = [
  // ── Reachable outflow, but no consequential caller-supplied parameter.
  //    Excluded by decision 2026-08-18; intent nonce considered and declined.
  { method: "POST", match: { kind: "exact", url: "/api/subscription/pay-from-node" }, why: "group3-no-parameter" },
  { method: "POST", match: { kind: "exact", url: "/api/treasury/rebalance/loop-out/auto" }, why: "group3-no-parameter" },
  { method: "POST", match: { kind: "exact", url: "/api/autobuy/execute-now" }, why: "group3-no-parameter" },

  // ── No outflow reachable: config, local state, quotes, reads-with-side-effects.
  { method: "POST", match: { kind: "exact", url: "/lnd/sync" }, why: "sync only" },
  { method: "POST", match: { kind: "exact", url: "/api/admin/subscription/acknowledge-first-run" }, why: "local flag" },
  { method: "POST", match: { kind: "exact", url: "/api/subscription/token" }, why: "token exchange" },
  { method: "POST", match: { kind: "wrap", prefix: "/api/profile/auto-pay/alerts/", suffix: "/dismiss" }, why: "alert state" },
  { method: "POST", match: { kind: "exact", url: "/api/profile/auto-pay" }, why: "config" },
  { method: "POST", match: { kind: "exact", url: "/api/profile/acknowledge-price-change" }, why: "local flag" },
  { method: "POST", match: { kind: "exact", url: "/api/profile/alias" }, why: "node alias" },
  { method: "DELETE", match: { kind: "exact", url: "/api/profile/alias" }, why: "node alias" },
  { method: "POST", match: { kind: "exact", url: "/api/valuation/manual" }, why: "valuation input" },
  { method: "POST", match: { kind: "exact", url: "/api/valuation/refresh-worker" }, why: "cache refresh" },
  { method: "POST", match: { kind: "exact", url: "/api/stablecoin/wallet/challenge" }, why: "SIWE nonce" },
  { method: "POST", match: { kind: "exact", url: "/api/stablecoin/wallet" }, why: "wallet registration" },
  { method: "DELETE", match: { kind: "exact", url: "/api/stablecoin/wallet" }, why: "wallet removal" },
  { method: "POST", match: { kind: "exact", url: "/api/treasury/peers/connect" }, why: "peer connect, no funds" },
  { method: "POST", match: { kind: "exact", url: "/api/treasury/fee-policy" }, why: "fee policy" },
  { method: "POST", match: { kind: "exact", url: "/api/treasury/fees/apply-dynamic" }, why: "fee policy" },
  { method: "POST", match: { kind: "exact", url: "/api/treasury/capital-policy" }, why: "policy config" },
  { method: "PATCH", match: { kind: "exact", url: "/api/liquidity/config" }, why: "config" },
  { method: "POST", match: { kind: "wrap", prefix: "/api/member-liquidity/recommendations/", suffix: "/reject" }, why: "declines, moves nothing" },
  { method: "POST", match: { kind: "exact", url: "/api/network/sync-settlements" }, why: "sync only" },
  { method: "DELETE", match: { kind: "prefix", url: "/api/network/payments/" }, why: "ledger row delete" },
  { method: "POST", match: { kind: "exact", url: "/api/network/decode" }, why: "decode only" },
  { method: "POST", match: { kind: "exact", url: "/api/network/invoice" }, why: "invoice creation, inbound" },
  { method: "POST", match: { kind: "exact", url: "/api/contacts/sync-peers" }, why: "contact sync" },
  { method: "POST", match: { kind: "exact", url: "/api/contacts" }, why: "contact CRUD" },
  { method: "PATCH", match: { kind: "prefix", url: "/api/contacts/" }, why: "contact CRUD" },
  { method: "DELETE", match: { kind: "prefix", url: "/api/contacts/" }, why: "contact CRUD" },
  { method: "POST", match: { kind: "exact", url: "/api/swaps/loop-out/quote" }, why: "quote only" },
  { method: "POST", match: { kind: "exact", url: "/api/swaps/loop-in/quote" }, why: "quote only" },
  { method: "POST", match: { kind: "exact", url: "/api/admin/swaps/loop-out/quote" }, why: "quote only" },
  { method: "POST", match: { kind: "exact", url: "/api/admin/swaps/loop-in/quote" }, why: "quote only" },
  { method: "POST", match: { kind: "exact", url: "/api/admin/swaps/loop-in" }, why: "410 deprecated, no body" },
  { method: "POST", match: { kind: "exact", url: "/api/autobuy/enable" }, why: "config" },
  { method: "POST", match: { kind: "exact", url: "/api/autobuy/pause" }, why: "config" },
  { method: "POST", match: { kind: "exact", url: "/api/autobuy/credentials" }, why: "credential storage" },
  { method: "DELETE", match: { kind: "exact", url: "/api/autobuy/credentials" }, why: "credential removal" },
  { method: "POST", match: { kind: "exact", url: "/api/autobuy/credentials/verify" }, why: "credential check" },
  { method: "POST", match: { kind: "wrap", prefix: "/api/autobuy/alerts/", suffix: "/dismiss" }, why: "alert state" },
  { method: "PATCH", match: { kind: "exact", url: "/api/autobuy/config" }, why: "config" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors how index.ts dispatch matches, deliberately: on the RAW req.url, with
 * no query stripping. Dispatch compares `req.url === "/api/pay"`, so a URL
 * carrying a query string does not reach that handler and must not match here
 * either — otherwise the gate and the dispatch would disagree about which route
 * a request is, which is the one way this can fail open.
 */
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

export function findConfirmedRoute(method: string, url: string): ConfirmedRoute | null {
  for (const r of CONFIRMED_ROUTES) {
    if (r.method === method && matches(r.match, url)) return r;
  }
  return null;
}

export type Classification = "confirm" | "exempt" | "unknown";

/**
 * FAILS CLOSED. A mutation matching neither table classifies as "unknown", and
 * the caller treats that as confirmation-required. A newly added mutation route
 * therefore refuses traffic until someone classifies it — which is the point of
 * default-require, and is why this is not opt-in on twelve routes.
 */
export function classifyMutation(method: string, url: string): Classification {
  if (findConfirmedRoute(method, url)) return "confirm";
  for (const e of EXEMPT_MUTATIONS) {
    if (e.method === method && matches(e.match, url)) return "exempt";
  }
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Derivation
// ─────────────────────────────────────────────────────────────────────────────

export type DeriveFailure =
  | { ok: false; reason: "not_an_object" }
  | { ok: false; reason: "missing_field"; field: string }
  | { ok: false; reason: "bad_number"; field: string }
  | { ok: false; reason: "unsafe_value"; field: string };

export type DeriveResult = { ok: true; value: string; canonical: string } | DeriveFailure;

/**
 * `&` and `=` frame the canonical string and a newline would break the shell
 * idiom, so a value containing one is REFUSED rather than escaped. No legitimate
 * value here can contain them — bech32 invoices, hex pubkeys, numeric channel
 * ids, `host:port` sockets and base58/bech32 addresses all exclude them — so
 * refusing costs nothing and removes the ambiguity instead of making it unlikely.
 */
const UNSAFE = /[&=\r\n]/;

function pathSegment(m: Matcher, url: string): string | null {
  if (m.kind !== "wrap") return null;
  return url.slice(m.prefix.length, url.length - m.suffix.length);
}

/** Recompute the expected confirmation from what actually arrived. */
export function deriveConfirmation(
  route: ConfirmedRoute,
  ctx: { url: string; body: unknown }
): DeriveResult {
  const body = ctx.body;
  const needsBody = route.fields.some((f) => f.from === "body");
  if (needsBody && (typeof body !== "object" || body === null || Array.isArray(body))) {
    return { ok: false, reason: "not_an_object" };
  }
  const bag = (body ?? {}) as Record<string, unknown>;

  const parts: string[] = [];
  for (const f of route.fields) {
    const raw = f.from === "path" ? pathSegment(route.match, ctx.url) : bag[f.name];

    if (raw === undefined || raw === null || raw === "") {
      if (f.optional) continue;
      return { ok: false, reason: "missing_field", field: f.name };
    }

    let normalised: string;
    if (f.kind === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, reason: "bad_number", field: f.name };
      normalised = String(n);
    } else {
      if (typeof raw !== "string") return { ok: false, reason: "missing_field", field: f.name };
      normalised = raw;
    }

    // Empty AFTER normalisation is still missing. Guarding both here and above
    // is deliberate: `String(Number(""))` is "0", not "", so the pre-check is
    // what actually catches an empty numeric field.
    if (normalised === "") {
      if (f.optional) continue;
      return { ok: false, reason: "missing_field", field: f.name };
    }
    if (UNSAFE.test(normalised)) return { ok: false, reason: "unsafe_value", field: f.name };

    parts.push(`${f.name}=${normalised}`);
  }

  if (parts.length === 0) return { ok: false, reason: "missing_field", field: "(all)" };

  const canonical = parts.join("&");
  const value = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return { ok: true, value, canonical };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification
// ─────────────────────────────────────────────────────────────────────────────

export type VerifyResult =
  | { ok: true }
  | { ok: false; status: 400; error: "confirmation_required"; detail: string }
  | { ok: false; status: 409; error: "confirmation_mismatch"; detail: string };

/**
 * ⚠ THE COMPARISON MUST REJECT EMPTY ON BOTH SIDES.
 *
 * `env.ts`'s `|| ""` idiom plus a naive `===` gives `"" === ""` → pass. That
 * exact bug was live in sync.ts:15. Here the supplied value is rejected for
 * emptiness BEFORE any comparison happens, and the derived side can never be
 * empty (a sha256 hex digest is always 64 characters) — so there is no input
 * on which both sides are empty and the comparison is reached. The unit tests
 * assert this directly rather than trusting the argument.
 */
export function verifyConfirmation(
  route: ConfirmedRoute,
  ctx: { url: string; body: unknown },
  supplied: string | string[] | null | undefined
): VerifyResult {
  // Never coalesce to "". An absent header, an empty header, and a repeated
  // header are all refusals, not a value.
  if (typeof supplied !== "string" || supplied.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "confirmation_required",
      detail: `send ${CONFIRMATION_HEADER}: sha256 of ${route.fields
        .filter((f) => !f.optional)
        .map((f) => `${f.name}=<value>`)
        .join("&")}`,
    };
  }

  const derived = deriveConfirmation(route, ctx);
  if (!derived.ok) {
    return {
      ok: false,
      status: 400,
      error: "confirmation_required",
      detail:
        derived.reason === "missing_field"
          ? `cannot derive confirmation: ${derived.field} is missing or empty`
          : derived.reason === "bad_number"
            ? `cannot derive confirmation: ${derived.field} is not a finite number`
            : derived.reason === "unsafe_value"
              ? `cannot derive confirmation: ${derived.field} contains a reserved character`
              : "cannot derive confirmation: body is not a JSON object",
    };
  }

  const a = Buffer.from(derived.value, "utf8");
  const b = Buffer.from(supplied, "utf8");
  const equal = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!equal) {
    return {
      ok: false,
      status: 409,
      error: "confirmation_mismatch",
      detail: "confirmation does not match the parameters in this request",
    };
  }
  return { ok: true };
}
