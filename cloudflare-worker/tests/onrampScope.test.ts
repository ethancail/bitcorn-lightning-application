// Router-level scope test for the Coinbase Onramp route, POST / (src/index.ts,
// the "SUBSCRIBER-BASE endpoints" section).
//
// THE REQUIREMENT this pins (Ethan, 2026-11-09): "we do want members to be
// able to buy bitcoin without the membership so they can pay for the
// membership". Under no-free-period every new member is `prepay`, and every
// non-`current` tier mints a PAYMENT-scope token (scopeForTier() in
// app/api/src/subscription/tokenIssuance.ts, pinned by tierScope.test.ts). So
// a new member's only way to fund their first payment runs through this route
// accepting scope=payment. Moving Onramp into the full-scope class would lock
// every new member out of paying for the membership, and nothing else in the
// Worker suite would notice: before this file no test reached POST / at all.
//
// Everything goes through `worker.fetch`, so withJwtGate is in the path.
//
// HOW "reached the route" is proven: the request is well-formed and the
// Coinbase token call is replaced (globalThis.fetch spied, as in
// daybreakDraftRoute.test.ts), so a gate-passing request runs the real handler
// — CDP JWT signing included, with a throwaway P-256 key — and returns 200 with
// the mocked session token. That is asserted positively, not as "not 401/403":
// a 500 or 404 would satisfy the negative form while meaning the request never
// got where we claim. No test here reaches the network.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import worker from "../src/index";
import type { Env } from "../src/lib/types";
import {
  createEntitlementSigner,
  withAuth,
  type EntitlementSigner,
} from "./helpers/entitlementToken";

const COINBASE_TOKEN_URL = "https://api.developer.coinbase.com/onramp/v1/token";
const MOCK_SESSION_TOKEN = "cb-session-token-test";
const ADDRESS = "bc1qtestonrampaddress0000000000000000000000";

let signer: EntitlementSigner;
let cdpPrivateKeyPem: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  signer = await createEntitlementSigner();
  // handleOnramp passes a PKCS#8 PEM straight to importPKCS8 (only SEC1 PEMs
  // are converted), so a fresh ES256 key exercises the real signing path.
  const cdp = await generateKeyPair("ES256", { extractable: true });
  cdpPrivateKeyPem = await exportPKCS8(cdp.privateKey as CryptoKey);
});

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ token: MOCK_SESSION_TOKEN }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEnv(): Env {
  return {
    SUBSCRIPTION_PUBLIC_KEY: signer.publicKeyX,
    CDP_KEY_NAME: "organizations/test/apiKeys/test",
    CDP_PRIVATE_KEY: cdpPrivateKeyPem,
  } as unknown as Env;
}

function onrampRequest(): Request {
  return new Request("https://w/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: ADDRESS }),
  });
}

/** Asserts the handler ran to completion and called Coinbase exactly once. */
async function expectReachedOnramp(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sessionToken: MOCK_SESSION_TOKEN });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(String(url)).toBe(COINBASE_TOKEN_URL);
  expect(JSON.parse(String(init.body))).toEqual({
    destination_wallets: [{ address: ADDRESS, blockchains: ["bitcoin"] }],
  });
}

describe("POST / (Coinbase Onramp) — reachable without a current membership", () => {
  it("a PAYMENT-scope token (prepay / any lapsed tier) passes the gate and gets a session token", async () => {
    const jwt = await signer.token("payment");
    const res = await worker.fetch(withAuth(onrampRequest(), jwt), makeEnv(), {} as any);
    // The assertion that goes red if Onramp is moved to the full-scope class:
    // the gate would answer 403 scope_insufficient and Coinbase is never called.
    await expectReachedOnramp(res);
  });

  it("a FULL-scope token (current tier) passes the gate and gets a session token", async () => {
    const jwt = await signer.token("full");
    const res = await worker.fetch(withAuth(onrampRequest(), jwt), makeEnv(), {} as any);
    await expectReachedOnramp(res);
  });

  it("a request with NO Bearer is refused 401 (missing) and never reaches Coinbase", async () => {
    const res = await worker.fetch(onrampRequest(), makeEnv(), {} as any);
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(401);
    expect(body.error).toBe("missing");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
