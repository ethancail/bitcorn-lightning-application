import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleBaseBalance,
  handleBaseContractInfo,
  handleBaseContractState,
  handleBaseEvents,
} from "../../src/handlers/base";
import type { Env } from "../../src/lib/types";

// Real fixture for a Settled event from the smoke-test settle tx on Base
// Sepolia (block 41851567). Topics: [0]=Settled selector, [1]=sender,
// [2]=recipient, [3]=tradeRef. Data: amount=1_000_000, fee=0.
const SETTLED_FIXTURE_LOG = {
  address: "0xf1bc89974f8520b7f98e7cf0c689a7077af04c78",
  topics: [
    "0x4a69742b8c79b607e7d6ec3e71d19c5d19a09a822a87b2339620d028f570178b",
    "0x0000000000000000000000004842925cf6b6671e8e1a25892bdea0807b4814fd",
    "0x000000000000000000000000ed503244e4e9bfd30315c9a022150c8302af817b",
    "0xf3f9467ab985f6fdff87a5fa4bb6ff265fd303b413dc334748d2e1236384f155",
  ],
  data: "0x00000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000",
  blockHash: "0x080e7e1300e5f265205f0008266b7f6c6bf4e4ddc91c95b18e9779e16e3d73ec",
  blockNumber: "0x27e9aaf",
  transactionHash: "0x3826e7bc20027f791885f0cb08e09a05fc3fb89a603ea2896f14176fce3a4547",
  transactionIndex: "0x3",
  logIndex: "0x4",
  removed: false,
};

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
// `result` accepts any JSON-serializable value; eth_getLogs returns arrays.
type RpcResponse = { result?: unknown; error?: { code: number; message: string } };
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

// ─── /base/events ───────────────────────────────────────────────────────

describe("handleBaseEvents", () => {
    function eventsReq(body: unknown): Request {
        return new Request("https://w/base/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    }

    it("returns 400 for invalid JSON body", async () => {
        const r = new Request("https://w/base/events", { method: "POST", body: "not-json" });
        const res = await handleBaseEvents(r, makeEnv());
        expect(res.status).toBe(400);
        expect((await res.json() as any).error).toBe("invalid_json");
    });

    it("returns 400 for missing event field", async () => {
        const res = await handleBaseEvents(
            eventsReq({ from_block: 0, to_block: 1000 }),
            makeEnv(),
        );
        expect(res.status).toBe(400);
        expect((await res.json() as any).error).toBe("invalid_event");
    });

    it("returns 400 for non-allowlisted event", async () => {
        const res = await handleBaseEvents(
            eventsReq({ event: "OwnershipTransferred", from_block: 0, to_block: 1000 }),
            makeEnv(),
        );
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.error).toBe("event_not_allowed");
        expect(body.detail).toMatch(/Settled, FeeBpsUpdated, Paused, Unpaused/);
    });

    it("returns 400 for missing/invalid from_block", async () => {
        const res = await handleBaseEvents(
            eventsReq({ event: "Settled", to_block: 1000 }),
            makeEnv(),
        );
        expect(res.status).toBe(400);
        expect((await res.json() as any).error).toBe("invalid_from_block");
    });

    it("returns 400 when to_block < from_block", async () => {
        const res = await handleBaseEvents(
            eventsReq({ event: "Settled", from_block: 100, to_block: 50 }),
            makeEnv(),
        );
        expect(res.status).toBe(400);
        expect((await res.json() as any).error).toBe("invalid_to_block");
    });

    it("returns 400 when block range exceeds cap", async () => {
        const res = await handleBaseEvents(
            eventsReq({ event: "Settled", from_block: 0, to_block: 20_000 }),
            makeEnv(),
        );
        expect(res.status).toBe(400);
        expect((await res.json() as any).error).toBe("block_range_too_large");
    });

    it("returns 503 when SETTLEMENT_ROUTER_ADDRESS is unconfigured", async () => {
        const res = await handleBaseEvents(
            eventsReq({ event: "Settled", from_block: 0, to_block: 1000 }),
            makeEnv({ SETTLEMENT_ROUTER_ADDRESS: undefined }),
        );
        expect(res.status).toBe(503);
        expect((await res.json() as any).error).toBe("router_unconfigured");
    });

    it("returns 400 when explicit contract overrides to a non-allowlisted address", async () => {
        const res = await handleBaseEvents(
            eventsReq({
                event: "Settled",
                from_block: 0,
                to_block: 1000,
                contract: "0x0000000000000000000000000000000000000bad",
            }),
            makeEnv(),
        );
        expect(res.status).toBe(400);
        expect((await res.json() as any).error).toBe("contract_not_allowed");
    });

    it("decodes a real Settled event log from the smoke-test fixture", async () => {
        mockRpc({
            eth_getLogs: { result: [SETTLED_FIXTURE_LOG] },
            eth_blockNumber: { result: "0x27ea000" },
        });

        const res = await handleBaseEvents(
            eventsReq({ event: "Settled", from_block: 41_851_566, to_block: 41_851_600 }),
            makeEnv(),
        );
        expect(res.status).toBe(200);
        const body = await res.json() as any;

        expect(body.event).toBe("Settled");
        expect(body.contract).toBe(ROUTER.toLowerCase());
        expect(body.from_block).toBe(41_851_566);
        expect(body.to_block).toBe(41_851_600);
        expect(body.decode_errors).toEqual([]);

        expect(body.logs).toHaveLength(1);
        const log = body.logs[0];
        expect(log.block_number).toBe(0x27e9aaf);
        expect(log.tx_hash).toBe(SETTLED_FIXTURE_LOG.transactionHash);
        expect(log.log_index).toBe(4);
        expect(log.decoded).toEqual({
            sender: "0x4842925cf6b6671e8e1a25892bdea0807b4814fd",
            recipient: "0xed503244e4e9bfd30315c9a022150c8302af817b",
            trade_ref: "0xf3f9467ab985f6fdff87a5fa4bb6ff265fd303b413dc334748d2e1236384f155",
            amount: "1000000",
            fee: "0",
        });
    });

    it("returns an empty logs array when no events match", async () => {
        mockRpc({
            eth_getLogs: { result: [] },
            eth_blockNumber: { result: "0x100" },
        });
        const res = await handleBaseEvents(
            eventsReq({ event: "Settled", from_block: 0, to_block: 100 }),
            makeEnv(),
        );
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.logs).toEqual([]);
        expect(body.decode_errors).toEqual([]);
        expect(body.as_of_block_number).toBe(0x100);
    });

    it("decodes a FeeBpsUpdated event (no indexed params)", async () => {
        // FeeBpsUpdated(uint16 oldBps, uint16 newBps) — both unindexed.
        // Data: oldBps=0, newBps=25 (= 0x19, padded to 32 bytes each)
        const feeUpdateLog = {
            address: ROUTER.toLowerCase(),
            topics: ["0x8d10f5697a370f640ed5d474159aba3cc86e9bc260a5e9d2db875ad992cb1a1f"],
            data:
                "0x0000000000000000000000000000000000000000000000000000000000000000" +
                "0000000000000000000000000000000000000000000000000000000000000019",
            blockHash: "0x" + "11".repeat(32),
            blockNumber: "0x200",
            transactionHash: "0x" + "22".repeat(32),
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
        };
        mockRpc({
            eth_getLogs: { result: [feeUpdateLog] },
            eth_blockNumber: { result: "0x300" },
        });
        const res = await handleBaseEvents(
            eventsReq({ event: "FeeBpsUpdated", from_block: 0, to_block: 1000 }),
            makeEnv(),
        );
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.logs).toHaveLength(1);
        expect(body.logs[0].decoded).toEqual({
            old_bps: "0",
            new_bps: "25",
        });
    });

    it("decodes a Paused event (single unindexed address in data)", async () => {
        // Paused(address account) — unindexed account in data.
        // Data: account = 0x4842...4fd, left-padded to 32 bytes
        const pausedLog = {
            address: ROUTER.toLowerCase(),
            topics: ["0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258"],
            data: "0x0000000000000000000000004842925cf6b6671e8e1a25892bdea0807b4814fd",
            blockHash: "0x" + "33".repeat(32),
            blockNumber: "0x400",
            transactionHash: "0x" + "44".repeat(32),
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
        };
        mockRpc({
            eth_getLogs: { result: [pausedLog] },
            eth_blockNumber: { result: "0x500" },
        });
        const res = await handleBaseEvents(
            eventsReq({ event: "Paused", from_block: 0, to_block: 1000 }),
            makeEnv(),
        );
        const body = await res.json() as any;
        expect(body.logs[0].decoded).toEqual({
            account: "0x4842925cf6b6671e8e1a25892bdea0807b4814fd",
        });
    });

    it("calls eth_getLogs with the correct filter shape", async () => {
        const fetchSpy = mockRpc({
            eth_getLogs: { result: [] },
            eth_blockNumber: { result: "0x100" },
        });
        await handleBaseEvents(
            eventsReq({ event: "Settled", from_block: 100, to_block: 200 }),
            makeEnv(),
        );
        const getLogsCall = fetchSpy.mock.calls.find(
            (c) => JSON.parse(c[1]!.body as string).method === "eth_getLogs",
        );
        const filter = JSON.parse(getLogsCall![1]!.body as string).params[0];
        expect(filter.fromBlock).toBe("0x64");   // 100
        expect(filter.toBlock).toBe("0xc8");     // 200
        expect(filter.address).toBe(ROUTER);
        expect(filter.topics).toEqual([
            "0x4a69742b8c79b607e7d6ec3e71d19c5d19a09a822a87b2339620d028f570178b",
        ]);
    });

    it("captures per-log decode errors without failing the request", async () => {
        // Settled event with only 2 topics (selector + 1 indexed) instead of 4.
        // Should be captured in decode_errors, not raised.
        const malformedLog = {
            ...SETTLED_FIXTURE_LOG,
            topics: [
                "0x4a69742b8c79b607e7d6ec3e71d19c5d19a09a822a87b2339620d028f570178b",
                "0x0000000000000000000000004842925cf6b6671e8e1a25892bdea0807b4814fd",
            ],
        };
        mockRpc({
            eth_getLogs: { result: [malformedLog, SETTLED_FIXTURE_LOG] },
            eth_blockNumber: { result: "0x27ea000" },
        });
        const res = await handleBaseEvents(
            eventsReq({ event: "Settled", from_block: 0, to_block: 1000 }),
            makeEnv(),
        );
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        // The good log was decoded; the bad one captured in decode_errors.
        expect(body.logs).toHaveLength(1);
        expect(body.decode_errors).toHaveLength(1);
        expect(body.decode_errors[0].tx_hash).toBe(SETTLED_FIXTURE_LOG.transactionHash);
        expect(body.decode_errors[0].error).toMatch(/expected 3 indexed topics/);
    });

    it("surfaces upstream RPC errors as 502", async () => {
        mockRpc({
            eth_getLogs: { error: { code: -32602, message: "block range too large" } },
            eth_blockNumber: { result: "0x100" },
        });
        const res = await handleBaseEvents(
            eventsReq({ event: "Settled", from_block: 0, to_block: 1000 }),
            makeEnv(),
        );
        expect(res.status).toBe(502);
        expect((await res.json() as any).error).toBe("upstream_json_rpc_error");
    });

    it("uses to_block as as_of_block_number when tip-read fails (best-effort)", async () => {
        mockRpc({
            eth_getLogs: { result: [] },
            eth_blockNumber: { error: { code: -32000, message: "tip unavailable" } },
        });
        const res = await handleBaseEvents(
            eventsReq({ event: "Settled", from_block: 0, to_block: 999 }),
            makeEnv(),
        );
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.as_of_block_number).toBe(999);
    });
});
