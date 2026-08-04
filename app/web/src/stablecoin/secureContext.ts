// Wallet-picker availability, gated on whether the page is a secure context.
//
// WHY THIS EXISTS. The Coinbase Wallet SDK cannot connect from a plain-HTTP
// non-localhost origin: it calls crypto.subtle and crypto.randomUUID unguarded
// from the dapp origin, both of which are undefined outside a secure context.
// It has no secure-context check of its own, so it throws
// `TypeError: crypto.randomUUID is not a function` — and the picker's error
// handler surfaces raw `e.message`, which is how that string reached a farmer.
// Measured 2026-08-04; full evidence at the top of wagmi.ts.
//
// Umbrel serves this app over plain HTTP on a LAN host, so on a stock member node
// the recommended wallet is the one that cannot work. This module makes the picker
// tell the truth about that.
//
// GATED ON THE RUNTIME CONDITION, NOT A BUILD FLAG, deliberately: the day the
// member UI is reachable over https the Coinbase tile comes back with no code
// change and no redeploy decision. Nothing here needs updating at that point.
//
// Pure + dependency-free so both branches unit-test without a DOM and without
// importing wagmi.ts (which would evaluate createConfig and all three connectors
// at module scope). Same pattern as railAccess.ts / submitGuard.ts: the component
// stays a thin renderer.

export interface TileState {
    /** False renders the tile disabled — never hidden. See note below. */
    enabled: boolean;
    /** Carries the visual badge. Exactly one tile has it. */
    recommended: boolean;
    /** Undefined = render no caption at all. */
    caption?: string;
}

export interface WalletPickerAvailability {
    coinbase: TileState;
    metamask: TileState;
}

/**
 * Which wallet tiles work, and which one to recommend.
 *
 * ⚠ THE COINBASE TILE IS DISABLED, NEVER HIDDEN — unlike the WalletConnect tile,
 * which is hidden when unconfigured. The distinction is deliberate: WalletConnect
 * is a decision not to pursue, so advertising it invites a request nobody will
 * fill. This is a temporary environmental limitation that resolves the moment the
 * node is reachable over https, and a farmer who has been told about Coinbase
 * should see WHY it is unavailable rather than find it silently absent.
 *
 * Copy notes, since they were argued over and the reasons are not obvious:
 *   - The disabled reason names `https://` even though it is technically jargon.
 *     "No jargon" and "actionable" collide here, because a secure address is the
 *     ONLY thing that changes the outcome. `https://` is a string farmers see in
 *     every browser bar, and a message with no actionable content is worse.
 *   - It does NOT say "ask your node operator". On a member node the farmer IS
 *     the operator, so that phrasing routes them back to themselves.
 *   - MetaMask leads with what works, not with what it needs, so that taking the
 *     recommendation does not read as a downgrade.
 *   - The two tiles divide the labor: Coinbase says why it is out, MetaMask says
 *     it is in. Neither repeats the other.
 */
export function walletAvailability(isSecure: boolean): WalletPickerAvailability {
    if (isSecure) {
        return {
            coinbase: {
                enabled: true,
                recommended: true,
                caption:
                    "Create a new wallet with no seed phrase, or use one you already have — you'll choose next",
            },
            // No caption when it is not the recommendation — matches the picker's
            // pre-existing look, where only the recommended tile explains itself.
            metamask: { enabled: true, recommended: false },
        };
    }
    return {
        coinbase: {
            enabled: false,
            recommended: false,
            caption:
                "Not available over this connection — Coinbase needs a secure (https://) address for your node.",
        },
        metamask: {
            enabled: true,
            recommended: true,
            caption: "Works over this connection. Needs the MetaMask browser extension or mobile app.",
        },
    };
}

/**
 * Reads the live secure-context flag.
 *
 * ⚠ FAILS OPEN, AND MUST KEEP FAILING OPEN — do not "harden" this into returning
 * false when `window` is absent. The asymmetry is what decides it:
 *
 *   a wrong `false` DISABLES a wallet that would have worked — real harm;
 *   a wrong `true`  restores exactly today's behaviour, and the SDK still fails
 *                   safely on its own, because it throws before any popup opens.
 *
 * This is a UX gate — it stops an opaque TypeError reaching a farmer. It is NOT a
 * security boundary, and nothing downstream trusts it. Treating it as one and
 * flipping the default would trade a real regression for no gain.
 *
 * `window.isSecureContext` is a browser primitive available before any SDK loads,
 * which is why the gate can run this early.
 */
export function detectSecureContext(): boolean {
    return typeof window === "undefined" ? true : window.isSecureContext === true;
}
