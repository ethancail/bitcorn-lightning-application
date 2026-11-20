// The Coinbase adapter (coinbaseProvider.ts), kraken-autobuy P1.
//
// P0's scheduler suites already pin most of the adapter's mapping through the
// scheduler: placeWithdraw's arguments (B21), the fill fields (B39), the 400
// rule (B23), the withdrawal's tx hash (B28) and the listAccounts call counts
// (B27, B42). This file covers what the scheduler cannot reach:
//   · reading balances (absent or unreadable reads 0; no BTC account is null);
//   · the per-operation classification, in particular a 400 counts as an
//     address refusal on a withdrawal only;
//   · every status word, known and unknown;
//   · withdraw and getWithdrawal before any getBalances fail with no network call;
//   · the BTC account is remembered per session, never shared between sessions.
//
// The mock boundary is the same as P0's: ./coinbaseClient and ./credentials.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  placeMarketBuy: vi.fn(),
  pollOrder: vi.fn(),
  placeWithdraw: vi.fn(),
  pollWithdraw: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("./coinbaseClient", () => ({
  listAccounts: stubs.listAccounts,
  placeMarketBuy: stubs.placeMarketBuy,
  pollOrder: stubs.pollOrder,
  placeWithdraw: stubs.placeWithdraw,
  pollWithdraw: stubs.pollWithdraw,
}));
vi.mock("./credentials", () => ({ decrypt: stubs.decrypt }));

import * as cb from "./coinbaseProvider";
import type { ExchangeSession } from "./exchangeProvider";

const PEM = "-----BEGIN EC PRIVATE KEY-----\nstub\n-----END EC PRIVATE KEY-----\n";
const CREDS = { keyName: "stub-key", privateKeyPem: PEM };

const acct = (currency: string, value: string, uuid = `${currency.toLowerCase()}-uuid`) => ({
  uuid,
  name: currency,
  currency,
  available_balance: { value, currency },
});

let db: Database.Database;

function seedCredentials(): void {
  db.prepare(
    `INSERT INTO coinbase_credentials (id, key_name, encrypted_private_key, nonce, connected_at) VALUES (1, 'stub-key', ?, ?, 0)`,
  ).run(Buffer.from("ct"), Buffer.from("nonce"));
}

function open(): ExchangeSession {
  const r = cb.openSession(db);
  if (r.kind !== "ok") throw new Error(`expected an open session, got ${r.kind}`);
  return r.session;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(fs.readFileSync(path.join(__dirname, "../db/migrations", "034_coinbase_autobuy.sql"), "utf8"));
  seedCredentials();
  stubs.decrypt.mockReturnValue(PEM);
  stubs.listAccounts.mockResolvedValue({
    ok: true,
    status: 200,
    data: { accounts: [acct("USD", "12.50"), acct("BTC", "0.001")] },
  });
});

afterEach(() => {
  vi.resetAllMocks();
  db.close();
});

describe("E · openSession", () => {
  it("E1 no stored row -> absent, and nothing decrypted", () => {
    db.prepare(`DELETE FROM coinbase_credentials`).run();
    expect(cb.openSession(db)).toEqual({ kind: "absent" });
    expect(stubs.decrypt).not.toHaveBeenCalled();
  });

  it("E2 decrypt throws -> corrupted (the adapter writes nothing; the scheduler records the pause)", () => {
    stubs.decrypt.mockImplementation(() => {
      throw new Error("credentials_corrupted");
    });
    expect(cb.openSession(db)).toEqual({ kind: "corrupted" });
  });

  it("E3 a stored row -> a session over the decrypted credentials, and no network call", async () => {
    const s = open();
    expect(stubs.decrypt).toHaveBeenCalledWith({ ciphertext: Buffer.from("ct"), nonce: Buffer.from("nonce") });
    expect(stubs.listAccounts).not.toHaveBeenCalled();
    stubs.placeMarketBuy.mockResolvedValue({ ok: true, order_id: "ord-1" });
    expect(await cb.buy(s, 10, "USD")).toEqual({ ok: true, orderId: "ord-1" });
    expect(stubs.placeMarketBuy.mock.calls[0][0]).toEqual(CREDS);
  });
});

describe("E · getBalances", () => {
  it("E4 USD and BTC read; an absent USDC reads 0", async () => {
    const r = await cb.getBalances(open());
    expect(r).toEqual({ ok: true, balances: { usd: 12.5, usdc: 0, btc: 0.001 } });
  });

  it("E5 an unreadable balance reads 0; no BTC account reads null", async () => {
    stubs.listAccounts.mockResolvedValue({
      ok: true,
      status: 200,
      data: { accounts: [acct("USD", "not-a-number"), acct("USDC", "7")] },
    });
    const r = await cb.getBalances(open());
    expect(r).toEqual({ ok: true, balances: { usd: 0, usdc: 7, btc: null } });
  });
});

describe("E · classification, per operation", () => {
  const cases: Array<[status: number, cls: string]> = [
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "rate_limit"],
    [503, "rate_limit"],
    [400, "other"],
    [404, "other"],
    [0, "other"],
  ];
  for (const [status, cls] of cases) {
    it(`E6 status ${status} -> ${cls} on getBalances, buy and getOrder, with httpStatus and detail passed through`, async () => {
      const failure = { ok: false, status, error: `e-${status}` };
      stubs.listAccounts.mockResolvedValue(failure);
      stubs.placeMarketBuy.mockResolvedValue(failure);
      stubs.pollOrder.mockResolvedValue(failure);
      const s = open();
      const expected = { ok: false, errorClass: cls, httpStatus: status, detail: `e-${status}` };
      expect(await cb.getBalances(s)).toEqual(expected);
      expect(await cb.buy(s, 10, "USD")).toEqual(expected);
      expect(await cb.getOrder(s, "ord-1")).toEqual(expected);
    });
  }

  it("E7 a 400 on a WITHDRAWAL is withdraw_address_rejected; a 401 there is still auth", async () => {
    const s = open();
    await cb.getBalances(s);
    stubs.placeWithdraw.mockResolvedValueOnce({ ok: false, status: 400, error: "not whitelisted" });
    expect(await cb.withdraw(s, "bc1qdest", 0.001)).toEqual({
      ok: false, errorClass: "withdraw_address_rejected", httpStatus: 400, detail: "not whitelisted",
    });
    stubs.placeWithdraw.mockResolvedValueOnce({ ok: false, status: 401, error: "nope" });
    expect(await cb.withdraw(s, "bc1qdest", 0.001)).toMatchObject({ errorClass: "auth", httpStatus: 401 });
  });

  it("E8 a 400 on a withdrawal POLL is other, not an address refusal", async () => {
    const s = open();
    await cb.getBalances(s);
    stubs.pollWithdraw.mockResolvedValue({ ok: false, status: 400, error: "bad" });
    expect(await cb.getWithdrawal(s, "tx-1")).toMatchObject({ errorClass: "other", httpStatus: 400 });
  });
});

describe("E · status words", () => {
  const orderStates: Array<[raw: string, state: string]> = [
    ["FILLED", "filled"],
    ["CANCELLED", "cancelled"],
    ["EXPIRED", "expired"],
    ["FAILED", "failed"],
    ["OPEN", "pending"],
    ["PENDING", "pending"],
    ["SOMETHING_NEW", "pending"],
  ];
  for (const [raw, state] of orderStates) {
    it(`E9 order ${raw} -> ${state}, rawStatus kept`, async () => {
      stubs.pollOrder.mockResolvedValue({
        ok: true,
        order: { order_id: "ord-1", status: raw, filled_size: "0.002", filled_value: "150", filled_at: "2026-09-17T12:00:00Z" },
      });
      const r = await cb.getOrder(open(), "ord-1");
      expect(r).toEqual({
        ok: true,
        order: { state, rawStatus: raw, filledBtc: 0.002, filledUsd: 150, filledAt: Date.parse("2026-09-17T12:00:00Z") / 1000 },
      });
    });
  }

  it("E10 no fill time -> filledAt null; unparseable figures -> NaN, left for the scheduler", async () => {
    stubs.pollOrder.mockResolvedValue({
      ok: true,
      order: { order_id: "ord-1", status: "FILLED", filled_size: "x", filled_value: "y" },
    });
    const r = await cb.getOrder(open(), "ord-1");
    if (!r.ok) throw new Error("expected ok");
    expect(r.order.filledAt).toBeNull();
    expect(r.order.filledBtc).toBeNaN();
    expect(r.order.filledUsd).toBeNaN();
  });

  const withdrawalStates: Array<[raw: string, state: string]> = [
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["pending", "pending"],
    ["on_hold", "pending"],
  ];
  for (const [raw, state] of withdrawalStates) {
    it(`E11 withdrawal ${raw} -> ${state}`, async () => {
      const s = open();
      await cb.getBalances(s);
      stubs.pollWithdraw.mockResolvedValue({ ok: true, withdraw: { transaction_id: "tx-1", status: raw, network_tx_hash: "h" } });
      expect(await cb.getWithdrawal(s, "tx-1")).toEqual({ ok: true, withdrawal: { state, txHash: "h" } });
    });
  }

  it("E12 a completed withdrawal with no network hash -> txHash null", async () => {
    const s = open();
    await cb.getBalances(s);
    stubs.pollWithdraw.mockResolvedValue({ ok: true, withdraw: { transaction_id: "tx-1", status: "completed" } });
    expect(await cb.getWithdrawal(s, "tx-1")).toEqual({ ok: true, withdrawal: { state: "completed", txHash: null } });
  });
});

describe("E · the BTC account, per session", () => {
  it("E13 withdraw and getWithdrawal before any getBalances fail, and make no network call", async () => {
    const s = open();
    const unknown = { ok: false, errorClass: "other", httpStatus: 0, detail: "btc_account_unknown" };
    expect(await cb.withdraw(s, "bc1qdest", 0.001)).toEqual(unknown);
    expect(await cb.getWithdrawal(s, "tx-1")).toEqual(unknown);
    expect(stubs.listAccounts).not.toHaveBeenCalled();
    expect(stubs.placeWithdraw).not.toHaveBeenCalled();
    expect(stubs.pollWithdraw).not.toHaveBeenCalled();
  });

  it("E14 after getBalances, withdraw and getWithdrawal use that session's BTC UUID with no further listAccounts", async () => {
    const s = open();
    await cb.getBalances(s);
    stubs.placeWithdraw.mockResolvedValue({ ok: true, transaction_id: "tx-1" });
    stubs.pollWithdraw.mockResolvedValue({ ok: true, withdraw: { transaction_id: "tx-1", status: "pending" } });
    expect(await cb.withdraw(s, "bc1qdest", 0.001)).toEqual({ ok: true, withdrawalId: "tx-1" });
    await cb.getWithdrawal(s, "tx-1");
    expect(stubs.listAccounts).toHaveBeenCalledTimes(1);
    expect(stubs.placeWithdraw).toHaveBeenCalledWith(CREDS, "btc-uuid", "bc1qdest", 0.001);
    expect(stubs.pollWithdraw).toHaveBeenCalledWith(CREDS, "btc-uuid", "tx-1");
  });

  it("E15 a second session learns nothing from the first", async () => {
    await cb.getBalances(open());
    const second = open();
    expect(await cb.withdraw(second, "bc1qdest", 0.001)).toMatchObject({ detail: "btc_account_unknown" });
  });

  it("E16 a getBalances with no BTC account leaves withdraw failing as unknown", async () => {
    stubs.listAccounts.mockResolvedValue({ ok: true, status: 200, data: { accounts: [acct("USD", "1")] } });
    const s = open();
    await cb.getBalances(s);
    expect(await cb.withdraw(s, "bc1qdest", 0.001)).toMatchObject({ detail: "btc_account_unknown" });
    expect(stubs.placeWithdraw).not.toHaveBeenCalled();
  });
});
