import { describe, expect, it } from "vitest";
import { detectSecureContext, walletAvailability } from "./secureContext";

// The property under test: on a plain-HTTP member node the picker must not
// recommend the one wallet that cannot connect there. Coinbase's SDK throws
// `TypeError: crypto.randomUUID is not a function` outside a secure context
// (measured — see wagmi.ts), and the picker surfaces raw e.message, so before this
// gate a farmer clicking the RECOMMENDED tile got that string.
//
// Both branches are asserted rather than just the insecure one: a gate that
// disables Coinbase unconditionally would also pass a one-sided test, and would be
// a worse bug than the one being fixed.

describe("walletAvailability — insecure context (the stock member-node case)", () => {
    const a = walletAvailability(false);

    it("blocks Coinbase", () => {
        expect(a.coinbase.enabled).toBe(false);
    });

    it("moves the recommendation to MetaMask, the only working path", () => {
        expect(a.metamask.recommended).toBe(true);
        expect(a.coinbase.recommended).toBe(false);
    });

    it("explains why Coinbase is out, and names the thing that fixes it", () => {
        // `https://` is deliberate: it is the only actionable detail, and a
        // farmer sees that string in every browser bar. See the copy notes.
        expect(a.coinbase.caption).toMatch(/https:\/\//);
        expect(a.coinbase.caption).toMatch(/not available/i);
    });

    it("does not route the farmer to a node operator — on a member node that is them", () => {
        expect(a.coinbase.caption).not.toMatch(/operator/i);
    });

    it("keeps jargon out of the member-facing copy", () => {
        const all = `${a.coinbase.caption} ${a.metamask.caption}`;
        expect(all).not.toMatch(/secure context/i);
        expect(all).not.toMatch(/TypeError/);
        expect(all).not.toMatch(/crypto/i);
    });

    it("has MetaMask lead with what works, and state its one prerequisite", () => {
        expect(a.metamask.caption).toMatch(/^Works over this connection/);
        expect(a.metamask.caption).toMatch(/extension or mobile app/i);
        // Must not claim MetaMask is seedless — it is not.
        expect(a.metamask.caption).not.toMatch(/no seed phrase/i);
    });
});

describe("walletAvailability — secure context (https, or localhost in dev)", () => {
    const a = walletAvailability(true);

    it("leaves Coinbase enabled and recommended, exactly as before the gate", () => {
        expect(a.coinbase.enabled).toBe(true);
        expect(a.coinbase.recommended).toBe(true);
    });

    it("keeps the seedless framing, which is true of the Coinbase branch", () => {
        expect(a.coinbase.caption).toMatch(/no seed phrase/i);
    });

    it("gives MetaMask neither the badge nor a caption", () => {
        expect(a.metamask.recommended).toBe(false);
        expect(a.metamask.caption).toBeUndefined();
    });
});

describe("exactly one tile is recommended, in both contexts", () => {
    // A picker with two badges, or none, is a rendering bug either way.
    it.each([[true], [false]])("isSecure=%s", (isSecure) => {
        const a = walletAvailability(isSecure);
        const badges = [a.coinbase.recommended, a.metamask.recommended].filter(Boolean);
        expect(badges).toHaveLength(1);
    });
});

describe("detectSecureContext", () => {
    it("reads the live flag when window exists", () => {
        // jsdom serves about:blank, which is not a secure context; the assertion is
        // that the function REFLECTS window rather than hardcoding, so compare to
        // the same source of truth instead of a literal.
        expect(detectSecureContext()).toBe(window.isSecureContext === true);
    });

    it("FAILS OPEN, never closed — see the doc comment before changing this", () => {
        // A wrong `false` disables a working wallet; a wrong `true` merely restores
        // pre-gate behaviour and the SDK still fails safely. The asymmetry is the
        // whole argument, so it is pinned here.
        const saved = globalThis.window;
        try {
            // @ts-expect-error — deliberately simulating a non-browser global.
            delete globalThis.window;
            expect(detectSecureContext()).toBe(true);
        } finally {
            globalThis.window = saved;
        }
    });
});
