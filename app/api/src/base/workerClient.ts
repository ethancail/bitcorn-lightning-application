// Typed wrappers around workerFetch for the three /base/* endpoints.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7
// Worker contract: cloudflare-worker/src/handlers/base.ts (PR #197)
//
// All callers go through this module rather than calling workerFetch
// directly so:
//   1. Response shape parsing and HTTP-status handling are uniform.
//   2. The Worker's response schema is type-checked at the API boundary.
//   3. Tests can mock this module without touching workerFetch's
//      JWT-refresh logic.

import { workerFetch, WorkerFetchError } from "../lib/workerFetch";
import type {
    WorkerBalanceResponse,
    WorkerContractInfoResponse,
    WorkerContractStateResponse,
} from "./types";

export class BaseWorkerError extends Error {
    constructor(
        message: string,
        public readonly kind:
            | "transport_error"
            | "worker_not_configured"
            | "auth_error"
            | "http_error"
            | "malformed_response",
        public readonly status?: number,
    ) {
        super(message);
        this.name = "BaseWorkerError";
    }
}

// -----------------------------------------------------------------------
// GET /base/contract-info  (public; no Bearer required)
// -----------------------------------------------------------------------

export async function fetchContractInfo(): Promise<WorkerContractInfoResponse> {
    return doFetch<WorkerContractInfoResponse>("/base/contract-info", { method: "GET" });
}

// -----------------------------------------------------------------------
// GET /base/balance?address=...&token=USDC  (payment-scope)
// -----------------------------------------------------------------------

export async function fetchUsdcBalance(walletAddress: string): Promise<WorkerBalanceResponse> {
    const params = new URLSearchParams({ address: walletAddress, token: "USDC" });
    return doFetch<WorkerBalanceResponse>(`/base/balance?${params.toString()}`, { method: "GET" });
}

// -----------------------------------------------------------------------
// POST /base/contract-state  (payment-scope)
// -----------------------------------------------------------------------

export async function fetchContractStateCall(
    contract: string,
    signature: string,
    args: unknown[] = [],
): Promise<WorkerContractStateResponse> {
    return doFetch<WorkerContractStateResponse>("/base/contract-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract, signature, args }),
    });
}

/**
 * Read the SettlementRouter's feeRecipient(). This is not part of the
 * /base/contract-info response (which gives feeBps + paused but not the
 * fee recipient), so the sync loop chains a second call via /base/contract-state.
 */
export async function fetchFeeRecipient(routerAddress: string): Promise<string> {
    const resp = await fetchContractStateCall(routerAddress, "feeRecipient()", []);
    if (typeof resp.result !== "string") {
        throw new BaseWorkerError(
            `expected feeRecipient() to return an address string, got ${typeof resp.result}`,
            "malformed_response",
        );
    }
    return resp.result;
}

// -----------------------------------------------------------------------
// Shared transport
// -----------------------------------------------------------------------

async function doFetch<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await workerFetch(path, init);
    } catch (err) {
        if (err instanceof WorkerFetchError) {
            const kind = err.reason === "not_configured" ? "worker_not_configured" : "transport_error";
            throw new BaseWorkerError(err.message, kind);
        }
        throw err;
    }

    if (response.status === 401 || response.status === 403) {
        const body = await safeJson(response);
        throw new BaseWorkerError(
            `Worker rejected request (HTTP ${response.status}): ${formatErrorBody(body)}`,
            "auth_error",
            response.status,
        );
    }

    if (!response.ok) {
        const body = await safeJson(response);
        throw new BaseWorkerError(
            `Worker HTTP ${response.status} on ${path}: ${formatErrorBody(body)}`,
            "http_error",
            response.status,
        );
    }

    let parsed: unknown;
    try {
        parsed = await response.json();
    } catch {
        throw new BaseWorkerError(`Worker returned non-JSON on ${path}`, "malformed_response");
    }
    return parsed as T;
}

async function safeJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function formatErrorBody(body: unknown): string {
    if (body && typeof body === "object") {
        const b = body as { error?: string; detail?: string };
        return `${b.error ?? "unknown"} (${b.detail ?? ""})`;
    }
    return "no body";
}
