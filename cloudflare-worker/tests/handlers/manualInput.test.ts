import { describe, expect, it } from "vitest";
import { handleManualInput } from "../../src/handlers/manualInput";
import { signHmac } from "../../src/lib/hmac";
import { loadManualHistory, MANUAL_KV_KEY } from "../../src/valuation/manualStore";
import type { Env } from "../../src/lib/types";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

const SECRET = "test-shared-secret";

function validBody(timestamp = "2026-04-17T14:32:00Z"): string {
  return JSON.stringify({
    submitted_at: timestamp,
    values: {
      mvrv: 2.1, puell: 0.4, sopr: 1.008, reserve_risk: 0.003,
      nvt: 85.4, hash_ribbons: 1.02, difficulty_ribbon: 0.023, hodl_waves: 0.15,
    },
  });
}

async function signedRequest(body: string, timestampHeader: string, signature?: string): Promise<Request> {
  const sig = signature ?? await signHmac(SECRET, timestampHeader, body);
  return new Request("https://w/valuation/manual", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Valuation-Timestamp": timestampHeader,
      "X-Valuation-Signature": sig,
    },
    body,
  });
}

describe("POST /valuation/manual", () => {
  it("returns 204 on valid signed submission and appends to KV", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = validBody(now);
    const req = await signedRequest(body, now);

    const res = await handleManualInput(req, env);
    expect(res.status).toBe(204);

    const history = await loadManualHistory(kv);
    expect(history.mvrv.length).toBe(1);
    expect(history.mvrv[0].value).toBeCloseTo(2.1, 10);
  });

  it("returns 401 when VALUATION_SUBMIT_HMAC is not configured", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env; // no secret
    const now = new Date().toISOString();
    const req = await signedRequest(validBody(now), now);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 on signature mismatch", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = validBody(now);
    const req = await signedRequest(body, now, "deadbeef".repeat(8));
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 when timestamp header is absent", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const body = validBody();
    const req = new Request("https://w/valuation/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Valuation-Signature": "abc" },
      body,
    });
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 when timestamp is >5 min skewed", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const body = validBody(stale);
    const req = await signedRequest(body, stale);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing 'values' object", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = JSON.stringify({ submitted_at: now });
    const req = await signedRequest(body, now);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing required metric key", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = JSON.stringify({
      submitted_at: now,
      values: { mvrv: 2.1 }, // missing 7 others
    });
    const req = await signedRequest(body, now);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 on non-finite numeric value", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = JSON.stringify({
      submitted_at: now,
      values: {
        mvrv: Number.NaN, puell: 0.4, sopr: 1.008, reserve_risk: 0.003,
        nvt: 85.4, hash_ribbons: 1.02, difficulty_ribbon: 0.023, hodl_waves: 0.15,
      },
    });
    const req = await signedRequest(body, now);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(400);
  });
});
