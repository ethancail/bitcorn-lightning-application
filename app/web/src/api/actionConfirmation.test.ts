import { afterEach, describe, expect, it } from "vitest";
import { confirmationFor, findUiConfirmedRoute } from "./actionConfirmation";
// The SERVER's verifier, imported across the workspace. It is pure (node crypto
// only, no DB), so it runs here — and that makes these cross-IMPLEMENTATION
// checks: viem's sha256 on one side, node's crypto on the other. A mock would
// agree with itself; this cannot.
import {
  CONFIRMED_ROUTES,
  verifyConfirmation,
  type ConfirmedRoute as ServerRoute,
} from "../../../api/src/utils/action-confirmation";

const route = (method: string, url: string) => {
  const r = findUiConfirmedRoute(method, url);
  if (!r) throw new Error(`no UI route for ${method} ${url}`);
  return r;
};

/**
 * The SERVER's route entry for a URL — deliberately NOT the client's.
 *
 * An earlier version of this file handed the CLIENT's route object to
 * verifyConfirmation, which meant both sides walked the same field list: the
 * digest was cross-checked but the field map was not, and a client/server field
 * drift passed here. Resolving the server's own entry is what makes these tests
 * cross-implementation on BOTH axes.
 */
const serverRoute = (method: string, url: string): ServerRoute => {
  const match = (m: ServerRoute["match"]) =>
    m.kind === "exact"
      ? url === m.url
      : m.kind === "prefix"
        ? url.startsWith(m.url)
        : url.startsWith(m.prefix) && url.endsWith(m.suffix);
  const r = CONFIRMED_ROUTES.find((x) => x.method === method && match(x.match));
  if (!r) throw new Error(`no SERVER route for ${method} ${url}`);
  return r;
};

/** Derive the way apiFetch does: from the serialized body string. */
const derive = (url: string, body: unknown) =>
  confirmationFor(route("POST", url), url, body === undefined ? null : JSON.stringify(body));

describe("the client hashes the SERIALIZED body it is about to send", () => {
  it("takes a string, not an object — there is no second source of truth", () => {
    const url = "/api/network/pay";
    const serialized = JSON.stringify({ payment_request: "lnbc1pjxyzqqdq" });
    const d = confirmationFor(route("POST", url), url, serialized);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.canonical).toBe("payment_request=lnbc1pjxyzqqdq");
  });

  it("hashes what is IN the string, not what a caller might have meant", () => {
    // Two objects that serialize differently must hash differently, even when a
    // human would call them the same request.
    const url = "/api/network/pay";
    const a = confirmationFor(route("POST", url), url, '{"payment_request":"lnbc1"}');
    const b = confirmationFor(route("POST", url), url, '{"payment_request":"lnbc1 "}');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
  });

  it("extra body fields the route does not declare do not change the value", () => {
    const url = "/api/network/pay";
    const bare = confirmationFor(route("POST", url), url, '{"payment_request":"lnbc1"}');
    const extra = confirmationFor(route("POST", url), url, '{"payment_request":"lnbc1","ui_note":"x"}');
    expect(bare.ok && extra.ok).toBe(true);
    if (!bare.ok || !extra.ok) return;
    expect(bare.value).toBe(extra.value);
  });

  it("a malformed body is reported, not hashed into something plausible", () => {
    const url = "/api/network/pay";
    expect(confirmationFor(route("POST", url), url, "{not json")).toEqual({
      ok: false,
      reason: "body_not_json",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AGREEMENT WITH THE SERVER, per route. Each case asserts the server's own
// verifier ACCEPTS the client-derived value for the same body.
// ─────────────────────────────────────────────────────────────────────────────
describe("the server accepts what the client computes", () => {
  const CASES: Array<[label: string, url: string, body: Record<string, unknown>]> = [
    ["network/pay", "/api/network/pay", { payment_request: "lnbc1pjxyzqqdq" }],
    ["member/open-channel", "/api/member/open-channel", { capacity_sats: 1_000_000 }],
    [
      "member/open-channel + socket",
      "/api/member/open-channel",
      { capacity_sats: 1_000_000, partner_socket: "1.2.3.4:9735" },
    ],
    [
      "expansion/execute",
      "/api/treasury/expansion/execute",
      { peer_pubkey: "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca", capacity_sats: 2_000_000 },
    ],
    ["rotation, coop close", "/api/treasury/rotation/execute", { channel_id: "842391119757312" }],
    [
      "rotation, force close",
      "/api/treasury/rotation/execute",
      { channel_id: "842391119757312", is_force_close: true },
    ],
    [
      "rotation, dry run",
      "/api/treasury/rotation/execute",
      { channel_id: "842391119757312", dry_run: true },
    ],
    [
      "swaps/loop-out",
      "/api/swaps/loop-out",
      { swap_request_id: "swap-abc", destination_address: "bc1qxyzq" },
    ],
    ["swaps/loop-in", "/api/swaps/loop-in", { swap_request_id: "swap-def" }],
    ["admin/swaps/loop-out", "/api/admin/swaps/loop-out", { swap_request_id: "swap-ghi" }],
    [
      "admin/swaps/loop-out + dest",
      "/api/admin/swaps/loop-out",
      { swap_request_id: "swap-ghi", destination_address: "bc1qadmin" },
    ],
  ];

  for (const [label, url, body] of CASES) {
    it(`${label}: server verifier accepts the client value`, () => {
      const d = derive(url, body);
      expect(d.ok, `client could not derive: ${JSON.stringify(d)}`).toBe(true);
      if (!d.ok) return;
      expect(verifyConfirmation(serverRoute("POST", url), { url, body }, d.value)).toEqual({ ok: true });
    });

    it(`${label}: and REJECTS it once the body changes`, () => {
      const d = derive(url, body);
      if (!d.ok) return;
      const firstKey = Object.keys(body)[0];
      const tampered = { ...body };
      const orig = tampered[firstKey];
      tampered[firstKey] = typeof orig === "number" ? orig + 1 : typeof orig === "boolean" ? !orig : `${orig}X`;
      const v = verifyConfirmation(serverRoute("POST", url), { url, body: tampered }, d.value);
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.status).toBe(409);
    });
  }

  it("the Shape-2 path field is read from the URL, and the server agrees", () => {
    const url = "/api/member-liquidity/recommendations/rec-42/approve";
    const body = { estimateId: "est-7" };
    const d = derive(url, body);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.canonical).toBe("recommendation_id=rec-42");
    expect(verifyConfirmation(serverRoute("POST", url), { url, body }, d.value)).toEqual({ ok: true });
  });

  it("a different recommendation id is a different confirmation", () => {
    const a = derive("/api/member-liquidity/recommendations/rec-42/approve", {});
    const b = derive("/api/member-liquidity/recommendations/rec-99/approve", {});
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL FIELDS, the case that motivated putting this at one choke point.
// ─────────────────────────────────────────────────────────────────────────────
describe("optional fields: absent and present-false are different requests", () => {
  const url = "/api/treasury/rotation/execute";

  it("is_force_close ABSENT vs PRESENT-false produce DIFFERENT values", () => {
    const absent = derive(url, { channel_id: "1" });
    const present = derive(url, { channel_id: "1", is_force_close: false });
    expect(absent.ok && present.ok).toBe(true);
    if (!absent.ok || !present.ok) return;
    expect(absent.canonical).toBe("channel_id=1");
    expect(present.canonical).toBe("channel_id=1&is_force_close=false");
    expect(absent.value).not.toBe(present.value);
  });

  it("and BOTH are accepted when they match what was sent", () => {
    // The half that matters for the UI: neither form is "wrong". A form that
    // always emits is_force_close: false is fine — as long as it hashes that.
    for (const body of [{ channel_id: "1" }, { channel_id: "1", is_force_close: false }]) {
      const d = derive(url, body);
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect(verifyConfirmation(serverRoute("POST", url), { url, body }, d.value)).toEqual({ ok: true });
    }
  });

  it("but the absent-form value is REFUSED for the present-false body", () => {
    const absent = derive(url, { channel_id: "1" });
    if (!absent.ok) return;
    const v = verifyConfirmation(
      serverRoute("POST", url),
      { url, body: { channel_id: "1", is_force_close: false } },
      absent.value
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(409);
  });

  it("optional partner_socket: absent, empty and set are three distinct values", () => {
    const u = "/api/member/open-channel";
    const vals = [
      { capacity_sats: 1_000_000 },
      { capacity_sats: 1_000_000, partner_socket: "" },
      { capacity_sats: 1_000_000, partner_socket: "1.2.3.4:9735" },
    ].map((b) => {
      const d = derive(u, b);
      return d.ok ? d.value : "refused";
    });
    expect(new Set(vals).size).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THE MEASURED FAILURE, MADE UNREINTRODUCIBLE.
//
// crypto.subtle is undefined outside a secure context, and the operator reaches
// this dashboard over plain HTTP on a tailnet IP. Measured in Chrome 2026-08-20:
// isSecureContext false, crypto.subtle absent, crypto.getRandomValues present.
//
// These tests delete crypto.subtle and assert the digest is still correct. Any
// future change that reaches for the native API — as an "optimization", or by
// copying a snippet — fails here rather than on a farmer's machine.
// ─────────────────────────────────────────────────────────────────────────────
describe("works with crypto.subtle DELETED (the tailnet case)", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis.crypto ?? {}, "subtle");

  afterEach(() => {
    if (saved && globalThis.crypto) Object.defineProperty(globalThis.crypto, "subtle", saved);
  });

  function deleteSubtle() {
    Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
  }

  it("crypto.subtle really is gone inside these tests (control for the control)", () => {
    deleteSubtle();
    expect((globalThis.crypto as { subtle?: unknown }).subtle).toBeUndefined();
  });

  it("derives the SAME value with subtle present and absent", () => {
    const url = "/api/network/pay";
    const body = { payment_request: "lnbc1pjxyzqqdq" };
    const withSubtle = derive(url, body);
    deleteSubtle();
    const withoutSubtle = derive(url, body);
    expect(withSubtle.ok && withoutSubtle.ok).toBe(true);
    if (!withSubtle.ok || !withoutSubtle.ok) return;
    expect(withoutSubtle.value).toBe(withSubtle.value);
  });

  it("and the server still accepts it, for every route", () => {
    deleteSubtle();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["/api/network/pay", { payment_request: "lnbc1pjxyzqqdq" }],
      ["/api/member/open-channel", { capacity_sats: 1_000_000 }],
      ["/api/treasury/rotation/execute", { channel_id: "842391119757312", is_force_close: true }],
      ["/api/swaps/loop-in", { swap_request_id: "swap-def" }],
    ];
    for (const [url, body] of cases) {
      const d = derive(url, body);
      expect(d.ok, `derive failed without subtle for ${url}`).toBe(true);
      if (!d.ok) return;
      expect(
        verifyConfirmation(serverRoute("POST", url), { url, body }, d.value),
        `server rejected the no-subtle value for ${url}`
      ).toEqual({ ok: true });
    }
  });

  it("multi-byte UTF-8 survives without subtle (TextEncoder, not charCodeAt)", () => {
    deleteSubtle();
    const url = "/api/member/open-channel";
    const body = { capacity_sats: 1_000_000, partner_socket: "café-node:9735" };
    const d = derive(url, body);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(verifyConfirmation(serverRoute("POST", url), { url, body }, d.value)).toEqual({ ok: true });
  });
});
