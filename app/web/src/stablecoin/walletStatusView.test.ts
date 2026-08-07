import { describe, expect, it } from "vitest";
import {
    FIRST_SYNC_WINDOW_MS,
    hasRegisteredWallet,
    isAwaitingFirstSync,
} from "./walletStatusView";
import type { WalletStatusResponse } from "./client";

// These two predicates decide the FIRST thing a member sees on the rail: whether
// the Stablecoin page offers wallet registration or shows their wallet. Before
// the registration panel moved onto that page they were inline in the component,
// where this project cannot test them at all — vitest.config.ts collects only
// `src/**/*.test.ts`, and there is no `.test.tsx` in the repo.

const status = (over: Partial<WalletStatusResponse> = {}): WalletStatusResponse => ({
    wallet_address: "0x4842925CF6B6671e8e1A25892bdeA0807b4814fD",
    registered_at: 1_700_000_000_000,
    is_active: true,
    ...over,
});

describe("hasRegisteredWallet", () => {
    it("is true only for an address that is also active", () => {
        expect(hasRegisteredWallet(status())).toBe(true);
    });

    it("is false for the unregistered response the API actually sends", () => {
        // Not a hypothetical shape: handleWalletStatus returns exactly this when
        // listActiveBaseWallets() finds no active row for the member.
        expect(hasRegisteredWallet({ wallet_address: null, registered_at: null, is_active: false }))
            .toBe(false);
    });

    it("is false while the status is still loading", () => {
        expect(hasRegisteredWallet(null)).toBe(false);
    });

    it("is false for an address flagged inactive — the belt-and-braces case", () => {
        // ⚠ The API cannot currently produce this: its query filters
        // `is_active = 1`, so a deregistered wallet comes back as nulls, not as
        // an inactive address. The response TYPE permits it, and any future read
        // that stops filtering server-side would deliver it. This test is what
        // stops someone "simplifying" the predicate to a truthiness check on the
        // address, which would show a disconnected member their old wallet and
        // hide the registration flow they need.
        expect(hasRegisteredWallet(status({ is_active: false }))).toBe(false);
    });

    it("returns a boolean, never the address", () => {
        // Guards against `return status?.wallet_address && status?.is_active`,
        // which type-checks in a JSX truthiness position but leaks a string.
        expect(typeof hasRegisteredWallet(status())).toBe("boolean");
    });
});

describe("isAwaitingFirstSync", () => {
    const registeredAt = 1_700_000_000_000;

    it("is true immediately after registration", () => {
        expect(isAwaitingFirstSync(status({ registered_at: registeredAt }), registeredAt)).toBe(true);
    });

    it("is true just inside the window", () => {
        const now = registeredAt + FIRST_SYNC_WINDOW_MS - 1;
        expect(isAwaitingFirstSync(status({ registered_at: registeredAt }), now)).toBe(true);
    });

    it("is false exactly AT the window edge — the boundary is exclusive", () => {
        // Pinned deliberately: the implementation is `<`, not `<=`. A member at
        // the boundary should see "—" rather than a "Syncing…" that never ends.
        const now = registeredAt + FIRST_SYNC_WINDOW_MS;
        expect(isAwaitingFirstSync(status({ registered_at: registeredAt }), now)).toBe(false);
    });

    it("is false well past the window", () => {
        const now = registeredAt + FIRST_SYNC_WINDOW_MS * 10;
        expect(isAwaitingFirstSync(status({ registered_at: registeredAt }), now)).toBe(false);
    });

    it("is false without a registered wallet, however fresh the timestamp", () => {
        // An unregistered member is not awaiting a first sync, they are awaiting
        // registration — so this must not depend on the timestamp alone.
        expect(isAwaitingFirstSync(null, registeredAt)).toBe(false);
        expect(
            isAwaitingFirstSync(
                { wallet_address: null, registered_at: registeredAt, is_active: false },
                registeredAt,
            ),
        ).toBe(false);
    });

    it("is false when the wallet is inactive even inside the window", () => {
        expect(isAwaitingFirstSync(status({ is_active: false }), registeredAt)).toBe(false);
    });

    it("is false when registered_at is missing or zero", () => {
        // `registered_at: 0` must not read as "registered at the epoch, so
        // ancient" NOR as "just now" — the falsy guard rejects it outright.
        expect(isAwaitingFirstSync(status({ registered_at: null }), registeredAt)).toBe(false);
        expect(isAwaitingFirstSync(status({ registered_at: 0 }), registeredAt)).toBe(false);
    });

    it("is false for a future registered_at — a lagging browser clock must not pin 'Syncing…'", () => {
        // This WAS a documented gap ("DOCUMENTS a gap: a future registered_at
        // reads as awaiting sync"), closed 2026-08-07.
        //
        // The gap: `registered_at` is minted by Date.now() on the API host
        // (app/api/src/stablecoin/handlers.ts:231) and returned unmodified, while
        // `now` defaults to the BROWSER's clock — so the subtraction crosses two
        // machines. A browser running behind the node made `now - registeredAt`
        // negative, and a negative number is < the window, so this returned true
        // and the balance cell pinned on "Syncing…" for skew + 5 minutes.
        //
        // Not merely cosmetic, which is why it was worth closing: an absent
        // balance also means a stalled sync loop or an unreachable BASE RPC, and
        // a false "Syncing…" read as reassurance over a real outage.
        //
        // Fixed by clamping elapsed at zero, which is what this rail already does
        // in app/api/src/stablecoin/staleness.ts:44-46 and in
        // app/web/src/components/freshness.ts:54.
        const now = registeredAt - 60_000;
        expect(isAwaitingFirstSync(status({ registered_at: registeredAt }), now)).toBe(false);
    });

    it("DOCUMENTS a gap: a browser clock running AHEAD expires the window early", () => {
        // The OTHER skew direction, and the one the 2026-08-07 fix does NOT
        // close. Asserting the ACTUAL behaviour, not the desired one — same
        // convention as the browser-behind test above carried while ITS gap was
        // open. The prefix retires when the gap closes, not before.
        //
        // Direction: the browser's clock is AHEAD of the API host's. `now -
        // registered_at` is then inflated by the skew, so the 5-minute window
        // reads as already elapsed while the sync loop is genuinely still
        // working. The member sees "—" instead of "Syncing…" during a real first
        // sync — the inverse of the browser-behind symptom, and the milder one
        // (an unhelpful placeholder, not a false reassurance over an outage).
        //
        // Why `elapsed >= 0` cannot address it: the clamp only rejects NEGATIVE
        // elapsed. Here elapsed is positive and too large, so the guard never
        // engages. This test therefore passes identically with and without the
        // fix — deliberately, since it pins a defect the fix does not touch.
        //
        // The skew-immune fix, out of scope here: have the API return a
        // server-computed `registered_seconds_ago` alongside `registered_at`, the
        // way handleBalance already returns `staleness_seconds` (computed at
        // app/api/src/stablecoin/handlers.ts:290 via railStalenessSeconds, where
        // both operands are the API host's clock). The predicate would then
        // compare a server-measured elapsed against the window and be same-clock
        // on both operands, closing BOTH directions at once. That touches
        // stablecoin/types.ts, handlers.ts, the web client.ts response type, and
        // this predicate's signature — a wider change than a guard, and someone's
        // decision rather than a bug fix. This test is what keeps it findable.
        const REAL_ELAPSED_MS = 60_000; // one minute has genuinely passed
        const BROWSER_AHEAD_MS = 10 * 60_000; // browser clock runs ten minutes fast
        const now = registeredAt + REAL_ELAPSED_MS + BROWSER_AHEAD_MS;
        expect(isAwaitingFirstSync(status({ registered_at: registeredAt }), now)).toBe(false);
    });
});
