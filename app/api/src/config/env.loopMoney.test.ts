// code-audit-2, Loop and money-path env parses (the F02 follow-up), per site:
// each value reaches ENV through the real config module. A malformed or
// out-of-range value gives the default with a warning; unset or empty gives the
// default silently. Before this change every site was Number(v ?? d): "abc"
// gave NaN (most guards switched off, the member fee limit threw, the timers
// spun at 1 ms) and "" gave 0 (most caps refused everything). The `valid` rows
// are the controls: a correct value is not swallowed by the fallback, and
// where 0 is a legitimate setting it is kept, not replaced.
//
// Ranges are Ethan's rulings of 2026-11-23 (R1–R5, LOOP_CONF_TARGET min 2).

import { afterEach, describe, expect, it, vi } from "vitest";

type Site = {
  env: string;
  key: string;
  def: number;
  /** [raw, expected] — values that must reach ENV as given. */
  valid: Array<[string, number]>;
  /** Values outside this site's range: each gives the default. */
  invalid: string[];
};

const TIMER_INVALID = ["0", "999", "2147483648", "3000000000"];
const TIMER_VALID: Array<[string, number]> = [["1000", 1000], ["120000", 120_000], ["2147483647", 2_147_483_647]];

const SITES: Site[] = [
  // ── Tier A: Loop and swap policy ──
  { env: "LOOP_MAX_SWAP_FEE_PCT", key: "loopMaxSwapFeePct", def: 15,
    valid: [["1.5", 1.5], ["0.01", 0.01], ["100", 100]], invalid: ["0", "100.5", "150"] },
  { env: "LOOP_ROUTING_FEE_CAP_PPM", key: "loopRoutingFeeCapPpm", def: 10_000,
    valid: [["1", 1], ["5000", 5000], ["1000000", 1_000_000]], invalid: ["0", "1000001", "10.5"] },
  { env: "LOOP_MINER_FEE_MARGIN_PCT", key: "loopMinerFeeMarginPct", def: 50,
    valid: [["0", 0], ["12.5", 12.5], ["100", 100]], invalid: ["100.5", "200"] },
  { env: "LOOP_CONF_TARGET", key: "loopConfTarget", def: 6,
    valid: [["2", 2], ["144", 144]], invalid: ["0", "1", "2.5"] },
  { env: "MEMBER_MIN_WITHDRAWAL_SAT", key: "memberMinWithdrawalSat", def: 250_000,
    valid: [["300000", 300_000]], invalid: ["0", "1.5"] },
  { env: "MEMBER_MAX_WITHDRAWAL_SAT", key: "memberMaxWithdrawalSat", def: 2_000_000,
    valid: [["3000000", 3_000_000]], invalid: ["0", "1.5"] },
  { env: "MEMBER_MIN_REFILL_SAT", key: "memberMinRefillSat", def: 100_000,
    valid: [["200000", 200_000]], invalid: ["0", "1.5"] },
  { env: "MEMBER_MAX_REFILL_SAT", key: "memberMaxRefillSat", def: 3_000_000,
    valid: [["4000000", 4_000_000]], invalid: ["0", "1.5"] },
  { env: "SWAP_QUOTE_EXPIRY_SEC", key: "swapQuoteExpirySec", def: 300,
    valid: [["60", 60]], invalid: ["0", "1.5"] },
  { env: "SWAP_MEMBER_ROUTING_BUFFER_SAT", key: "swapMemberRoutingBufferSat", def: 50_000,
    valid: [["0", 0], ["75000", 75_000]], invalid: ["1.5"] },
  { env: "SWAP_TREASURY_EGRESS_RESERVE_SAT", key: "swapTreasuryEgressReserveSat", def: 100_000,
    valid: [["0", 0], ["150000", 150_000]], invalid: ["1.5"] },
  { env: "MEMBER_ONCHAIN_RESERVE_SAT", key: "memberOnchainReserveSat", def: 50_000,
    valid: [["0", 0], ["60000", 60_000]], invalid: ["1.5"] },
  // ── Tier A: the member Lightning payment fee limit ──
  { env: "MEMBER_PAY_MAX_FEE_BASE_SAT", key: "memberPayMaxFeeBaseSat", def: 10,
    valid: [["0", 0], ["0.5", 0.5], ["1.234", 1.234], ["25", 25]], invalid: ["0.0001"] },
  { env: "MEMBER_PAY_MAX_FEE_PPM", key: "memberPayMaxFeePpm", def: 10_000,
    valid: [["0", 0], ["5000", 5000]], invalid: ["1.5"] },
  // ── Tier A: the timers (R3: [1000, 2147483647]) ──
  { env: "REBALANCE_SCHEDULER_INTERVAL_MS", key: "rebalanceSchedulerIntervalMs", def: 60_000,
    valid: TIMER_VALID, invalid: TIMER_INVALID },
  { env: "AUTOPAY_POLL_INTERVAL_MS", key: "autoPayPollIntervalMs", def: 60_000,
    valid: TIMER_VALID, invalid: TIMER_INVALID },
  { env: "SUBSCRIPTION_TIER3_INTERVAL_MS", key: "subscriptionTier3IntervalMs", def: 300_000,
    valid: TIMER_VALID, invalid: TIMER_INVALID },
  // ── Tier B ──
  { env: "AUTOPAY_SETTLEMENT_COOLDOWN_MS", key: "autoPaySettlementCooldownMs", def: 7_200_000,
    valid: [["0", 0], ["600000", 600_000]], invalid: ["1.5"] },
  { env: "AUTOPAY_SETTLEMENT_ALERT_MS", key: "autoPaySettlementAlertMs", def: 172_800_000,
    valid: [["0", 0], ["60000", 60_000]], invalid: ["1.5"] },
  { env: "AUTOPAY_FAILURE_BACKOFF_MS", key: "autoPayFailureBackoffMs", def: 3_600_000,
    valid: [["0", 0], ["60000", 60_000]], invalid: ["1.5"] },
  { env: "AUTOPAY_FAILURE_PAUSE_THRESHOLD", key: "autoPayFailurePauseThreshold", def: 3,
    valid: [["1", 1], ["5", 5]], invalid: ["0", "1.5"] },
  { env: "REBALANCE_COOLDOWN_MINUTES", key: "rebalanceCooldownMinutes", def: 30,
    valid: [["0", 0], ["45", 45]], invalid: ["1.5"] },
  { env: "LOOP_MIN_REBALANCE_SATS", key: "loopMinRebalanceSats", def: 50_000,
    valid: [["0", 0], ["100000", 100_000]], invalid: ["1.5"] },
  { env: "LOOP_GRPC_PORT", key: "loopGrpcPort", def: 11_010,
    valid: [["1", 1], ["11020", 11_020], ["65535", 65_535]], invalid: ["0", "65536"] },
  { env: "BASE_CONFIRMATION_DEPTH", key: "baseConfirmationDepth", def: 64,
    valid: [["0", 0], ["12", 12]], invalid: ["1.5"] },
];

// Malformed for every site, whatever its range.
const MALFORMED = ["abc", "-5", "Infinity", "NaN", "1e3", "0x10", "5_000"];

const ORIGINAL = Object.fromEntries(SITES.map((s) => [s.env, process.env[s.env]]));

afterEach(() => {
  for (const s of SITES) {
    if (ORIGINAL[s.env] === undefined) delete process.env[s.env];
    else process.env[s.env] = ORIGINAL[s.env];
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

/** ENV with one variable set, and the warnings that named it. */
async function envWith(name: string, value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { ENV } = await import("./env");
  const named = warn.mock.calls.filter(([m]) => String(m).includes(name)).length;
  return { ENV: ENV as unknown as Record<string, number>, named };
}

for (const s of SITES) {
  describe(`${s.env} → ENV.${s.key}`, () => {
    it(`unset → the default ${s.def}, no warning`, async () => {
      const { ENV, named } = await envWith(s.env, undefined);
      expect(ENV[s.key]).toBe(s.def);
      expect(named).toBe(0);
    });

    it(`empty → the default ${s.def}, not 0, no warning`, async () => {
      const { ENV, named } = await envWith(s.env, "");
      expect(ENV[s.key]).toBe(s.def);
      expect(named).toBe(0);
    });

    for (const raw of [...MALFORMED, ...s.invalid]) {
      it(`${JSON.stringify(raw)} → the default ${s.def}, with a warning`, async () => {
        const { ENV, named } = await envWith(s.env, raw);
        expect(ENV[s.key]).toBe(s.def);
        expect(named).toBe(1);
      });
    }

    for (const [raw, want] of s.valid) {
      it(`control: ${JSON.stringify(raw)} reaches ENV as ${want}`, async () => {
        const { ENV, named } = await envWith(s.env, raw);
        expect(ENV[s.key]).toBe(want);
        expect(named).toBe(0);
      });
    }
  });
}
