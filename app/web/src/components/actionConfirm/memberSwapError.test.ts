// Ruling a (loop-fee-ceilings): for the swap refusal codes, member-facing pages
// show only the detail text — never the raw code. apiFetch (api/client.ts)
// builds every error's message as "<code>: <detail>"; this pins what the
// member pages render from such an error instead.
//
// The errors are produced by the REAL apiFetch against a stubbed fetch that
// answers as the API does (409 { error, detail }), so the error shape under
// test is the one the pages receive.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { api } from "../../api/client";
import * as confirmErrors from "./confirmErrors";

// The pages rendered `e.message` before this ruling; a missing helper falls
// back to that, so the pre-fix behaviour is what fails here.
const render = (e: unknown, fallback = "Failed"): string =>
  ((confirmErrors as any).memberSwapErrorText ?? ((x: any) => x?.message ?? fallback))(e, fallback);

const REFUSALS: Array<[code: string, detail: string]> = [
  ["requote_required", "This quote was made before an update and can't be used. Get a new quote."],
  ["ceiling_mismatch", "The fee limits sent don't match this quote. Get a new quote."],
  ["miner_fee_unknown", "The network fee for this refill couldn't be estimated right now. Try again in a few minutes."],
  ["fee_rate_over_quote", "Network fees have gone up since this quote. Get a new quote."],
  ["route_not_found", "No payment route to the swap service was found. Try again later."],
  ["route_fee_over_cap", "Routing this payment would cost more than the allowed routing fee. Try again later."],
  ["swap_in_progress", "This swap is already being started. Check its status before trying again."],
  ["swap_not_executable", "This quote has already been used or has ended. Get a new quote."],
  ["quote_expired", "This quote has expired. Get a new quote."],
];

function answer(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, statusText: "x", json: async () => body }) as unknown as Response));
}

async function errorFrom(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(() => { throw new Error("expected a rejection"); }, (e) => e);
}

afterEach(() => vi.unstubAllGlobals());

const CEILINGS = { max_swap_fee_sat: 1, max_prepay_amt_sat: 1, max_miner_fee_sat: 1, max_swap_routing_fee_sat: 1, max_prepay_routing_fee_sat: 1 };

describe("member pages render a swap refusal's detail, not its code", () => {
  for (const [code, detail] of REFUSALS) {
    it(`Withdraw execute: ${code}`, async () => {
      answer(409, { error: code, detail });
      const e = await errorFrom(() =>
        api.initiateSwapLoopOut({ swap_request_id: "r", destination_address: "bc1q", ...CEILINGS }),
      );
      const shown = render(e);
      expect(shown).toContain(detail);
      expect(shown).not.toContain(code);
    });

    it(`Refill quote: ${code}`, async () => {
      answer(409, { error: code, detail });
      const shown = render(await errorFrom(() => api.getSwapLoopInQuote({ amount_sat: 250_000 })));
      expect(shown).toContain(detail);
      expect(shown).not.toContain(code);
    });
  }

  it("other errors keep their message (nothing else changes)", async () => {
    answer(503, { error: "loop_unavailable", detail: "connection refused" });
    const e = await errorFrom(() => api.getSwapLoopInQuote({ amount_sat: 250_000 }));
    expect(render(e)).toBe("loop_unavailable: connection refused");
  });
});

describe("the two member pages render swap errors through the helper", () => {
  // A source guard: the helper only protects a page that uses it.
  const pages = ["../../pages/WithdrawBitcoin.tsx", "../../pages/RefillChannel.tsx"];
  for (const p of pages) {
    it(`${path.basename(p)} never puts a raw swap error message on screen`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, p), "utf8");
      expect(src).toContain("memberSwapErrorText(");
      expect(src).not.toMatch(/setError\(e\.message/);
      expect(src).not.toMatch(/setError\(msg\b/);
    });
  }
});
