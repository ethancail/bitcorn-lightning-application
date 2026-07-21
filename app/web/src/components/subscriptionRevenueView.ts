// Pure view-model logic for the subscription-revenue surfaces
// (SubscriptionRevenuePanel on the treasury dashboard + the revenue
// columns on AdminMembers). Extracted from the components so it can be
// unit-tested — same pattern as aliasInputState.ts / payModalMachine.ts.
//
// Case normalization: subscription pubkeys arrive LOWERCASED from the
// API (the subscription tables store them lowercased), while contacts
// store the pubkey as it was entered/synced. resolveContactName() does
// an exact === match, so both sides are lowercased here before joining
// — without this, an uppercase-entered contact silently falls back to
// the truncated pubkey.

import {
  resolveContactName,
  type Contact,
  type MemberRevenueRow,
} from "../api/client";

export type TopEarnerRow = {
  member_pubkey: string;
  /** Contact name, or truncated pubkey when no contact matches. */
  name: string;
  total_sats: number;
  total_usd_cents: number;
  payment_count: number;
};

/** Contacts with pubkeys lowercased, ready for exact-match joins
 *  against API-lowercased subscription pubkeys. */
export function lowercaseContacts(contacts: Contact[]): Contact[] {
  return contacts.map((c) => ({ ...c, pubkey: c.pubkey.toLowerCase() }));
}

/**
 * Top `limit` members by all-time revenue, with display names attached.
 * `members` arrives sorted total_sats DESC from the API; slicing here
 * keeps the widget honest if that ever changes.
 */
export function topEarners(
  members: MemberRevenueRow[],
  contacts: Contact[],
  limit = 5,
): TopEarnerRow[] {
  const lowered = lowercaseContacts(contacts);
  return [...members]
    .sort((a, b) => b.total_sats - a.total_sats)
    .slice(0, limit)
    .map((m) => ({
      member_pubkey: m.member_pubkey,
      name: resolveContactName(m.member_pubkey.toLowerCase(), lowered),
      total_sats: m.total_sats,
      total_usd_cents: m.total_usd_cents,
      payment_count: m.payment_count,
    }));
}

/** Per-member revenue keyed by lowercased pubkey, for O(1) row joins
 *  on AdminMembers (whose pubkeys come from lnd_channels, not the
 *  subscription tables — case not guaranteed). */
export function buildRevenueLookup(
  members: MemberRevenueRow[],
): Map<string, MemberRevenueRow> {
  return new Map(members.map((m) => [m.member_pubkey.toLowerCase(), m]));
}

/** "$31.27" — cents to a display dollar string. Callers decide whether
 *  0 means "render $0.00" or "omit" (no USD captured). */
export function fmtUsdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
