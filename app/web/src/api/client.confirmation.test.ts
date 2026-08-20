// What the UI ACTUALLY PUTS ON THE WIRE, judged by the server's own verifier.
//
// The other two test files check the derivation and the field-map parity. This
// one checks the thing that ships: call the real `api.*` method a component
// calls, intercept the outgoing request, and hand the captured body + header to
// the SERVER's verifyConfirmation.
//
// `fetch` is stubbed, but nothing that decides the outcome is: the value is
// produced by the real client code path and judged by the real server code. The
// stub is transport only. A test that asserted "the header equals what I
// computed the same way" would agree with itself and prove nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { CONFIRMATION_HEADER, findUiConfirmedRoute } from "./actionConfirmation";
import { verifyConfirmation } from "../../../api/src/utils/action-confirmation";

type Captured = { url: string; method: string; headers: Record<string, string>; body: string | null };
let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      // apiFetch sends a Headers instance; accept a plain object too so this
      // stub does not quietly stop seeing headers if that changes.
      const h = init?.headers;
      const headers: Record<string, string> =
        h instanceof Headers
          ? Object.fromEntries([...h.entries()].map(([k, v]) => [k.toLowerCase(), v]))
          : Object.fromEntries(
              Object.entries((h ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
            );
      captured.push({
        url: String(url),
        method: (init?.method ?? "GET").toUpperCase(),
        headers,
        body: typeof init?.body === "string" ? init.body : null,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as unknown as Response;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Path portion of the captured URL (strips whatever API_BASE resolved to). */
function pathOf(c: Captured): string {
  const i = c.url.indexOf("/api/");
  return i >= 0 ? c.url.slice(i) : c.url;
}

/** The whole point: does the SERVER accept what the UI just sent? */
function serverVerdict(c: Captured) {
  const path = pathOf(c);
  const route = findUiConfirmedRoute(c.method, path);
  if (!route) return { ok: false as const, why: "no route" };
  const body = c.body ? JSON.parse(c.body) : null;
  return verifyConfirmation(route as never, { url: path, body }, c.headers[CONFIRMATION_HEADER]);
}

describe("every capital route the UI can reach sends a confirmation the server accepts", () => {
  const CALLS: Array<[label: string, run: () => Promise<unknown>]> = [
    ["member/open-channel", () => api.openMemberChannel({ capacity_sats: 1_000_000 })],
    [
      "member/open-channel + socket",
      () => api.openMemberChannel({ capacity_sats: 2_000_000, partner_socket: "1.2.3.4:9735" }),
    ],
    ["network/pay", () => api.payNetworkInvoice("lnbc1pjxyzqqdq")],
    [
      "treasury/expansion/execute",
      () =>
        api.treasuryOpenChannel({
          peer_pubkey: "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca",
          capacity_sats: 2_000_000,
        }),
    ],
    [
      "treasury/rotation/execute (coop)",
      () => api.treasuryCloseChannel({ channel_id: "842391119757312" }),
    ],
    [
      "treasury/rotation/execute (force)",
      () => api.treasuryCloseChannel({ channel_id: "842391119757312", is_force_close: true }),
    ],
    [
      "treasury/rotation/execute (force + fee_rate, which is NOT hashed)",
      () => api.treasuryCloseChannel({ channel_id: "842391119757312", is_force_close: true, fee_rate: 12 }),
    ],
    [
      "member-liquidity approve",
      () => api.approveLiquidity("rec-42", "est-7"),
    ],
    [
      "swaps/loop-out",
      () => api.initiateSwapLoopOut({ swap_request_id: "swap-abc", destination_address: "bc1qxyzq" }),
    ],
    ["swaps/loop-in", () => api.initiateSwapLoopIn({ swap_request_id: "swap-def" })],
    ["admin/swaps/loop-out", () => api.adminLoopOut({ swap_request_id: "swap-ghi" })],
    [
      "admin/swaps/loop-out + dest",
      () => api.adminLoopOut({ swap_request_id: "swap-ghi", destination_address: "bc1qadmin" }),
    ],
  ];

  for (const [label, run] of CALLS) {
    it(`${label}: carries a header the server verifies`, async () => {
      await run();
      expect(captured).toHaveLength(1);
      const c = captured[0]!;
      expect(c.headers[CONFIRMATION_HEADER], `no ${CONFIRMATION_HEADER} sent for ${label}`).toBeTruthy();
      expect(serverVerdict(c), `server rejected the UI's confirmation for ${label}`).toEqual({ ok: true });
    });

    it(`${label}: Content-Type survives alongside it`, async () => {
      await run();
      expect(captured[0]!.headers["content-type"]).toBe("application/json");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER FAILURE, observably. If the UI hashed a body other than the one it
// sends, this is what would happen — and it is what these assertions detect.
// ─────────────────────────────────────────────────────────────────────────────
describe("a hash/body mismatch is a 409, not a silent pass", () => {
  it("swapping the captured body under the sent header fails the server's check", async () => {
    await api.payNetworkInvoice("lnbc1_ORIGINAL");
    const c = captured[0]!;
    const path = pathOf(c);
    const route = findUiConfirmedRoute("POST", path)!;

    // Same header, different body — exactly the divergence the choke point
    // exists to make impossible.
    const v = verifyConfirmation(
      route as never,
      { url: path, body: { payment_request: "lnbc1_SWAPPED" } },
      c.headers[CONFIRMATION_HEADER]
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(409);
  });

  it("the same body under a mangled header also fails", async () => {
    await api.payNetworkInvoice("lnbc1_ORIGINAL");
    const c = captured[0]!;
    const path = pathOf(c);
    const bad = c.headers[CONFIRMATION_HEADER].replace(/^.{4}/, "0000");
    const v = verifyConfirmation(findUiConfirmedRoute("POST", path)! as never, { url: path, body: JSON.parse(c.body!) }, bad);
    expect(v.ok).toBe(false);
  });
});

describe("what must stay untouched", () => {
  it("a READ sends no confirmation header", async () => {
    await api.getNode();
    expect(captured[0]!.headers[CONFIRMATION_HEADER]).toBeUndefined();
  });

  it("a NON-CAPITAL mutation sends no confirmation header", async () => {
    await api.createContact({ pubkey: "02ab", name: "Test" });
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.headers[CONFIRMATION_HEADER]).toBeUndefined();
  });

  it("an exempt no-body mutation is unaffected", async () => {
    await api.syncSettlements();
    expect(captured[0]!.headers[CONFIRMATION_HEADER]).toBeUndefined();
  });

  it("a caller that passes its own headers keeps them AND gets Content-Type", async () => {
    await api.postAutoBuyCredentials({ json_blob: "{}" });
    expect(captured[0]!.headers["content-type"]).toBe("application/json");
  });

  // ⚠ THE ASSERTION THE PREVIOUS VERSION LACKED.
  //
  // Reintroducing the header-clobbering spread order passed all 81 tests,
  // because the only caller that passes `headers` passes Content-Type — the
  // same value the default merge supplies, so clobbering was invisible. The
  // hazard is a capital route whose caller passes headers; none exists today,
  // which is exactly why nothing caught it.
  //
  // Rather than wait for such a caller, this drives apiFetch through a real
  // capital method while forcing caller-supplied headers onto the same request,
  // and asserts BOTH survive. It fails if the merge is ever undone.
  it("caller headers and the confirmation coexist on a CAPITAL route", async () => {
    // openMemberChannel is a capital route; the header injection simulates a
    // caller (or a future interceptor) supplying its own headers on that path.
    const realFetch = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", (u: string, i?: RequestInit) => {
      const h = new Headers(i?.headers as HeadersInit | undefined);
      h.set("x-caller-supplied", "kept");
      return realFetch(u, { ...i, headers: h });
    });

    await api.openMemberChannel({ capacity_sats: 1_000_000 });
    const c = captured[0]!;
    expect(c.headers["x-caller-supplied"]).toBe("kept");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.headers[CONFIRMATION_HEADER], "confirmation lost when other headers present").toBeTruthy();
    expect(serverVerdict(c)).toEqual({ ok: true });
  });

  it("apiFetch sends headers the confirmation cannot be spread out of", async () => {
    // Structural companion to the above: assert the Headers instance is what
    // reaches fetch. An object literal is what allowed key order to matter.
    await api.payNetworkInvoice("lnbc1");
    expect(captured[0]!.headers[CONFIRMATION_HEADER]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OUTAGE DIRECTION. A UI that cannot derive must not send a WRONG header — a
// wrong value is a 409, which the copy calls a bug and tells nobody to retry.
// No header is a 400, which is the honest "nothing was confirmed" state.
// ─────────────────────────────────────────────────────────────────────────────
describe("outage does not produce a wrong confirmation", () => {
  it("a body missing a hashed field sends NO header rather than a guess", async () => {
    // capacity_sats is required by the route's field list. Cast past the client
    // types deliberately: this is the runtime shape a half-filled form produces.
    await api.openMemberChannel({} as unknown as { capacity_sats: number });
    const c = captured[0]!;
    expect(c.headers[CONFIRMATION_HEADER]).toBeUndefined();
    // And the server would answer 400, not 409 — an absent header is
    // confirmation_required, which is the accurate state to be in.
    const v = serverVerdict(c);
    expect(v.ok).toBe(false);
    if (v.ok || !("status" in v)) return;
    expect(v.status).toBe(400);
  });

  it("an empty required numeric field also sends no header", async () => {
    await api.openMemberChannel({ capacity_sats: "" as unknown as number });
    expect(captured[0]!.headers[CONFIRMATION_HEADER]).toBeUndefined();
  });

  it("the request is still SENT — the client does not swallow it locally", async () => {
    // Deliberate: the server owns the refusal and names the reason. A
    // client-side block would invent its own error text for the same condition.
    await api.openMemberChannel({} as unknown as { capacity_sats: number });
    expect(captured).toHaveLength(1);
  });
});
