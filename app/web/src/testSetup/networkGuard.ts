// Test-network guard: no app/web test reaches the network.
//
// Runs before every test file (vitest.config.ts `setupFiles`), so it is in place
// BEFORE any module loads. That ordering is load-bearing: @metamask/sdk-analytics
// builds its openapi-fetch client at module load, and openapi-fetch reads
// `globalThis.fetch` once, in createClient() — a test's later
// vi.stubGlobal("fetch") never reaches that client. Importing App.tsx loads it:
// wagmi's createConfig runs the MetaMask connector's setup(), which inits the
// SDK, which enables analytics and POSTs "sdk_initialized" 200 ms later, then
// retries a failed send forever on a re-arming timer (sdk-analytics
// dist/index.js:56-84). Measured 2026-11-18: 12 of 20 App-mounting test files
// sent it to the real host before this guard existed.
//
// Per destination (ruled 2026-11-18, code-audit-2 "test-network stub"):
//   - outside this machine → recorded, rejected with NetworkBlockedError, and the
//     test that made it FAILS in afterEach (afterAll for anything after the last
//     test), naming the URL and the call site. Fix by stubbing it in the test.
//   - this machine or a relative URL → rejected as TypeError("fetch failed",
//     { cause: NetworkBlockedError }) — the shape undici gives a refused
//     connection — never a real socket, never a failure. App code's API_BASE
//     resolves to http://localhost:3101 here; a dev API running there must not
//     answer tests.
//   - TELEMETRY_SINK_HOSTS → answered locally with 200 "{}" and recorded in
//     takeSunk(), not failed. Rejecting would re-arm MetaMask's retry timer and
//     fail whichever later test was running, not the one that caused it.
//   - data: / blob: → the real fetch; neither can open a socket.
//
// A test that stubs fetch itself is unaffected: vi.stubGlobal("fetch", m)
// replaces this guard for that test and vi.unstubAllGlobals() puts it back
// (vitest saved it as the original). The guard is a plain function, not a vi.fn,
// so resetAllMocks/restoreAllMocks cannot clear it.
//
// Channels (inventory 2026-11-18, vitest 2.1.9 jsdom env on Node 20): fetch is
// Node's undici; XMLHttpRequest and WebSocket are jsdom's and open real sockets,
// so both are replaced at the JS layer with the same rules (every request is
// refused; outside hosts are also recorded). EventSource and
// navigator.sendBeacon do not exist here; networkGuard.test.ts asserts that, so
// an environment that adds them turns the control red. Below all of them,
// net.Socket#connect refuses any TCP connect to a host outside this machine:
// the backstop for node http/https, ws, cross-fetch, socket.io, and anything
// else that bypasses the globals.
//
// The control is networkGuard.test.ts next to this file.

import net from "node:net";
import { afterAll, afterEach, expect } from "vitest";

export class NetworkBlockedError extends Error {
  readonly channel: string;
  readonly url: string;
  constructor(channel: string, url: string) {
    super(`[network-guard] blocked ${channel} to ${url} — stub it in this test (see src/testSetup/networkGuard.ts)`);
    this.name = "NetworkBlockedError";
    this.channel = channel;
    this.url = url;
  }
}

export interface GuardRecord {
  channel: string;
  url: string;
  test: string | undefined;
  stack: string;
}

export const TELEMETRY_SINK_HOSTS: ReadonlySet<string> = new Set([
  // MetaMask SDK analytics — see the header for why it is answered, not failed.
  "mm-sdk-analytics.api.cx.metamask.io",
]);

const blocked: GuardRecord[] = [];
const sunk: GuardRecord[] = [];

/** Outside-host attempts since the last take. Reading clears them, so the afterEach check will not fail on them. */
export const takeBlocked = (): GuardRecord[] => blocked.splice(0);
/** Telemetry requests answered locally since the last take. */
export const takeSunk = (): GuardRecord[] => sunk.splice(0);

function record(list: GuardRecord[], channel: string, url: string): void {
  const stack = (new Error().stack ?? "").split("\n").slice(3, 9).join("\n");
  list.push({ channel, url, test: expect.getState().currentTestName, stack });
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127(\.\d{1,3}){3}$/.test(h);
}

type Verdict = { kind: "inert" | "local" | "sink" | "external"; url: string };

export function classify(raw: string): Verdict {
  let u: URL;
  try {
    u = new URL(raw, globalThis.location?.href ?? "http://localhost/");
  } catch {
    return { kind: "local", url: raw }; // unparseable: the real fetch would reject it too
  }
  if (u.protocol === "data:" || u.protocol === "blob:") return { kind: "inert", url: u.href };
  if (isLoopbackHost(u.hostname)) return { kind: "local", url: u.href };
  if (TELEMETRY_SINK_HOSTS.has(u.hostname)) return { kind: "sink", url: u.href };
  return { kind: "external", url: u.href };
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  const o = input as { href?: string; url?: string } | null;
  return o?.href ?? o?.url ?? String(input);
}

// ─── fetch ──────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

/** Never throws synchronously: call sites like `fetch(url).then(…)` would throw inside effects. */
export function guardFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const v = classify(urlOf(input));
    switch (v.kind) {
      case "inert":
        return realFetch(input, init);
      case "sink":
        record(sunk, "fetch", v.url);
        return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
      case "local":
        return Promise.reject(new TypeError("fetch failed", { cause: new NetworkBlockedError("fetch", v.url) }));
      case "external":
        record(blocked, "fetch", v.url);
        return Promise.reject(new NetworkBlockedError("fetch", v.url));
    }
  } catch (e) {
    return Promise.reject(e);
  }
}

globalThis.fetch = guardFetch as typeof fetch;

// ─── XMLHttpRequest (jsdom) ─────────────────────────────────────────────────

const XHR = globalThis.XMLHttpRequest;
if (XHR) {
  const realOpen = XHR.prototype.open;
  const target = new WeakMap<XMLHttpRequest, { url: string; sync: boolean }>();
  XHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean, ...rest: unknown[]) {
    target.set(this, { url: urlOf(url), sync: async === false });
    return (realOpen as (...a: unknown[]) => void).call(this, method, url, async ?? true, ...rest);
  } as typeof XHR.prototype.open;
  XHR.prototype.send = function (this: XMLHttpRequest) {
    const t = target.get(this);
    const v = classify(t?.url ?? "");
    if (v.kind === "external") record(blocked, "XMLHttpRequest", v.url);
    if (t?.sync) throw new DOMException(`[network-guard] blocked XMLHttpRequest to ${v.url}`, "NetworkError");
    setTimeout(() => {
      this.dispatchEvent(new ProgressEvent("error"));
      this.dispatchEvent(new ProgressEvent("loadend"));
    }, 0);
  };
}

// ─── WebSocket (jsdom) ──────────────────────────────────────────────────────

if (globalThis.WebSocket) {
  class GuardWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    readyState = 0;
    protocol = "";
    extensions = "";
    bufferedAmount = 0;
    binaryType: BinaryType = "blob";
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    constructor(url: string | URL) {
      super();
      const v = classify(urlOf(url));
      this.url = v.url;
      if (v.kind === "external") record(blocked, "WebSocket", v.url);
      setTimeout(() => {
        this.readyState = 3;
        const err = new Event("error");
        this.dispatchEvent(err);
        this.onerror?.(err);
        const close = new CloseEvent("close", { code: 1006, wasClean: false });
        this.dispatchEvent(close);
        this.onclose?.(close);
      }, 0);
    }
    send(): void {
      throw new DOMException("[network-guard] WebSocket is never open in tests", "InvalidStateError");
    }
    close(): void {}
  }
  globalThis.WebSocket = GuardWebSocket as unknown as typeof WebSocket;
}

// ─── Backstop: net.Socket#connect ───────────────────────────────────────────
//
// node:net is shared by everything in this worker and can outlive one test
// file's module graph, so the patch is installed once and reports through
// whichever guard module loaded last.

const RECORDER = Symbol.for("bitcorn.networkGuard.recorder");
const PATCHED = Symbol.for("bitcorn.networkGuard.netPatched");
type Holder = { [RECORDER]?: (channel: string, url: string) => void; [PATCHED]?: boolean };
const holder = process as unknown as Holder;
holder[RECORDER] = (channel, url) => record(blocked, channel, url);

if (!holder[PATCHED]) {
  holder[PATCHED] = true;
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const a0 = args[0] as unknown;
    const opts = (Array.isArray(a0) ? a0[0] : typeof a0 === "object" && a0 !== null ? a0 : { port: a0, host: args[1] }) as {
      path?: string;
      host?: unknown;
      port?: unknown;
    };
    const host = typeof opts.host === "string" ? opts.host : "localhost";
    if (opts.path || isLoopbackHost(host)) return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    const where = `${host}:${String(opts.port)}`;
    holder[RECORDER]?.("net.connect", where);
    process.nextTick(() => this.destroy(Object.assign(new NetworkBlockedError("net.connect", where), { code: "ECONNREFUSED" })));
    return this;
  } as typeof net.Socket.prototype.connect;
}

// ─── Surfacing ──────────────────────────────────────────────────────────────

/** Exported for the control; every test runs it via the hooks below. */
export function failIfBlocked(when: string): void {
  const b = takeBlocked();
  if (b.length === 0) return;
  const lines = b.map((r) => `  ${r.channel} ${r.url}${r.test && when === "after all tests" ? `  (during "${r.test}")` : ""}\n${r.stack}`);
  throw new Error(`[network-guard] ${b.length} outbound request(s) ${when} — stub them in the test:\n${lines.join("\n")}`);
}

afterEach(() => failIfBlocked("in this test"));
afterAll(() => failIfBlocked("after all tests"));
