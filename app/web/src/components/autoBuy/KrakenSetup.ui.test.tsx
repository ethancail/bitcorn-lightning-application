// kraken-autobuy P4e: the provider choice, the Kraken card, and the enable gate.
//
// The REAL api functions in client.ts run, against a stubbed global fetch: no
// request leaves the process (the suite's network guard stays as it is; this
// file replaces fetch with a stub per case and restores it after). So these
// cases also pin client.ts's new requests: method, path and body.
//
// No React Testing Library: createRoot inside act(), as StrategyTab's tests do.
// Assertions name the content that MUST be present, never only its absence.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import type { AutoBuyStatus } from "../../api/client";
import ProviderChoice from "./ProviderChoice";
import KrakenCard from "./KrakenCard";
import { canEnableAutoBuy } from "../../autoBuy/enableGate";

type Req = { method: string; path: string; body: unknown };
let requests: Req[];
let respond: (r: Req) => { status: number; body: unknown };

const NODE_ADDRESS = "bcrt1qnodeaddressxyz";

function status(over: {
  provider?: "coinbase" | "kraken";
  kraken?: AutoBuyStatus["kraken_credentials"];
  coinbase?: boolean;
  whitelisted?: boolean;
  failures?: number;
  snapshot?: AutoBuyStatus["balance_snapshot"];
  funds?: AutoBuyStatus["funds"];
} = {}): AutoBuyStatus {
  return {
    config: {
      enabled: false, base_unit_usd: 100, frequency: "weekly",
      zone_multipliers: { extreme_buy: 3, undervalued: 2, fair_value: 1, elevated: 0.5, overvalued: 0.25, extreme_sell: 0 },
      currency_preference: "usd_only", withdraw_address: NODE_ADDRESS,
      withdraw_address_whitelisted_at: over.whitelisted === false ? null : 1_800_000_000,
      sweep_day_of_week: 0, consecutive_failures: over.failures ?? 0, paused_reason: null,
      last_run_at: null, next_run_at: null, provider: over.provider ?? "coinbase",
    },
    credentials: over.coinbase ? { key_name: "k", connected_at: 1, last_verified_at: null } : null,
    kraken_credentials: over.kraken ?? null,
    balance_snapshot: over.snapshot ?? null,
    funds: over.funds ?? null,
    in_flight: [], recent: [], missed: null, missed_error: null,
  } as AutoBuyStatus;
}

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? "";
const btn = (label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

async function render(node: React.ReactElement): Promise<void> {
  await act(async () => { root.render(node); });
}
async function click(el: Element | undefined): Promise<void> {
  if (!el) throw new Error("element not found");
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}
async function type(label: string, value: string): Promise<void> {
  const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  requests = [];
  respond = () => ({ status: 200, body: { ok: true } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, "http://stub").pathname;
    const r: Req = { method: (init.method ?? "GET").toUpperCase(), path, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    requests.push(r);
    const out = respond(r);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ProviderChoice", () => {
  it("W1 shows the active exchange and switches to the other: POST /api/autobuy/provider {provider}, then refreshes", async () => {
    const onRefresh = vi.fn(async () => {});
    respond = () => ({ status: 200, body: { ok: true, provider: "kraken", changed: true } });
    await render(<ProviderChoice status={status()} onRefresh={onRefresh} />);
    expect(host.querySelector('[data-testid="active-provider"]')?.textContent).toBe("Coinbase");
    await click(btn("Switch to Kraken"));
    expect(requests).toEqual([{ method: "POST", path: "/api/autobuy/provider", body: { provider: "kraken" } }]);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Switched to Kraken. Auto-Buy is paused until you enable it again.");
  });

  it("W2 a 409 (buys or withdrawals in progress) says so with the counts, and does not refresh", async () => {
    const onRefresh = vi.fn(async () => {});
    respond = () => ({ status: 409, body: { error: "provider_switch_in_flight", in_flight_runs: 2, in_flight_sweeps: 1 } });
    await render(<ProviderChoice status={status({ provider: "kraken" })} onRefresh={onRefresh} />);
    await click(btn("Switch to Coinbase"));
    expect(text()).toContain("You can't switch yet: 2 buys and 1 withdrawal are still in progress on Kraken.");
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("KrakenCard — not connected", () => {
  it("W3 lists the five permissions and the node's address; the private key is a password field; connecting POSTs both and clears them", async () => {
    const onRefresh = vi.fn(async () => {});
    respond = () => ({ status: 200, body: { ok: true, connected_at: 1, address_status: "not_found", minimum_warning: null } });
    await render(<KrakenCard status={status({ provider: "kraken" })} onRefresh={onRefresh} />);
    expect(Array.from(host.querySelectorAll('[data-testid="kraken-permissions"] li')).map((li) => li.textContent)).toEqual([
      "Query Funds", "Withdraw Funds", "Query Open Orders & Trades", "Query Closed Orders & Trades",
      "Create & Modify Orders (called Modify Orders on some screens)",
    ]);
    expect(host.querySelector('[data-testid="node-address"]')?.textContent).toBe(NODE_ADDRESS);
    expect((host.querySelector('input[aria-label="Kraken private key"]') as HTMLInputElement).type).toBe("password");

    await type("Kraken API key", " PUBLIC-KEY ");
    await type("Kraken private key", "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0");
    await click(btn("Connect Kraken"));
    expect(requests).toEqual([{
      method: "POST", path: "/api/autobuy/kraken/credentials",
      body: { api_key: "PUBLIC-KEY", api_secret: "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0" },
    }]);
    expect(text()).toContain("Connected. Save your node's address (below) as a Bitcoin withdrawal address in Kraken, then press Verify here.");
    expect((host.querySelector('input[aria-label="Kraken private key"]') as HTMLInputElement).value).toBe("");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("W3b the setup order saves the address before the key is connected (DOC2); the permissions sit in the create-the-key step (S2), indented (S3)", async () => {
    await render(<KrakenCard status={status({ provider: "kraken" })} onRefresh={vi.fn(async () => {})} />);
    const steps = Array.from(host.querySelectorAll('[data-testid="kraken-setup-steps"] > li'));
    expect(steps.map((li) => (li.textContent ?? "").slice(0, 30))).toEqual([
      "If Kraken's Global Settings Lo",
      "Save your node's address (belo",
      "In Kraken, go to Settings → AP",
      "Paste the API key and private ",
      "Set up one recurring ACH depos",
    ]);
    const perms = steps[2].querySelector('[data-testid="kraken-permissions"]') as HTMLElement | null;
    expect(perms).not.toBeNull();
    expect(steps[2].textContent).toContain('Do not give it "Add withdrawal addresses" or "Update withdrawal addresses".');
    expect(perms!.style.paddingLeft).toBe("20px");
  });

  it("W4 the server's refusals read plainly, naming the permissions from the structured body", async () => {
    await render(<KrakenCard status={status({ provider: "kraken" })} onRefresh={vi.fn(async () => {})} />);
    await type("Kraken API key", "K");
    await type("Kraken private key", "S");

    respond = () => ({ status: 400, body: { ok: false, error: "key_permissions_too_broad", extra: ["add-withdraw-address"] } });
    await click(btn("Connect Kraken"));
    expect(text()).toContain("This key has permissions it must not have: add-withdraw-address.");

    respond = () => ({ status: 400, body: { ok: false, error: "key_permissions_missing", missing: ["query-closed-trades"] } });
    await click(btn("Connect Kraken"));
    expect(text()).toContain("This key is missing: query-closed-trades.");

    respond = () => ({ status: 409, body: { error: "ambiguous_withdraw_method", method_ids: ["a", "b"] } });
    await click(btn("Connect Kraken"));
    expect(text()).toContain("saved under more than one Kraken withdrawal method");
  });

  it("W5 a minimum warning in the response is shown with its figures", async () => {
    respond = () => ({ status: 200, body: { ok: true, connected_at: 1, address_status: "matched", minimum_warning: { below: true, smallest_buy_usd: 5, minimum_usd: 9.99, price_usd: 99900 } } });
    await render(<KrakenCard status={status({ provider: "kraken" })} onRefresh={vi.fn(async () => {})} />);
    await type("Kraken API key", "K");
    await type("Kraken private key", "S");
    await click(btn("Connect Kraken"));
    expect(text()).toContain("Your smallest buy ($5.00) is below Kraken's minimum (about $9.99 at today's price). Those buys will be skipped, not rounded up.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("KrakenCard — connected", () => {
  it("W6 Verify POSTs and shows balances; Disconnect takes two clicks and then DELETEs", async () => {
    const onRefresh = vi.fn(async () => {});
    respond = (r) => r.path.endsWith("/verify")
      ? { status: 200, body: { ok: true, last_verified_at: 2, address_status: "matched", balances: { usd: 200, usdc: 0, btc: 0.002 }, minimum_warning: null } }
      : { status: 200, body: { ok: true } };
    await render(<KrakenCard status={status({ provider: "kraken", kraken: { connected_at: 1_800_000_000, last_verified_at: null, address_matched: true } })} onRefresh={onRefresh} />);
    expect(host.querySelector('[data-testid="address-state"]')?.textContent).toBe("Your node's address is saved and verified on Kraken.");

    await click(btn("Verify"));
    expect(requests[0]).toEqual({ method: "POST", path: "/api/autobuy/kraken/credentials/verify", body: undefined });
    expect(host.querySelector('[data-testid="kraken-balances"]')?.textContent).toBe("USD $200.00 · USDC $0.00 · BTC 0.00200000");

    await click(btn("Disconnect"));
    expect(requests).toHaveLength(1); // nothing sent on the first click
    await click(btn("Confirm disconnect"));
    expect(requests[1]).toEqual({ method: "DELETE", path: "/api/autobuy/kraken/credentials", body: undefined });
  });

  it("W6b connected but the address not matched: the node's address and what to do are shown", async () => {
    await render(<KrakenCard status={status({ provider: "kraken", kraken: { connected_at: 1, last_verified_at: null, address_matched: false } })} onRefresh={vi.fn(async () => {})} />);
    expect(host.querySelector('[data-testid="address-state"]')?.textContent).toContain("Save your node's address (below) as a Bitcoin withdrawal address in Kraken");
    expect(host.querySelector('[data-testid="node-address"]')?.textContent).toBe(NODE_ADDRESS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("KrakenCard — buys left (P5, G11)", () => {
  const CONNECTED = { connected_at: 1_800_000_000, last_verified_at: null, address_matched: true };
  const READ_AT = 1_894_017_600;
  const asOf = (stale: boolean) => `As of ${new Date(READ_AT * 1000).toLocaleString()}${stale ? " — may be out of date" : ""}.`;
  const funds = (over: Partial<NonNullable<AutoBuyStatus["funds"]>> = {}) => ({
    currency: "USD" as const, usd_available: 150, next_buy_usd: 100, multiplier: 1, buys_covered: 1, read_at: READ_AT, stale: false, ...over,
  });
  const snap = (stale: boolean) => ({ usd_available: 150, usdc_available: 1000, btc_available: 0, read_at: READ_AT, stale });
  const fundsLine = () => host.querySelector('[data-testid="kraken-funds"]')?.textContent;

  it("W8 shows the API's buys-left figures (USD, next buy), as of the read — never recomputed from USDC", async () => {
    await render(<KrakenCard status={status({ provider: "kraken", kraken: CONNECTED, snapshot: snap(false), funds: funds() })} onRefresh={vi.fn(async () => {})} />);
    expect(fundsLine()).toBe(`About 1 buy left: $150.00 USD available, next buy $100.00. ${asOf(false)}`);
    expect(requests).toEqual([]); // the card makes no request to show it
  });

  it("W9 a stale snapshot says so; no snapshot says how to get one; a zero zone says it buys nothing", async () => {
    await render(<KrakenCard status={status({ provider: "kraken", kraken: CONNECTED, snapshot: snap(true), funds: funds({ stale: true, buys_covered: 3, usd_available: 300 }) })} onRefresh={vi.fn(async () => {})} />);
    expect(fundsLine()).toBe(`About 3 buys left: $300.00 USD available, next buy $100.00. ${asOf(true)}`);

    await render(<KrakenCard status={status({ provider: "kraken", kraken: CONNECTED })} onRefresh={vi.fn(async () => {})} />);
    expect(fundsLine()).toBe("No balance read yet. Press Verify.");

    await render(<KrakenCard status={status({ provider: "kraken", kraken: CONNECTED, snapshot: snap(false), funds: funds({ buys_covered: null, next_buy_usd: 0, multiplier: 0 }) })} onRefresh={vi.fn(async () => {})} />);
    expect(fundsLine()).toBe(`$150.00 USD available. The current zone buys nothing. ${asOf(false)}`);
  });

  it("W10 a snapshot without a valuation shows the USD, and says buys left needs today's valuation", async () => {
    await render(<KrakenCard status={status({ provider: "kraken", kraken: CONNECTED, snapshot: snap(false) })} onRefresh={vi.fn(async () => {})} />);
    expect(fundsLine()).toBe(`$150.00 USD available. Buys left can't be worked out without today's valuation. ${asOf(false)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the enable gate follows the active provider", () => {
  it("W7 Kraken: a matched Kraken key enables, a Coinbase key does not; Coinbase: the reverse", () => {
    const matched = { connected_at: 1, last_verified_at: null, address_matched: true };
    expect(canEnableAutoBuy(status({ provider: "kraken", kraken: matched }))).toBe(true);
    expect(canEnableAutoBuy(status({ provider: "kraken", kraken: { ...matched, address_matched: false } }))).toBe(false);
    expect(canEnableAutoBuy(status({ provider: "kraken", coinbase: true }))).toBe(false);
    expect(canEnableAutoBuy(status({ provider: "coinbase", coinbase: true }))).toBe(true);
    expect(canEnableAutoBuy(status({ provider: "coinbase", kraken: matched }))).toBe(false);
  });

  it("W7b both still need the whitelist and fewer than 3 failures", () => {
    const matched = { connected_at: 1, last_verified_at: null, address_matched: true };
    expect(canEnableAutoBuy(status({ provider: "kraken", kraken: matched, whitelisted: false }))).toBe(false);
    expect(canEnableAutoBuy(status({ provider: "kraken", kraken: matched, failures: 3 }))).toBe(false);
  });
});
