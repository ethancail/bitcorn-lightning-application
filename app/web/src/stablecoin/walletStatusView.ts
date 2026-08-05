// What the Stablecoin page's wallet surface should show, given a wallet status.
//
// Extracted from Stablecoin.tsx when wallet registration moved onto that page.
// Both predicates decide what a member sees on the FIRST screen of the rail —
// the branch between "register a wallet" and "here is your wallet" — so they are
// worth pinning independently of a renderer.
//
// Pure + dependency-light so it unit-tests without a DOM or a React renderer,
// the same pattern as pendingStore.ts / revertClassifier.ts / settlementAmounts.ts.
// ⚠ app/web/vitest.config.ts collects only `src/**/*.test.ts`, NOT `*.test.tsx`,
// so logic that lives inside a component is untestable in this project today.
// That is the reason these two moved out here rather than staying inline.

import type { WalletStatusResponse } from "./client";

/**
 * How long after registration a missing /balance response reads as "the sync
 * loop hasn't gotten to it yet" rather than as a generic empty state.
 *
 * The sync loop's tick interval is on the order of 30s, plus an RPC round-trip.
 * Being conservative here avoids showing "Syncing…" indefinitely for a wallet
 * that is genuinely uncached for some other reason. (Item 31c)
 */
export const FIRST_SYNC_WINDOW_MS = 5 * 60 * 1000;

/**
 * Does this member have a usable registered wallet?
 *
 * Checks BOTH `wallet_address` and `is_active`, which preserves exactly what the
 * inline branch in Stablecoin.tsx did before this moved out here.
 *
 * ⚠ The two cannot currently disagree, and that is a property of the API rather
 * than of the type. `handleWalletStatus` (app/api/src/stablecoin/handlers.ts:246)
 * reads `listActiveBaseWallets()`, whose query filters `WHERE is_active = 1`
 * (base/store.ts:31) — so a deregistered wallet is simply not found and the
 * response is `{ wallet_address: null, registered_at: null, is_active: false }`.
 * Deregistration IS a soft delete in the DB (handlers.ts:259 sets `is_active =
 * 0`), but that inactive row never reaches the client.
 *
 * The `is_active` half is therefore belt-and-braces, kept deliberately: the
 * response TYPE permits `{ wallet_address: "0x…", is_active: false }`, and any
 * future read that stops filtering on the server would deliver exactly that.
 * Dropping the check would then show a disconnected member their old address and
 * hide the registration flow they need. Returns a boolean rather than the address
 * so callers cannot accidentally branch on a truthy string.
 */
export function hasRegisteredWallet(status: WalletStatusResponse | null): boolean {
    return Boolean(status?.wallet_address) && Boolean(status?.is_active);
}

/**
 * Is this wallet new enough that an absent cached balance means "not synced
 * yet" rather than "unavailable"?
 *
 * `now` is injectable so this is testable without freezing the clock; callers
 * in the app omit it. Requires a registered wallet — an unregistered member is
 * never "awaiting first sync", they are awaiting registration.
 */
export function isAwaitingFirstSync(
    status: WalletStatusResponse | null,
    now: number = Date.now(),
): boolean {
    if (!hasRegisteredWallet(status)) return false;
    const registeredAt = status?.registered_at;
    if (!registeredAt) return false;
    return now - registeredAt < FIRST_SYNC_WINDOW_MS;
}
