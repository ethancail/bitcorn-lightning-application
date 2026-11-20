// code-audit-2 F02, per site: each of the six limits reaches ENV through the
// real config module. A malformed value gives the default, and a correct value
// is not swallowed by the fallback (the half that proves the knob works — see
// syncTiming.test.ts on a parseInt fallback that could never be reached).

import { afterEach, describe, expect, it, vi } from "vitest";

const SITES = [
  { env: "RATE_LIMIT_TX_PER_MINUTE", key: "rateLimitTxPerMinute", def: 10 },
  { env: "RATE_LIMIT_SATS_PER_MINUTE", key: "rateLimitSatsPerMinute", def: 50_000_000 },
  { env: "RATE_LIMIT_SATS_PER_HOUR", key: "rateLimitSatsPerHour", def: 200_000_000 },
  { env: "RATE_LIMIT_MAX_SINGLE_PAYMENT", key: "rateLimitMaxSinglePayment", def: 50_000_000 },
  { env: "MEMBER_MAX_DAILY_WITHDRAWAL_SAT", key: "memberMaxDailyWithdrawalSat", def: 5_000_000 },
  { env: "MEMBER_MAX_DAILY_REFILL_SAT", key: "memberMaxDailyRefillSat", def: 5_000_000 },
] as const;

const ORIGINAL = Object.fromEntries(SITES.map((s) => [s.env, process.env[s.env]]));

afterEach(() => {
  for (const s of SITES) {
    if (ORIGINAL[s.env] === undefined) delete process.env[s.env];
    else process.env[s.env] = ORIGINAL[s.env];
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

async function envWith(name: string, value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { ENV } = await import("./env");
  return ENV as unknown as Record<string, number>;
}

for (const s of SITES) {
  describe(`${s.env} → ENV.${s.key}`, () => {
    it(`unset → the default ${s.def}`, async () => {
      expect((await envWith(s.env, undefined))[s.key]).toBe(s.def);
    });

    it(`empty → the default ${s.def}, not 0`, async () => {
      expect((await envWith(s.env, ""))[s.key]).toBe(s.def);
    });

    it(`"abc" → the default ${s.def}, not NaN`, async () => {
      expect((await envWith(s.env, "abc"))[s.key]).toBe(s.def);
    });

    it(`"0" and "-5" → the default ${s.def}`, async () => {
      expect((await envWith(s.env, "0"))[s.key]).toBe(s.def);
      expect((await envWith(s.env, "-5"))[s.key]).toBe(s.def);
    });

    it(`a correct value "123" reaches ENV`, async () => {
      expect((await envWith(s.env, "123"))[s.key]).toBe(123);
    });
  });
}
