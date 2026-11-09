// pay-from-node's confirmation entry (2026-11-05 D1): the echo and the two
// acknowledgements are hashed, so a confirmation computed for one body does
// not authorise a body that adds an acknowledgement or moves the echo.

import { describe, expect, it } from "vitest";
import { deriveConfirmation, findConfirmedRoute, verifyConfirmation } from "./action-confirmation";

const URL = "/api/subscription/pay-from-node";
const ECHO = { amount_sats: 50_000, deposit_address: "bcrt1qdeposit" };

function confirmationFor(body: Record<string, unknown>): string {
  const route = findConfirmedRoute("POST", URL);
  if (!route) throw new Error("pay-from-node is not a confirmed route");
  const d = deriveConfirmation(route, { url: URL, body });
  if (!d.ok) throw new Error(`derive failed: ${d.reason}`);
  return d.value;
}
function verify(body: Record<string, unknown>, header: string) {
  return verifyConfirmation(findConfirmedRoute("POST", URL)!, { url: URL, body }, header);
}

describe("C6c — the acknowledgements are bound by the hash", () => {
  it("a confirmation for the bare echo does not authorise price_acknowledged: true", () => {
    expect(verify({ ...ECHO, price_acknowledged: true }, confirmationFor(ECHO))).toMatchObject({
      ok: false,
      error: "confirmation_mismatch",
    });
  });

  it("a confirmation for the bare echo does not authorise repeat_acknowledged: true", () => {
    expect(verify({ ...ECHO, repeat_acknowledged: true }, confirmationFor(ECHO))).toMatchObject({
      ok: false,
      error: "confirmation_mismatch",
    });
  });

  it("the echo is bound: a confirmation for one amount does not authorise another", () => {
    expect(verify({ ...ECHO, amount_sats: 1 }, confirmationFor(ECHO))).toMatchObject({
      ok: false,
      error: "confirmation_mismatch",
    });
  });

  it("permitting control: the body it was computed for verifies", () => {
    const body = { ...ECHO, repeat_acknowledged: true, price_acknowledged: true };
    expect(verify(body, confirmationFor(body))).toEqual({ ok: true });
  });

  it("a bodiless request is refused 400 confirmation_required", () => {
    const r = verifyConfirmation(findConfirmedRoute("POST", URL)!, { url: URL, body: null }, undefined);
    expect(r).toMatchObject({ ok: false, status: 400, error: "confirmation_required" });
  });
});
