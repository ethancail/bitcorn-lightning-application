import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleBaseBalance,
  handleBaseContractInfo,
  handleBaseContractState,
} from "../../src/handlers/base";
import type { Env } from "../../src/lib/types";

const ROUTER = "0xF1Bc89974f8520b7f98e7cF0C689a7077aF04c78";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ALICE = "0x4842925CF6B6671e8e1A25892bdeA0807b4814fD";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BASE_SEPOLIA_RPC_URL: "https://mocked.rpc.example/v2/key",
    SETTLEMENT_ROUTER_ADDRESS: ROUTER,
    USDC_TOKEN_ADDRESS: USDC,
    SETTLEMENT_ROUTER_DEPLOY_BLOCK: "41851565",
    BASE_CHAIN_ID: "84532",
    ...overrides,
  } as Env;
}

// Mock fetch — each test wires up the RPC responses it expects.
type RpcResponse = { result?: string; error?: { code: number; message: string } };
function mockRpc(responsesByMethod: Record<string, RpcResponse | RpcResponse[]>) {
  const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    const method = body.method as string;
    const queue = responsesByMethod[method];
    if (!queue) {
      throw new Error(`mock fetch: no response wired for ${method}`);
    }
    const response = Array.isArray(queue) ? queue.shift()! : queue;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...response }), {
      status: 200,
    });
  });
  globalThis.fetch = fetchSpy as typeof fetch;
  return fetchSpy;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── /base/contract-info ────────────────────────────────────────────────

describe("handleBaseContractInfo", () => {
  it("returns full payload with live feeBps and paused state", async () => {
    mockRpc({
      eth_call: [
        { result: "0x0000000000000000000000000000000000000000000000000000000000000000" }, // feeBps = 0
        { result: "0x0000000000000000000000000000000000000000000000000000000000000000" }, // paused = false
      ],
      eth_blockNumber: { result: "0x27e9aaf" },
    });

    const res = await handleBaseContractInfo(makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settlement_router_address).toBe(ROUTER);
    expect(body.usdc_token_address).toBe(USDC);
    expect(body.chain_id).toBe(84532);
    expect(body.settlement_router_deploy_block).toBe(41851565);
    expect(body.current_fee_bps).toBe(0);
    expect(body.is_paused).toBe(false);
    expect(body.as_of_block_number).toBe(0x27e9aaf);
    expect(body.rpc_status).toBe("ok");
  });

  it("degrades gracefully when RPC is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const res = await handleBaseContractInfo(makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settlement_router_address).toBe(ROUTER);
    expect(body.current_fee_bps).toBeNull();
    expect(body.is_paused).toBeNull();
    expect(body.rpc_status).toBe("upstream_error");
  });

  it("returns unconfigured when no router address is set", async () => {
    const res = await handleBaseContractInfo(makeEnv({ SETTLEMENT_ROUTER_ADDRESS: undefined }));
    const body = (await res.json()) as any;
    expect(body.settlement_router_address).toBeNull();
    expect(body.rpc_status).toBe("unconfigured");
  });
});

// ─── /base/contract-state ───────────────────────────────────────────────

describe("handleBaseContractState", () => {
  function req(body: unknown): Request {
    return new Request("https://w/base/contract-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 400 for invalid JSON body", async () => {
    const r = new Request("https://w/base/contract-state", {
      method: "POST",
      body: "not-json",
    });
    const res = await handleBaseContractState(r, makeEnv());
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("invalid_json");
  });

  it("returns 400 for invalid contract address", async () => {
    const res = await handleBaseContractState(
      req({ contract: "not-an-address", signature: "owner()" }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("invalid_contract");
  });

  it("returns 400 for non-allowlisted contract", async () => {
    const res = await handleBaseContractState(
      req({ contract: "0x0000000000000000000000000000000000000bad", signature: "owner()" }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("contract_not_allowed");
  });

  it("returns 400 for non-allowlisted signature", async () => {
    const res = await handleBaseContractState(
      req({ contract: ROUTER, signature: "selfDestruct()" }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("signature_not_allowed");
  });

  it("returns router owner() for an allowlisted call", async () => {
    mockRpc({
      eth_call: { result: "0x000000000000000000000000" + ALICE.slice(2).toLowerCase() },
      eth_blockNumber: { result: "0x27e9aaf" },
    });
    const res = await handleBaseContractState(
      req({ contract: ROUTER, signature: "owner()" }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.contract).toBe(ROUTER.toLowerCase());
    expect(body.signature).toBe("owner()");
    expect(body.result.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(body.as_of_block_number).toBe(0x27e9aaf);
  });

  it("returns router feeBps() as a string for JSON-safe BigInt serialization", async () => {
    mockRpc({
      eth_call: { result: "0x0000000000000000000000000000000000000000000000000000000000000019" },
      eth_blockNumber: { result: "0x27e9aaf" },
    });
    const res = await handleBaseContractState(
      req({ contract: ROUTER, signature: "feeBps()" }),
      makeEnv(),
    );
    const body = (await res.json()) as any;
    expect(body.result).toBe("25"); // serializeValue stringifies BigInt
  });

  it("returns paused() boolean", async () => {
    mockRpc({
      eth_call: { result: "0x0000000000000000000000000000000000000000000000000000000000000001" },
      eth_blockNumber: { result: "0x1" },
    });
    const res = await handleBaseContractState(
      req({ contract: ROUTER, signature: "paused()" }),
      makeEnv(),
    );
    const body = (await res.json()) as any;
    expect(body.result).toBe(true);
  });

  it("calls USDC balanceOf with the supplied address arg", async () => {
    const balanceHex = "0x0000000000000000000000000000000000000000000000000000000001312d00"; // 20e6
    const fetchSpy = mockRpc({
      eth_call: { result: balanceHex },
      eth_blockNumber: { result: "0x27e9aaf" },
    });
    const res = await handleBaseContractState(
      req({ contract: USDC, signature: "balanceOf(address)", args: [ALICE] }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result).toBe("20000000");
    // Confirm the eth_call body carried the encoded selector + arg.
    const callBody = JSON.parse(fetchSpy.mock.calls.find(
      (c) => JSON.parse(c[1]!.body as string).method === "eth_call",
    )![1]!.body as string);
    expect(callBody.params[0].to).toBe(USDC);
    expect(callBody.params[0].data.startsWith("0x70a08231")).toBe(true);
    expect(callBody.params[0].data.endsWith(ALICE.slice(2).toLowerCase())).toBe(true);
  });
});

// ─── /base/balance ──────────────────────────────────────────────────────

describe("handleBaseBalance", () => {
  function balanceReq(address: string, token?: string): Request {
    const params = new URLSearchParams({ address });
    if (token) params.set("token", token);
    return new Request(`https://w/base/balance?${params.toString()}`);
  }

  it("defaults to USDC when token is omitted", async () => {
    const fetchSpy = mockRpc({
      eth_call: [
        { result: "0x0000000000000000000000000000000000000000000000000000000001312d00" }, // 20e6
        { result: "0x0000000000000000000000000000000000000000000000000000000000000006" }, // 6 decimals
      ],
      eth_blockNumber: { result: "0x27e9aaf" },
    });
    const res = await handleBaseBalance(balanceReq(ALICE), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(body.balance_raw).toBe("20000000");
    expect(body.decimals).toBe(6);
    expect(body.balance_human).toBe("20.000000");
    expect(body.token_symbol).toBe("USDC");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("returns 400 for invalid address query param", async () => {
    const r = new Request("https://w/base/balance?address=nope");
    const res = await handleBaseBalance(r, makeEnv());
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("invalid_address");
  });

  it("returns 400 for an explicit non-allowlisted token", async () => {
    const res = await handleBaseBalance(
      balanceReq(ALICE, "0x0000000000000000000000000000000000000bad"),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("token_not_allowed");
  });

  it("returns 503 when USDC is unconfigured", async () => {
    const res = await handleBaseBalance(
      balanceReq(ALICE),
      makeEnv({ USDC_TOKEN_ADDRESS: undefined }),
    );
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toBe("usdc_unconfigured");
  });

  it("formats balance_human with leading zeros after the decimal", async () => {
    mockRpc({
      eth_call: [
        { result: "0x00000000000000000000000000000000000000000000000000000000000f4240" }, // 1e6 = 1 USDC
        { result: "0x0000000000000000000000000000000000000000000000000000000000000006" }, // 6 decimals
      ],
      eth_blockNumber: { result: "0x27e9aaf" },
    });
    const res = await handleBaseBalance(balanceReq(ALICE), makeEnv());
    const body = (await res.json()) as any;
    expect(body.balance_human).toBe("1.000000");
  });

  it("surfaces upstream RPC errors as 502", async () => {
    mockRpc({
      eth_call: { error: { code: -32000, message: "internal upstream error" } },
      eth_blockNumber: { result: "0x1" },
    });
    const res = await handleBaseBalance(balanceReq(ALICE), makeEnv());
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error).toBe("upstream_json_rpc_error");
  });
});
