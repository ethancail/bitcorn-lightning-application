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

  it("any other error still propagates to the dispatcher", async () => {
    stubs.getNodeInfo.mockReturnValue({ pubkey: MEMBER, node_role: "member", membership_status: "active" });
    stubs.initiateSwap.mockRejectedValue(new Error("Loop RPC LoopOut failed"));
    const { res } = response();
    await expect(handleMemberLoopIn(request({ swap_request_id: "r1" }), res)).rejects.toThrow("Loop RPC LoopOut failed");
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
