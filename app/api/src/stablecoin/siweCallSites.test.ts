import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// AN ARCHITECTURAL INVARIANT, TESTED BY SCANNING SOURCE. That is unusual, and
// deliberate: the property is about the SHAPE of the codebase, not the behaviour
// of a function, so there is nothing to call and assert on.
//
// WHAT IT PROTECTS. SIWE verification falls back to Base's PUBLIC RPC when
// BASE_RPC_URL is unset (siwe.ts, siweRpcUrl) — which is what makes smart-wallet
// registration work on a stock member node, where the operator cannot be asked to
// set a keyed endpoint. That trade is only sound because verification runs ONCE
// PER MEMBER, EVER: at wallet registration. A public endpoint's rate limits are
// irrelevant at that volume and would matter immediately on a hot path.
//
// So a second call site is not a style problem — it can silently move a
// rate-limited third-party endpoint onto a per-settlement path. If this test
// fails, the question to answer is not "how do I make it pass" but "does the
// public-RPC fallback still hold, and does BASE_RPC_URL now need to be required?"
//
// ⚠ LIMITATION, STATED RATHER THAN IMPLIED. This catches a DIRECT second call
// site. It does NOT catch indirection: wrap verifySiwe in a helper and call the
// helper from the settlement path and this test stays green. Asserting the
// containing function (below) narrows that gap but does not close it. An honest
// partial guard is worth more than an airtight-looking one that isn't — do not
// read a pass here as proof the invariant holds under all refactors.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(__dirname, "..");

function walkTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            walkTsFiles(full, out);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
            out.push(full);
        }
    }
    return out;
}

/** Files that reference `verifySiwe(` as a CALL, excluding its own definition. */
function findCallSites(): Array<{ file: string; line: number; text: string }> {
    const hits: Array<{ file: string; line: number; text: string }> = [];
    for (const file of walkTsFiles(SRC)) {
        const rel = file.slice(SRC.length + 1);
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((text, i) => {
            if (!/\bverifySiwe\s*\(/.test(text)) return;
            // Skip the declaration in siwe.ts itself.
            if (/export\s+async\s+function\s+verifySiwe\s*\(/.test(text)) return;
            hits.push({ file: rel, line: i + 1, text: text.trim() });
        });
    }
    return hits;
}

describe("verifySiwe call-site invariant (public-RPC fallback depends on it)", () => {
    it("has exactly ONE call site", () => {
        const hits = findCallSites();
        expect(
            hits.map((h) => `${h.file}:${h.line}`),
            `verifySiwe call sites found:\n${hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join("\n")}`,
        ).toHaveLength(1);
    });

    it("and it is in the wallet-REGISTRATION handler, not a settlement path", () => {
        const hits = findCallSites();
        expect(hits[0]?.file).toBe("stablecoin/handlers.ts");

        // Confirm the enclosing function is the registration handler: scan upward
        // from the call for the nearest `export async function`. This is what makes
        // the test about "registration only" rather than merely "one call".
        const source = readFileSync(join(SRC, hits[0]!.file), "utf8").split("\n");
        let enclosing = "(none found)";
        for (let i = hits[0]!.line - 1; i >= 0; i--) {
            const m = source[i]?.match(/^export async function (\w+)/);
            if (m) {
                enclosing = m[1];
                break;
            }
        }
        expect(enclosing).toBe("handleWalletRegister");
    });
});
