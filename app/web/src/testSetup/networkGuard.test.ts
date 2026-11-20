// Control for the test-network guard (./networkGuard.ts, loaded by
// vitest.config.ts setupFiles before this file). Fails if an outbound request
// gets through, and — anti-vacuity — if the guard blocks what it must allow.
//
// The outside target is TEST-NET-1 (RFC 5737): reserved for documentation,
// never routed, and an IP literal, so there is no DNS query. Every case that
// expects a refusal races a timer, so a bypassed guard fails fast with
// "TIMEOUT …" or the platform's network error instead of hanging — a different
// failure from the NetworkBlockedError asserted, which is what tells the two
// apart.
//
// Negative control, 2026-11-18: with the `globalThis.fetch = guardFetch` line
// removed, the fetch case goes red (TypeError from the real fetch, its cause the
// backstop's refusal); with the net.Socket#connect patch removed, the https
// case goes red (TIMEOUT). Both are green with the file restored.

import https from "node:https";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TELEMETRY_SINK_HOSTS, failIfBlocked, guardFetch, takeBlocked, takeSunk } from "./networkGuard";

const OUTSIDE_HTTP = "http://192.0.2.1:9/network-guard-probe";
const OUTSIDE_WS = "ws://192.0.2.1:9/network-guard-probe";
const T = 1500;

const timeout = (what: string) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT: ${what} was not refused`)), T));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  takeSunk();
});

describe("network guard — an outbound request cannot get through", () => {
  it("fetch to an outside host rejects with NetworkBlockedError and is recorded against this test", async () => {
    const err = await Promise.race([fetch(OUTSIDE_HTTP), timeout("fetch")]).then(
      () => new Error("RESPONSE: fetch got through"),
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: "NetworkBlockedError", url: OUTSIDE_HTTP });
    expect(takeBlocked()).toEqual([
      expect.objectContaining({ channel: "fetch", url: OUTSIDE_HTTP, test: expect.stringContaining("fetch to an outside host") }),
    ]);
  });

  it("XMLHttpRequest to an outside host fires error, never load, and is recorded", async () => {
    const xhr = new XMLHttpRequest();
    const outcome = await new Promise<string>((resolve) => {
      xhr.onerror = () => resolve("error");
      xhr.onload = () => resolve("load");
      setTimeout(() => resolve("timeout"), T);
      xhr.open("GET", OUTSIDE_HTTP);
      xhr.send();
    });
    expect(outcome).toBe("error");
    expect(takeBlocked()).toEqual([expect.objectContaining({ channel: "XMLHttpRequest", url: OUTSIDE_HTTP })]);
  });

  it("WebSocket to an outside host errors, closes with 1006, never opens, and is recorded", async () => {
    const ws = new WebSocket(OUTSIDE_WS);
    const events: string[] = [];
    const code = await new Promise<number | string>((resolve) => {
      ws.onopen = () => events.push("open");
      ws.onerror = () => events.push("error");
      ws.onclose = (e) => resolve(e.code);
      setTimeout(() => resolve("timeout"), T);
    });
    expect(events).toEqual(["error"]);
    expect(code).toBe(1006);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(takeBlocked()).toEqual([expect.objectContaining({ channel: "WebSocket", url: OUTSIDE_WS })]);
  });

  it("node https.request (the net.Socket#connect backstop) is refused and recorded", async () => {
    const err = await new Promise<unknown>((resolve) => {
      const req = https.request("https://192.0.2.1:9/", () => resolve(new Error("RESPONSE: https got through")));
      req.on("error", resolve);
      req.setTimeout(T, () => req.destroy(new Error("TIMEOUT: connect was not refused by the backstop")));
      req.end();
    });
    expect(err).toMatchObject({ name: "NetworkBlockedError", code: "ECONNREFUSED" });
    expect(takeBlocked()).toEqual([expect.objectContaining({ channel: "net.connect", url: "192.0.2.1:9" })]);
  });

  it("a recorded request fails the test that made it — the afterEach check, driven directly", async () => {
    await fetch(OUTSIDE_HTTP).catch(() => {});
    expect(() => failIfBlocked("in this test")).toThrow(
      /\[network-guard\] 1 outbound request\(s\) in this test[\s\S]*fetch http:\/\/192\.0\.2\.1:9\/network-guard-probe/,
    );
    expect(takeBlocked()).toEqual([]); // the check consumed it
  });

  it("EventSource and navigator.sendBeacon do not exist here (if they ever do, the guard must cover them)", () => {
    expect(typeof (globalThis as { EventSource?: unknown }).EventSource).toBe("undefined");
    expect(typeof (navigator as { sendBeacon?: unknown }).sendBeacon).toBe("undefined");
  });
});

describe("network guard — anti-vacuity: what it must still allow", () => {
  it("the guard is the global fetch, and a test's own stub replaces it, sees the call, and records nothing", async () => {
    expect(globalThis.fetch).toBe(guardFetch);
    const stub = vi.fn(async () => new Response("stubbed"));
    vi.stubGlobal("fetch", stub);
    const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    expect(await res.text()).toBe("stubbed");
    expect(stub).toHaveBeenCalledWith("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    expect(takeBlocked()).toEqual([]);
    vi.unstubAllGlobals();
    expect(globalThis.fetch).toBe(guardFetch);
  });

  it("a stubbed fetch receives a relative URL unchanged", async () => {
    const stub = vi.fn(async () => new Response("[]"));
    vi.stubGlobal("fetch", stub);
    await fetch("/api/channels");
    expect(stub).toHaveBeenCalledWith("/api/channels");
  });

  it("relative and this-machine URLs reject as a refused connection — not recorded, no socket opened", async () => {
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    for (const url of ["/api/channels", "http://localhost:3101/api/node", "http://127.0.0.1:3101/", "http://[::1]:3101/"]) {
      const err = await fetch(url).then(
        () => new Error(`RESPONSE: ${url} resolved`),
        (e: unknown) => e,
      );
      expect(err, url).toBeInstanceOf(TypeError);
      expect((err as TypeError).message, url).toBe("fetch failed");
      expect((err as TypeError).cause, url).toMatchObject({ name: "NetworkBlockedError" });
    }
    expect(connect).not.toHaveBeenCalled();
    expect(takeBlocked()).toEqual([]);
  });

  it("the telemetry host is answered locally with 200 and recorded as sunk, not blocked", async () => {
    const [host] = [...TELEMETRY_SINK_HOSTS];
    const res = await fetch(`https://${host}/v1/events`, { method: "POST", body: "[]" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(takeSunk()).toEqual([expect.objectContaining({ channel: "fetch", url: `https://${host}/v1/events` })]);
    expect(takeBlocked()).toEqual([]);
  });
});
