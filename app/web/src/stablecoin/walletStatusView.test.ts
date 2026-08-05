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

    it("DOCUMENTS a gap: a future registered_at reads as awaiting sync", () => {
        // Clock skew between the API host and the browser makes `now -
        // registeredAt` negative, which is < the window, so this returns true.
        // Asserting the ACTUAL behaviour rather than the desired one, and saying
        // so in the name — a test titled "is false for a future timestamp" that
        // asserted true would be worse than no test.
        //
        // Left as-is rather than fixed: the visible consequence is a "Syncing…"
        // label that persists until the clocks converge, on a surface that
        // already tolerates a stale balance, and the fix (clamping elapsed at 0)
        // belongs with whoever decides how much clock skew this app tolerates
        // generally. Out of scope for a component move.
        const now = registeredAt - 60_000;
        expect(isAwaitingFirstSync(status({ registered_at: registeredAt }), now)).toBe(true);
    });
});
