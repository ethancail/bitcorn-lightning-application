// A refusal before initiation reaches the client as its own code (spec §4:
// "Each refusal is a distinct error code"), on all three execute routes:
// A (member Loop Out), B (admin Loop Out) and D (member Loop In).
//
// The handlers are called directly with the swap service, policy and node
// reads mocked: what is under test is only the handler's mapping of a
// SwapRefusalError to a 409 carrying `error: <code>`, instead of the generic
// 500 `{ error: message }` the dispatcher in index.ts gives any other throw.

import { PassThrough } from "stream";
import type { IncomingMessage, ServerResponse } from "http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwapRefusalError } from "./swapRefusal";

const MEMBER = "02" + "11".repeat(32);

const stubs = vi.hoisted(() => ({
  initiateSwap: vi.fn(),
  getSwapRequest: vi.fn(),
  getNodeInfo: vi.fn(),
}));

vi.mock("./swapService", () => ({
  initiateSwap: stubs.initiateSwap,
  getSwapRequest: stubs.getSwapRequest,
  getSwapExecution: vi.fn(),
  getSwapEvents: vi.fn(),
  listSwapRequests: vi.fn(),
  createLoopOutQuote: vi.fn(),
  createLoopInQuote: vi.fn(),
}));
vi.mock("./swapPolicy", () => ({
  checkMemberLoopOutPolicy: vi.fn(async () => ({ ok: true })),
  checkTreasuryLoopOutPolicy: vi.fn(async () => ({ ok: true })),
  checkMemberLoopInPolicy: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./loopProvider", () => ({ isLoopAvailable: vi.fn() }));
vi.mock("../api/read", () => ({ getNodeInfo: stubs.getNodeInfo }));
vi.mock("../utils/membership", () => ({ assertActiveMember: vi.fn() }));
vi.mock("../utils/role", () => ({ assertTreasury: vi.fn() }));
vi.mock("../utils/btc-address", () => ({ validateOnchainAddress: () => ({ ok: true }) }));

import {
  handleMemberLoopOut,
  handleMemberLoopIn,
  handleAdminLoopOut,
  handleMemberLoopInQuote,
  handleMemberLoopOutQuote,
  handleAdminLoopOutQuote,
} from "./swapRoutes";

function request(body: unknown): IncomingMessage {
  const s = new PassThrough();
  s.end(JSON.stringify(body));
  return s as unknown as IncomingMessage;
}

function response() {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead: (status: number) => { out.status = status; return res; },
    end: (raw: string) => { out.body = JSON.parse(raw); },
  } as unknown as ServerResponse;
  return { res, out };
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.getSwapRequest.mockReturnValue({ id: "r1", node_pubkey: MEMBER, amount_sat: 250_000, quoted_fee_sat: 2_035 });
  stubs.initiateSwap.mockRejectedValue(new SwapRefusalError("requote_required", "Get a new quote."));
});

describe("a SwapRefusalError is answered as 409 with its code", () => {
  it("A, member Loop Out", async () => {
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    const { res, out } = response();
    await handleMemberLoopOut(request({ swap_request_id: "r1", destination_address: "bc1qx" }), res);
    expect(out).toEqual({ status: 409, body: { error: "requote_required", detail: "Get a new quote." } });
  });

  it("D, member Loop In", async () => {
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    const { res, out } = response();
    await handleMemberLoopIn(request({ swap_request_id: "r1" }), res);
    expect(out).toEqual({ status: 409, body: { error: "requote_required", detail: "Get a new quote." } });
  });

  it("B, admin Loop Out", async () => {
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "treasury" });
    const { res, out } = response();
    await handleAdminLoopOut(request({ swap_request_id: "r1" }), res);
    expect(out).toEqual({ status: 409, body: { error: "requote_required", detail: "Get a new quote." } });
  });

  it("ruling g: a late loser's swap_not_executable is a 409 too", async () => {
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    stubs.initiateSwap.mockRejectedValue(
      new SwapRefusalError("swap_not_executable", "This quote has already been used or has ended. Get a new quote."),
    );
    const { res, out } = response();
    await handleMemberLoopOut(request({ swap_request_id: "r1", destination_address: "bc1qx" }), res);
    expect(out).toEqual({
      status: 409,
      body: { error: "swap_not_executable", detail: "This quote has already been used or has ended. Get a new quote." },
    });
  });

  it("any other error still propagates to the dispatcher", async () => {
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    stubs.initiateSwap.mockRejectedValue(new Error("Loop RPC LoopOut failed"));
    const { res } = response();
    await expect(handleMemberLoopIn(request({ swap_request_id: "r1" }), res)).rejects.toThrow("Loop RPC LoopOut failed");
  });
});

// F4 (spec §6): the quote response carries the ceilings, computed from the
// stored row (swapCeilings.ts is real here; only the service is mocked).
describe("F4: quote responses carry the ceilings", () => {
  const loopOutRow = {
    id: "r1", swap_type: "loop_out", amount_sat: 250_000,
    quoted_swap_fee_sat: 835, quoted_prepay_sat: 30_000, quoted_miner_fee_sat: 1_200,
  };
  const LO = {
    max_swap_fee_sat: 835, max_prepay_amt_sat: 30_000, max_miner_fee_sat: 1_200,
    max_swap_routing_fee_sat: 2_500, max_prepay_routing_fee_sat: 300,
  };

  it("A: the member Loop Out quote", async () => {
    const { createLoopOutQuote } = await import("./swapService");
    const { isLoopAvailable } = await import("./loopProvider");
    vi.mocked(isLoopAvailable).mockResolvedValue({ available: true });
    vi.mocked(createLoopOutQuote).mockResolvedValue({ swapRequest: loopOutRow as any, quote: { swap_fee_sat: 835, miner_fee_sat: 1_200 } as any });
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    const { res, out } = response();
    await handleMemberLoopOutQuote(request({ amount_sat: 250_000 }), res);
    expect(out.body.ceilings).toEqual(LO);
  });

  it("B: the admin Loop Out quote", async () => {
    const { createLoopOutQuote } = await import("./swapService");
    vi.mocked(createLoopOutQuote).mockResolvedValue({ swapRequest: loopOutRow as any, quote: { swap_fee_sat: 835, miner_fee_sat: 1_200 } as any });
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "treasury" });
    const { res, out } = response();
    await handleAdminLoopOutQuote(request({ amount_sat: 250_000 }), res);
    expect(out.body.ceilings).toEqual(LO);
  });

  it("D: the member Loop In quote", async () => {
    const { createLoopInQuote } = await import("./swapService");
    const { isLoopAvailable } = await import("./loopProvider");
    vi.mocked(isLoopAvailable).mockResolvedValue({ available: true });
    vi.mocked(createLoopInQuote).mockResolvedValue({
      swapRequest: { id: "r2", swap_type: "loop_in", amount_sat: 250_000, quoted_swap_fee_sat: 500, quoted_prepay_sat: null, quoted_miner_fee_sat: 900 } as any,
      quote: { total_fee_sat: 1_400 } as any,
    });
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    const { res, out } = response();
    await handleMemberLoopInQuote(request({ amount_sat: 250_000 }), res);
    expect(out.body.ceilings).toEqual({ max_swap_fee_sat: 500, max_miner_fee_sat: 900 });
  });

  // tt: the margin the web needs for Loop In's maximum rides BESIDE the
  // ceilings, never in them — the ceilings are echoed and hashed (F4).
  it("tt, D: the Loop In quote carries miner_fee_margin_pct outside ceilings", async () => {
    const { createLoopInQuote } = await import("./swapService");
    const { isLoopAvailable } = await import("./loopProvider");
    const { ENV } = await import("../config/env");
    vi.mocked(isLoopAvailable).mockResolvedValue({ available: true });
    vi.mocked(createLoopInQuote).mockResolvedValue({
      swapRequest: { id: "r2", swap_type: "loop_in", amount_sat: 250_000, quoted_swap_fee_sat: 500, quoted_prepay_sat: null, quoted_miner_fee_sat: 900 } as any,
      quote: { total_fee_sat: 1_400 } as any,
    });
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    const { res, out } = response();
    await handleMemberLoopInQuote(request({ amount_sat: 250_000 }), res);
    expect(typeof out.body.miner_fee_margin_pct).toBe("number");
    expect(out.body.miner_fee_margin_pct).toBe(ENV.loopMinerFeeMarginPct);
    expect(out.body.ceilings).toEqual({ max_swap_fee_sat: 500, max_miner_fee_sat: 900 });
  });
});

// F4 (spec §6): the execute handlers hand the echoed ceilings to initiateSwap.
describe("F4: execute handlers pass the echoed ceilings through", () => {
  const LO = {
    max_swap_fee_sat: 835, max_prepay_amt_sat: 30_000, max_miner_fee_sat: 1_200,
    max_swap_routing_fee_sat: 2_500, max_prepay_routing_fee_sat: 300,
  };

  it("A", async () => {
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    stubs.initiateSwap.mockResolvedValue({ id: "r1" });
    const { res } = response();
    await handleMemberLoopOut(request({ swap_request_id: "r1", destination_address: "bc1qx", ...LO }), res);
    expect(stubs.initiateSwap).toHaveBeenCalledWith("r1", "bc1qx", { swap_request_id: "r1", destination_address: "bc1qx", ...LO });
  });

  it("D", async () => {
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    stubs.initiateSwap.mockResolvedValue({ id: "r1" });
    const { res } = response();
    await handleMemberLoopIn(request({ swap_request_id: "r1", max_swap_fee_sat: 500, max_miner_fee_sat: 900 }), res);
    expect(stubs.initiateSwap).toHaveBeenCalledWith("r1", undefined, { swap_request_id: "r1", max_swap_fee_sat: 500, max_miner_fee_sat: 900 });
  });

  it("B", async () => {
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "treasury" });
    stubs.initiateSwap.mockResolvedValue({ id: "r1" });
    const { res } = response();
    await handleAdminLoopOut(request({ swap_request_id: "r1", ...LO }), res);
    expect(stubs.initiateSwap).toHaveBeenCalledWith("r1", undefined, { swap_request_id: "r1", ...LO });
  });
});

// B6 at the route: the member Loop Out quote no longer reads max_fee_sat, so a
// body carrying one reaches neither the quote nor the policy.
describe("the member Loop Out quote route takes no max_fee_sat (B6)", () => {
  it("a body max_fee_sat is passed to neither createLoopOutQuote nor the policy check", async () => {
    const { createLoopOutQuote } = await import("./swapService");
    const { checkMemberLoopOutPolicy } = await import("./swapPolicy");
    const { isLoopAvailable } = await import("./loopProvider");
    vi.mocked(isLoopAvailable).mockResolvedValue({ available: true });
    vi.mocked(createLoopOutQuote).mockResolvedValue({
      swapRequest: { id: "r1" } as any,
      quote: { swap_fee_sat: 835, miner_fee_sat: 1_200 } as any,
    });
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    const { res, out } = response();
    await handleMemberLoopOutQuote(request({ amount_sat: 250_000, max_fee_sat: 999_999 }), res);
    expect(out.status).toBe(200);
    expect(vi.mocked(createLoopOutQuote).mock.calls[0][0]).not.toHaveProperty("maxFeeSat");
    expect(vi.mocked(checkMemberLoopOutPolicy).mock.calls[0][0]).not.toHaveProperty("maxFeeSat");
  });
});

describe("the Loop In quote route answers Ruling Z's refusal as 409 with its code", () => {
  it("D quote: miner_fee_unknown", async () => {
    const { createLoopInQuote } = await import("./swapService");
    const { isLoopAvailable } = await import("./loopProvider");
    vi.mocked(isLoopAvailable).mockResolvedValue({ available: true });
    vi.mocked(createLoopInQuote).mockRejectedValue(
      new SwapRefusalError("miner_fee_unknown", "Try again in a few minutes."),
    );
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    const { res, out } = response();
    await handleMemberLoopInQuote(request({ amount_sat: 250_000 }), res);
    expect(out).toEqual({ status: 409, body: { error: "miner_fee_unknown", detail: "Try again in a few minutes." } });
  });
});
