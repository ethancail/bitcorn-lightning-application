// PARITY: the client field map must agree with the server's, entry for entry.
//
// The two maps live in different processes and cannot share a module, so
// agreement is not structural — it is asserted here by importing the SERVER's
// table directly across the workspace and comparing. That import is the whole
// point: a copy of the server's expectations would be a third thing to keep in
// sync, which is the failure this prevents rather than a way to prevent it.
//
// If this fails, the client and server disagree about what to hash, which shows
// up in production as a 409 on every attempt at that route — an error whose copy
// says "this is a bug", correctly, and which nobody can act on from the UI.

import { describe, expect, it } from "vitest";
import { UI_CONFIRMED_ROUTES, findUiConfirmedRoute } from "./actionConfirmation";
import {
  CONFIRMED_ROUTES,
  CONFIRMATION_HEADER as SERVER_HEADER,
  type ConfirmedRoute as ServerRoute,
  type Matcher,
} from "../../../api/src/utils/action-confirmation";
import { CONFIRMATION_HEADER as CLIENT_HEADER } from "./actionConfirmation";

const mkey = (m: Matcher) =>
  m.kind === "exact" ? `=${m.url}` : m.kind === "prefix" ? `^${m.url}` : `^${m.prefix}$${m.suffix}`;
const rkey = (method: string, m: Matcher) => `${method} ${mkey(m)}`;

const serverByKey = new Map<string, ServerRoute>(
  CONFIRMED_ROUTES.map((r) => [rkey(r.method, r.match), r])
);

describe("client/server field-map parity", () => {
  it("the header name matches", () => {
    expect(CLIENT_HEADER).toBe(SERVER_HEADER);
  });

  it("every UI route exists on the server", () => {
    const missing = UI_CONFIRMED_ROUTES.map((r) => rkey(r.method, r.match)).filter(
      (k) => !serverByKey.has(k)
    );
    expect(
      missing,
      `The UI would send a confirmation for routes the server does not gate — either\n` +
        `a stale client entry or a route removed from the server:`
    ).toEqual([]);
  });

  for (const uiRoute of UI_CONFIRMED_ROUTES) {
    const key = rkey(uiRoute.method, uiRoute.match);

    it(`${key}: fields match the server EXACTLY, in order`, () => {
      const server = serverByKey.get(key);
      expect(server, `no server route for ${key}`).toBeDefined();
      if (!server) return;
      // Order matters as much as membership: the canonical string is built by
      // walking this array, so a reordering changes every hash on the route.
      expect(uiRoute.fields).toEqual(server.fields);
    });
  }

  it("names the server routes the UI does NOT cover, so the gap stays visible", () => {
    // Not a failure — three capital routes genuinely have no UI caller. This
    // asserts the list rather than leaving it to memory, so a new UI caller for
    // one of them shows up here instead of silently 400ing.
    //
    // Was FOUR. POST /api/lightning/open-recommended-channel left this list by
    // being DELETED rather than by gaining a caller: it funded a channel to a
    // Worker-supplied pubkey with no role gate and no assertCanExpand, and the
    // UI panel that would have driven it had already been removed. Shrinking
    // here is the intended direction; a route joining this list is the one that
    // deserves a second look.
    const uncovered = [...serverByKey.keys()]
      .filter((k) => !UI_CONFIRMED_ROUTES.some((r) => rkey(r.method, r.match) === k))
      .sort();
    expect(uncovered).toEqual([
      "POST =/api/pay",
      "POST =/api/treasury/rebalance/circular",
      "POST =/api/treasury/rebalance/loop-out",
    ]);
  });

  it("matching agrees with the server on a query string (neither treats it as the route)", () => {
    expect(findUiConfirmedRoute("POST", "/api/network/pay?x=1")).toBeNull();
  });
});
