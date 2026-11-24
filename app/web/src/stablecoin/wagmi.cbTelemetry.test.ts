// Coinbase wallet-SDK telemetry must be OFF (ruled 2026-11-23, code-audit-2
// "Coinbase wallet-SDK telemetry off").
//
// Why it matters: WagmiProvider's reconnect-on-mount (member shell only, via
// RailScope) calls getProvider() on every connector (@wagmi/core reconnect.ts),
// and the coinbaseWallet connector's getProvider() calls createCoinbaseWalletSDK.
// That factory loads the SDK's telemetry unless `preference.telemetry` is exactly
// `false` (createCoinbaseWalletSDK.js: `if (options.preference.telemetry !== false)
// void loadTelemetryScript()`; Preference.telemetry is "@default true"). The
// script defines window.ClientAnalytics and inits it against
// https://cca-lite.coinbase.com, after which every SDK event (logEvent.js gates on
// window.ClientAnalytics) is sent to /amp, /metrics and /traces — on every member
// page load in a secure context, with no wallet interaction.
//
// How it is observed:
//   - The connector keeps its options in a closure, but the SDK writes what it was
//     given into its own store (store.config). @coinbase/wallet-sdk is externalised
//     by vitest, so this file's import of that store and the connector's
//     `await import('@coinbase/wallet-sdk')` are the same Node module instance. T1
//     fails if that ever stops being true (the store would hold no appName).
//   - THE SCRIPT SHIM. loadTelemetryScript injects an inline <script>. A browser
//     runs it in the page's one global; vitest's jsdom runs it in jsdom's own inner
//     global instead, so window.ClientAnalytics never appears where the SDK looks
//     and NOTHING is ever sent — a network-only assertion would pass on the
//     unfixed config (measured 2026-11-23). The shim below restores browser
//     semantics: an inline script appended to document.head is evaluated in this
//     global (indirect eval) and counted. jsdom also lacks window.matchMedia, which
//     ClientAnalytics.init() calls, so it is stubbed. Both are in place before
//     wagmi.ts is imported and are undone in afterAll.
//   - The network side is read from the test-network guard
//     (src/testSetup/networkGuard.ts): cca-lite is an outside host, so its requests
//     are refused and recorded in takeBlocked(). jsdom fires no page-lifecycle
//     events, so CCA's queue is flushed explicitly (ClientAnalytics.flushQueue).
//
// T1 proves the test is not vacuous (the SDK really was built from OUR connector,
// through the call reconnect makes); T4 proves the observation channel would see
// cca-lite traffic if telemetry were on. Tests run in order and share the one SDK
// store; T4 overwrites it, so it runs last.

import { afterAll, describe, expect, it } from "vitest";
import { createCoinbaseWalletSDK } from "@coinbase/wallet-sdk";
import { store } from "@coinbase/wallet-sdk/dist/store/store.js";
import { takeBlocked, takeSunk, type GuardRecord } from "../testSetup/networkGuard";

const TELEMETRY_HOST = "cca-lite.coinbase.com";
const PAST_SEND_DELAY_MS = 1500;

type ClientAnalyticsGlobal = { ClientAnalytics?: { flushQueue(): Promise<unknown> } };
const w = window as unknown as ClientAnalyticsGlobal & { matchMedia?: unknown };

// ─── the browser-semantics shim (see header) ────────────────────────────────
const injectedScripts: string[] = [];
const head = document.head;
const realAppendChild = head.appendChild;
head.appendChild = function <T extends Node>(this: HTMLHeadElement, node: T): T {
  if (node instanceof HTMLScriptElement && node.textContent) {
    injectedScripts.push(node.textContent);
    (0, eval)(node.textContent);
  }
  return realAppendChild.call(this, node) as T;
};
// Test the type, not the key: vitest's jsdom global has a `matchMedia` key that
// is not a function, and an `in` check left init() throwing half-way (measured).
const originalMatchMedia = Object.getOwnPropertyDescriptor(w, "matchMedia");
const stubMatchMedia = typeof w.matchMedia !== "function";
if (stubMatchMedia) {
  w.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
}

afterAll(() => {
  head.appendChild = realAppendChild;
  if (stubMatchMedia) {
    delete w.matchMedia;
    if (originalMatchMedia) Object.defineProperty(w, "matchMedia", originalMatchMedia);
  }
  delete w.ClientAnalytics;
});

const telemetryHost = (r: GuardRecord) => new URL(r.url).hostname === TELEMETRY_HOST;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const takeTelemetry = () => [...takeBlocked(), ...takeSunk()].filter(telemetryHost);

type Provider = { request(a: { method: string }): Promise<unknown> };
let provider: Provider | undefined;

describe("Coinbase wallet-SDK telemetry (wagmi.ts)", () => {
  it("T1 anti-vacuity: the reconnect call builds the SDK from our coinbaseWallet() connector", async () => {
    const { wagmiConfig } = await import("./wagmi");
    const connector = wagmiConfig.connectors.find((c) => c.id === "coinbaseWalletSDK");
    expect(connector).toBeDefined();
    // The exact call @wagmi/core's reconnect makes on every connector at mount.
    provider = (await connector!.getProvider()) as Provider;
    expect(provider).toBeDefined();
    const config = store.config.get();
    expect(config.metadata).toMatchObject({ appName: "Bitcorn Lightning", appChainIds: [84532, 8453] });
    // The "all" ruling (wagmi.ts): passkey Smart Wallet AND an existing Coinbase Wallet.
    expect(config.preference?.options).toBe("all");
  }, 30_000);

  it("T2 the connector passes telemetry: false to the SDK", () => {
    // Strict false: an omitted option arrives as undefined, which the SDK treats as on.
    expect(store.config.get().preference?.telemetry).toBe(false);
  });

  it("T3 no telemetry script, no ClientAnalytics, and no cca-lite request after an SDK event", async () => {
    // An SDK request logs provider.request.* events; flushing sends anything queued.
    await provider!.request({ method: "eth_chainId" }).catch(() => undefined);
    await w.ClientAnalytics?.flushQueue();
    await sleep(PAST_SEND_DELAY_MS);
    expect({
      injectedScripts: injectedScripts.length,
      clientAnalytics: w.ClientAnalytics !== undefined,
      telemetryRequests: takeTelemetry().map((r) => `${r.channel} ${r.url}`),
    }).toEqual({ injectedScripts: 0, clientAnalytics: false, telemetryRequests: [] });
  });

  it("T4 positive control: the same SDK with telemetry ON is seen by the guard", async () => {
    takeTelemetry();
    const sdk = createCoinbaseWalletSDK({
      appName: "Bitcorn Lightning",
      appChainIds: [84532, 8453],
      preference: { options: "all", telemetry: true },
    });
    const p = sdk.getProvider() as unknown as Provider;
    expect(w.ClientAnalytics).toBeDefined();
    await p.request({ method: "eth_chainId" }).catch(() => undefined);
    await w.ClientAnalytics!.flushQueue();
    await sleep(PAST_SEND_DELAY_MS);
    expect(takeTelemetry()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "fetch", url: `https://${TELEMETRY_HOST}/metrics` }),
      ]),
    );
  }, 30_000);
});
