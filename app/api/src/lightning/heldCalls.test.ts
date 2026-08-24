// CONTROL 4 — the six outcome-ambiguous calls must NOT acquire a deadline.
//
// ─── WHY THIS CONTROL EXISTS ────────────────────────────────────────────────
//
// The tempting way to bound LND calls is one wrapper at the client layer, so
// every call is covered and nothing can be forgotten. That shape would sweep
// the six held calls in SILENTLY — the diff would look like an improvement and
// the regression would be invisible until a member's on-chain send timed out
// with the transaction already broadcast. This test is the thing that fails if
// anyone does that, deliberately or by refactor.
//
// ─── WHY IT IS STRUCTURAL RATHER THAN BEHAVIOURAL ───────────────────────────
//
// The property is "this call does not acquire a deadline", which is an absence.
// A behavioural test for an absence is a negative over unbounded time: you can
// only ever show it did not time out YET. Reading the source shows the absence
// directly and in constant time.
//
// ⚠ THE GUARD AGAINST A VACUOUS PASS. A test that only asserts "withDeadline
// does not appear in function X" passes trivially if X is renamed, moved, or
// deleted — the exact refactors most likely to introduce the bug. So each case
// ALSO asserts the body still contains the ln-service call it is supposed to be
// protecting. If the function stops looking like itself, this goes red loudly
// rather than green quietly.

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { HELD_UNBOUNDED_CALLS } from "./callDeadline";

const LND_TS = path.join(__dirname, "lnd.ts");
const PAY_TS = path.join(__dirname, "pay.ts");

/**
 * Extract one function body by name, by brace matching from its declaration.
 * Returns null when the function is not found — which every case treats as a
 * failure rather than a pass.
 *
 * ⚠ THE RETURN-TYPE TRAP, FOUND BY THIS FILE'S OWN ANTI-VACUOUS GUARD. The
 * first version took `indexOf("{", indexOf(")"))` as the body. Three of the six
 * held functions declare an object return type —
 * `): Promise<{ id: string; tokens: number; … }>` — so that found the brace of
 * the TYPE and "body" came back as the type literal. Every such case then
 * failed the contains-check rather than passing vacuously, which is the only
 * reason it was noticed. Hence: after the parameter list, walk forward and take
 * the first `{` seen at angle-bracket depth zero.
 */
function functionBody(source: string, name: string): string | null {
  const decl = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(`,
  );
  const m = decl.exec(source);
  if (!m) return null;

  // Close the parameter list by paren matching (defaults may contain parens).
  const parenOpen = source.indexOf("(", m.index + m[0].length - 1);
  let parens = 0;
  let afterParams = -1;
  for (let i = parenOpen; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")") {
      parens--;
      if (parens === 0) {
        afterParams = i + 1;
        break;
      }
    }
  }
  if (afterParams < 0) return null;

  // Skip any return-type annotation: the body brace is the first `{` at
  // angle-depth 0.
  let angle = 0;
  let open = -1;
  for (let i = afterParams; i < source.length; i++) {
    if (source[i] === "=" && source[i + 1] === ">") {
      i++; // an arrow inside a type, not a closing angle bracket
      continue;
    }
    if (source[i] === "<") angle++;
    else if (source[i] === ">") angle--;
    else if (source[i] === "{" && angle === 0) {
      open = i;
      break;
    }
  }
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/** wrapper name -> [file, the ln-service call its body must still contain] */
const HELD_SITES: ReadonlyArray<[string, string, string]> = [
  ["sendLndToChainAddress", LND_TS, "sendToChainAddress"],
  ["openTreasuryChannel", LND_TS, "openChannel"],
  ["closeTreasuryChannel", LND_TS, "closeChannel"],
  ["payLndViaRoutes", LND_TS, "payViaRoutes"],
  ["keysendPush", LND_TS, "payViaPaymentDetails"],
  ["payInvoice", PAY_TS, "payViaPaymentRequest"],
];

describe("the six outcome-ambiguous calls carry no deadline", () => {
  for (const [fn, file, lnServiceCall] of HELD_SITES) {
    it(`${fn} does not wrap ${lnServiceCall} in a deadline`, () => {
      const body = functionBody(fs.readFileSync(file, "utf8"), fn);

      // Anti-vacuous-pass: the function must exist and must still be the thing
      // this case is about.
      expect(body, `${fn} not found in ${path.basename(file)}`).not.toBeNull();
      expect(
        body,
        `${fn} no longer calls ${lnServiceCall} — this control may be guarding nothing`,
      ).toContain(`${lnServiceCall}(`);

      expect(
        body,
        `${fn} has acquired a deadline. It is HELD deliberately: a deadline ` +
          `cannot cancel the call, so timing out a call that commits funds ` +
          `leaves the outcome unknown. See HELD_UNBOUNDED_CALLS in callDeadline.ts.`,
      ).not.toContain("withDeadline");
    });
  }

  it("every name in HELD_UNBOUNDED_CALLS is covered by a case here", () => {
    // Keeps the declared contract and the enforced contract from drifting: add
    // a name to the list without a case and this fails.
    const covered = new Set(HELD_SITES.flatMap(([fn, , call]) => [fn, call]));
    for (const held of HELD_UNBOUNDED_CALLS) {
      expect(covered.has(held), `${held} is declared held but nothing enforces it`).toBe(
        true,
      );
    }
  });

  it("pay.ts imports no deadline helper at all", () => {
    // pay.ts's only LND call is held, so the module has no business importing
    // the wrapper. Catches the drive-by "while I was in there" edit.
    //
    // ⚠ MATCHES THE IMPORT, NOT THE WORD. The first version asserted the source
    // did not contain "callDeadline" anywhere, and immediately failed when the
    // held-call comment was added — a comment POINTING AT callDeadline.ts is the
    // thing we want, and an assertion that forbids naming the module forbids
    // documenting the decision. Assert the import and the call instead.
    const src = fs.readFileSync(PAY_TS, "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*callDeadline["']/);
    expect(src).not.toContain("withDeadline(");
  });
});
