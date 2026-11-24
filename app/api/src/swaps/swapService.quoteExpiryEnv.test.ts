// code-audit-2, Loop and money-path env parses (the F02 follow-up):
// SWAP_QUOTE_EXPIRY_SEC. Before the fix, "abc" gave NaN, now + NaN is NaN,
// better-sqlite3 stores NaN as NULL, and execute's
// `req.quote_expires_at && Date.now() > req.quote_expires_at` is then falsy:
// the quote never expired. "" gave 0: every quote expired as it was made.
// Both ⚠ cases were red on that code.
//
// The real createLoopOutQuote / createLoopInQuote on a migrated temp-dir DB;
// only the loopd quote calls are stubbed.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-quote-expiry-env-"));
process.env.DB_DIR = TMP_DB;
const ME = "02" + "11".repeat(32);

vi.mock("./loopProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loopProvider")>()),
  quoteLoopOut: vi.fn(async () => ({ swap_fee_sat: 2_000, prepay_sat: 30_000, miner_fee_sat: 1_000 })),
  quoteLoopIn: vi.fn(async () => ({ swap_fee_sat: 2_000, htlc_publish_fee_sat: 1_000 })),
  recordSwapEvent: vi.fn(),
}));

afterEach(() => {
  delete process.env.SWAP_QUOTE_EXPIRY_SEC;
  vi.restoreAllMocks();
});

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

async function load(raw: string | undefined) {
  vi.resetModules();
  if (raw === undefined) delete process.env.SWAP_QUOTE_EXPIRY_SEC;
  else process.env.SWAP_QUOTE_EXPIRY_SEC = raw;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  return import("./swapService");
}

async function lifetimesMs(raw: string | undefined) {
  const svc = await load(raw);
  const out = await svc.createLoopOutQuote({ nodePubkey: ME, role: "member", amountSat: 500_000 });
  const inn = await svc.createLoopInQuote({ nodePubkey: ME, role: "member", amountSat: 500_000 });
  return [out.swapRequest, inn.swapRequest].map((r) =>
    r.quote_expires_at == null ? null : r.quote_expires_at - r.created_at,
  );
}

describe("SWAP_QUOTE_EXPIRY_SEC — a stored quote's lifetime (default 300 s)", () => {
  it("⚠ \"abc\": both quotes expire after the default 300 s, not never (NULL)", async () => {
    expect(await lifetimesMs("abc")).toEqual([300_000, 300_000]);
  });

  it("⚠ empty: both quotes live the default 300 s, not 0", async () => {
    expect(await lifetimesMs("")).toEqual([300_000, 300_000]);
  });

  it("control: a configured 60 gives 60 s", async () => {
    expect(await lifetimesMs("60")).toEqual([60_000, 60_000]);
  });
});
