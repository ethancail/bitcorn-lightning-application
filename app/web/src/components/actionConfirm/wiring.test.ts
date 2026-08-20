// EVERY capital call site still has a confirmation step in front of it.
//
// An architectural invariant tested by scanning source, like
// stablecoin/siweCallSites.test.ts. The property is about the shape of the app —
// "no capital action is reachable without a confirmation" — so there is no
// function to call and assert on.
//
// ⚠ LIMITATION, STATED RATHER THAN IMPLIED. This proves each page that calls a
// capital API method ALSO uses the confirmation machinery. It does NOT prove the
// two are connected to each other: a page could import the modal, render it, and
// still wire a second button straight to the raw method. Nor does it check the
// modal is actually mounted in the returned JSX.
//
// What closes that gap is client.confirmation.test.ts, which drives the real
// api.* methods and asserts the server accepts what goes on the wire. This file
// catches the cruder regression that test cannot see: someone deleting the
// confirmation step from a page while leaving the request intact.
//
// If this fails, the question is not "how do I make it pass" but "can this
// action now move funds without the operator confirming it".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_CONFIRMED_ROUTES } from "../../api/actionConfirmation";

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * The capital call sites, as found by grepping for the client method at this
 * ref. Each entry is (file, client method, why it moves funds).
 */
const CALL_SITES: Array<{ file: string; method: string; route: string }> = [
  { file: "pages/MemberDashboard.tsx", method: "openMemberChannel", route: "/api/member/open-channel" },
  { file: "pages/RefillChannel.tsx", method: "initiateSwapLoopIn", route: "/api/swaps/loop-in" },
  { file: "pages/WithdrawBitcoin.tsx", method: "initiateSwapLoopOut", route: "/api/swaps/loop-out" },
  { file: "pages/Payments.tsx", method: "payNetworkInvoice", route: "/api/network/pay" },
  { file: "pages/MemberLiquidity.tsx", method: "approveLiquidity", route: "…/recommendations/{id}/approve" },
  { file: "App.tsx", method: "treasuryCloseChannel", route: "/api/treasury/rotation/execute" },
  { file: "App.tsx", method: "treasuryOpenChannel", route: "/api/treasury/expansion/execute" },
  { file: "pages/SwapOperations.tsx", method: "adminLoopOut", route: "/api/admin/swaps/loop-out" },
];

describe("every capital call site has a confirmation step", () => {
  for (const { file, method, route } of CALL_SITES) {
    it(`${file} (${method} → ${route}) still calls the method`, () => {
      // If this fails the call site MOVED, and the pairing below is checking a
      // file that no longer does anything — a silently vacuous test.
      expect(read(file)).toContain(`${method}(`);
    });

    it(`${file} imports the confirmation machinery`, () => {
      const src = read(file);
      const usesGate =
        src.includes("actionConfirm/ActionConfirmModal") ||
        src.includes("actionConfirm/confirmAction");
      expect(usesGate, `${file} calls ${method} with no confirmation import`).toBe(true);
    });

    it(`${file} distinguishes confirmation failures`, () => {
      // Without classifyConfirmError the page renders a 409 as a generic error,
      // which is the "looks like tampering" outcome this arc exists to avoid.
      expect(read(file)).toContain("classifyConfirmError");
    });

    it(`${file} gates on a typed challenge`, () => {
      const src = read(file);
      // Either the shared modal (which owns the challenge) or the inline
      // challengeSatisfied gate used where a richer bespoke dialog already
      // existed (SwapOperations, App.tsx close).
      const gated = src.includes("ActionConfirmModal") || src.includes("challengeSatisfied");
      expect(gated, `${file} has no typed challenge`).toBe(true);
    });
  }

  it("covers every UI-reachable confirmed route", () => {
    // Ties the list above to the field map: a route added to
    // UI_CONFIRMED_ROUTES with no call site here would slip through.
    expect(CALL_SITES.length).toBe(UI_CONFIRMED_ROUTES.length);
  });

  it("the scan can actually fail (control for the control)", () => {
    // A read that silently returned "" would make every toContain above pass
    // vacuously in the negative direction — assert the files are non-trivial.
    for (const { file } of CALL_SITES) {
      expect(read(file).length, file).toBeGreaterThan(500);
    }
    // And a phrase that is definitely absent must NOT be found.
    expect(read("App.tsx")).not.toContain("__definitely_not_in_this_file__");
  });
});

describe("window.confirm is not used for anything that moves funds", () => {
  it("no capital call site falls back to window.confirm", () => {
    // The three remaining confirm() sites (StrategyTab, CoinbaseCard, DayForm)
    // guard config changes and a row delete. None is an outflow, and none is in
    // this list — but a capital page reaching for confirm() would be a
    // regression to the weak form this arc replaced.
    for (const { file } of CALL_SITES) {
      const src = read(file);
      expect(/\bwindow\.confirm\s*\(/.test(src), `${file} uses window.confirm`).toBe(false);
    }
  });
});
