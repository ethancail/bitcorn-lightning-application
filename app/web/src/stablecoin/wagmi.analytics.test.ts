// MetaMask SDK analytics must be OFF (ruled 2026-11-18, code-audit-2 "MetaMask
// analytics off").
//
// Why it matters: createConfig in ./wagmi.ts runs every connector's setup() at
// module load, and the MetaMask connector's setup() inits @metamask/sdk. With
// enableAnalytics left at the SDK's default (true; performSDKInitialization's
// `options.enableAnalytics ?? true`), init POSTs "sdk_initialized" to
// https://mm-sdk-analytics.api.cx.metamask.io/v1/events 200 ms later — on every
// page load, treasury included, with no wallet interaction.
//
// How it is observed: the wagmi connector keeps its options in a closure, so the
// test records them where they are used — at the SDK constructor. vi.mock cannot
// reach it: vitest externalises @wagmi/connectors, so the connector's
// `await import('@metamask/sdk')` is resolved by Node itself (to the package's
// "main", dist/node/cjs/metamask-sdk.js; no "exports" field) and never sees a
// vitest mock (measured 2026-11-20: the factory never ran). Instead the test
// loads that same CJS module with Node's require and swaps its `default` export
// for a recording subclass before wagmi.ts is imported. The connector reads
// `SDK.default` off that shared module.exports object when setup() runs
// (metaMask.ts getProvider's unwrapping), so it constructs the recorder. T1
// fails if that ever stops being true.
//
// The network side is read from the test-network guard
// (src/testSetup/networkGuard.ts), which answers the analytics host with 200 and
// records it in takeSunk().
//
// T1 proves the test is not vacuous (the SDK really was built from OUR connector
// and initialised in the conditions under which it sends analytics); T4 proves
// the observation channel would see the POST if analytics were on. Tests run in
// order and share the one SDK the import creates.

import { createRequire } from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";
import { takeBlocked, takeSunk, type GuardRecord } from "../testSetup/networkGuard";

const ANALYTICS_HOST = "mm-sdk-analytics.api.cx.metamask.io";
// sdk-analytics batches with baseTimeoutMs: 200; wait well past it.
const PAST_SEND_DELAY_MS = 1500;

type AnySdk = {
  options: Record<string, unknown>;
  platformManager?: { isBrowser(): boolean };
  init(): Promise<unknown>;
};
type SdkClass = new (o: Record<string, unknown>) => AnySdk;

const nodeRequire = createRequire(import.meta.url);
const sdkModule = nodeRequire("@metamask/sdk") as { default: SdkClass };
const Real = sdkModule.default;

const seen = {
  options: [] as Record<string, unknown>[],
  sdks: [] as AnySdk[],
  inits: [] as Promise<unknown>[],
};

class RecordingSDK extends Real {
  constructor(o: Record<string, unknown>) {
    seen.options.push({ ...o }); // a copy: init() writes its defaults onto the live object
    super(o);
    seen.sdks.push(this);
  }
  override init() {
    const p = super.init();
    seen.inits.push(p);
    return p;
  }
}

afterAll(() => {
  sdkModule.default = Real;
});

const metamaskHost = (r: GuardRecord) => new URL(r.url).hostname.endsWith("metamask.io");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MetaMask SDK analytics (wagmi.ts)", () => {
  it("T1 anti-vacuity: importing wagmi.ts builds the SDK from our metaMask() connector and inits it as a browser", async () => {
    sdkModule.default = RecordingSDK;
    await import("./wagmi");
    // init() is called twice on the one instance — the SDK's constructor auto-inits
    // (sdk.ts) and the connector then awaits sdk.init() — and the second call
    // returns the first's promise. So count constructions, and await every init.
    await vi.waitFor(() => expect(seen.inits.length).toBeGreaterThan(0), { timeout: 20_000 });
    await Promise.all(seen.inits);
    expect(seen.options).toHaveLength(1);
    expect(seen.options[0]).toMatchObject({ _source: "wagmi" });
    // setupAnalyticsV2's other precondition: without it, no analytics would be sent
    // whatever the flag says, and T2/T3 would pass vacuously.
    expect(seen.sdks[0].platformManager?.isBrowser()).toBe(true);
  }, 30_000);

  it("T2 the connector passes enableAnalytics: false to the SDK", () => {
    // Strict false: an omitted option arrives as undefined, which the SDK defaults to true.
    expect(seen.options[0]?.enableAnalytics).toBe(false);
    // And after performSDKInitialization applied its `?? true` default.
    expect(seen.sdks[0].options.enableAnalytics).toBe(false);
  });

  it("T3 no MetaMask analytics request leaves after import, past the send delay", async () => {
    await sleep(PAST_SEND_DELAY_MS);
    expect(takeSunk().filter(metamaskHost)).toEqual([]);
    expect(takeBlocked().filter(metamaskHost)).toEqual([]);
  });

  it("T4 positive control: the same options with analytics ON are seen by the guard", async () => {
    takeSunk();
    // initializeMetaMaskSDK returns early while window.mmsdk (the page's first SDK)
    // is initialised — one SDK per page. Clear it so this instance really inits.
    const w = window as unknown as { mmsdk?: unknown };
    const first = w.mmsdk;
    delete w.mmsdk;
    try {
      const sdk = new Real({ ...seen.options[0], enableAnalytics: true });
      await sdk.init();
    } finally {
      w.mmsdk = first;
    }
    await sleep(PAST_SEND_DELAY_MS);
    expect(takeSunk().filter(metamaskHost)).toEqual([
      expect.objectContaining({ channel: "fetch", url: `https://${ANALYTICS_HOST}/v1/events` }),
    ]);
  }, 30_000);
});
