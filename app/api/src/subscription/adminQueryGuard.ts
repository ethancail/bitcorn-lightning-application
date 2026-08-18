// Refusal of the `?member_pubkey=<hex>` admin-debug query on
// GET /api/subscription/status and GET /api/subscription/payments.
//
// Why this exists: on the treasury that query was gated by `assertTreasury`
// ONLY. `assertTreasury` is a NODE-ROLE check — "am I the treasury node?" — so
// on the treasury it passes for every caller, including an unauthenticated one.
// The lookup pubkey then became the caller's choice, letting anyone who could
// reach port 3101 read any member's subscription state and full payment ledger.
// A node-role check is not caller authentication.
//
// The member side already refused the parameter outright rather than trying to
// authenticate it (index.ts:580-581 for /status, :749-751 for /payments). This
// module carries that same decision so the treasury refuses it too.
//
// Deliberately NOT done here, and not to be added later without revisiting the
// disclosure: no authentication of the parameter, no allowlist of permitted
// pubkeys, no preserved "admin debug" path. Presence alone is the rejection.
// The treasury dashboard never used this query — it reads /api/admin/members
// and /api/admin/subscription/revenue instead — so refusing it costs nothing.

export const ADMIN_QUERY_REJECTION = {
  status: 403,
  body: { error: "admin_query_treasury_only" },
} as const;

/**
 * True when the request carries an admin `member_pubkey` query parameter and
 * must therefore be refused.
 *
 * Takes the ALREADY-EXTRACTED value (`url.searchParams.get("member_pubkey")`)
 * rather than the raw URL, because the two call sites build their `URL` with
 * different bases — `"http://localhost"` for /status, `req.headers.host` for
 * /payments — and this fix must not alter either one's parsing.
 *
 * Truthiness, not a null check: that is precisely what the member side tests,
 * so `?member_pubkey=` with an empty value reads as ABSENT on both sides. Note
 * that a whitespace-only value IS a refusal — the value is never trimmed, since
 * trimming would turn " " into "" and reopen the disclosure to any caller who
 * pads the parameter.
 */
export function isAdminMemberQuery(queryPubkey: string | null): boolean {
  return Boolean(queryPubkey);
}
