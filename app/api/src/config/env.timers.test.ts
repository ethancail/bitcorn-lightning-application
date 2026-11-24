// code-audit-2, Loop and money-path env parses (the F02 follow-up): the three
// scheduler intervals reach setInterval inside [1000, 2147483647] (R3). Node
// sets any delay outside [1, 2147483647], NaN included, to 1 ms (Node v24.22.3
// docs, timers: "When delay is larger than 2147483647 or less than 1 or NaN,
// the delay will be set to 1"; measured on v24.22.3: 178 ticks in 200 ms for
// NaN, 180 for 3e9 — Node 24 adds a TimeoutNaNWarning but still spins). Before the fix "abc" (NaN), ""
// (0) and "3000000000" (past 2^31 − 1) each made the scheduler a 1 ms hot
// loop; the Tier 3 tick has no `running` guard, so its ticks overlapped too.
// Each ⚠ case was red on that code; "3000000000" would stay red under a
// positiveIntEnv-only fix, which is why the timers have their own range.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-timers-env-"));

type Scheduler = {
  env: string;
  def: number;
  /** Starts the scheduler from a fresh module graph; returns its stop, if any. */
  start: () => Promise<(() => void) | undefined>;
};

const SCHEDULERS: Scheduler[] = [
  {
    env: "REBALANCE_SCHEDULER_INTERVAL_MS",
    def: 60_000,
    start: async () => {
      process.env.REBALANCE_SCHEDULER_ENABLED = "true";
      const m = await import("../lightning/rebalance-scheduler");
      return startTimed(() => m.startRebalanceScheduler());
    },
  },
  {
    env: "AUTOPAY_POLL_INTERVAL_MS",
    def: 60_000,
    start: async () => {
      const m = await import("../subscription/autoPayScheduler");
      return startTimed(() => m.startAutoPayScheduler(), m.stopAutoPayScheduler);
    },
  },
  {
    env: "SUBSCRIPTION_TIER3_INTERVAL_MS",
    def: 300_000,
    start: async () => {
      const m = await import("../subscription/tier3Scheduler");
      return startTimed(() => m.startTier3Scheduler(), m.stopTier3Scheduler);
    },
  },
];

let intervalSpy: ReturnType<typeof vi.spyOn> | null = null;

/** Run start() under fake timers, so no tick ever fires, recording setInterval. */
function startTimed(start: () => void, stop?: () => void) {
  vi.useFakeTimers();
  intervalSpy = vi.spyOn(globalThis, "setInterval");
  start();
  return stop;
}

afterEach(() => {
  for (const s of SCHEDULERS) delete process.env[s.env];
  delete process.env.REBALANCE_SCHEDULER_ENABLED;
  vi.clearAllTimers();
  vi.useRealTimers();
  intervalSpy = null;
  vi.restoreAllMocks();
});

async function delayFor(s: Scheduler, raw: string | undefined): Promise<number> {
  vi.resetModules();
  if (raw === undefined) delete process.env[s.env];
  else process.env[s.env] = raw;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const stop = await s.start();
  stop?.();
  expect(intervalSpy!).toHaveBeenCalledTimes(1);
  return intervalSpy!.mock.calls[0][1] as number;
}

for (const s of SCHEDULERS) {
  describe(`${s.env} → setInterval (default ${s.def} ms)`, () => {
    it("unset → the default", async () => {
      expect(await delayFor(s, undefined)).toBe(s.def);
    });

    for (const raw of ["abc", "", "0", "999", "3000000000"]) {
      it(`⚠ ${JSON.stringify(raw)} → the default, never a 1 ms hot loop`, async () => {
        expect(await delayFor(s, raw)).toBe(s.def);
      });
    }

    it("control: a configured 120000 reaches setInterval", async () => {
      expect(await delayFor(s, "120000")).toBe(120_000);
    });
  });
}
