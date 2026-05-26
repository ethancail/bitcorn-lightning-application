// SettlementForm — initiates a settle() through the user's connected wallet.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §8.4
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md §5, §8
//
// Flow (two-step approve + settle for v1 — permit deferred):
//   1. User enters recipient, amount, optional trade reference
//   2. Fee preview rendered from /contract-state (FeeDisplay variant="preview")
//   3. User clicks Send USDC
//   4. wagmi writeContract(approve(SettlementRouter, amount))
//   5. wait for receipt
//   6. wagmi writeContract(settle(recipient, amount, tradeRefBytes32))
//   7. Returns tx hash → write Pending entry to localStorage → reset form
//
// Per spec §5: the flow adapts to the connected wallet by virtue of
// wagmi's writeContract being wallet-agnostic. The user sees their
// wallet's native prompt (Coinbase Smart Wallet's passkey UI, MetaMask's
// confirm modal, or WalletConnect's mobile-deeplink/QR flow) — we do not
// wrap or interstitial.

import { useCallback, useMemo, useState } from "react";
import { keccak256, toBytes, type Hex } from "viem";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import FeeDisplay from "./FeeDisplay";
import {
  ERC20_ABI,
  SETTLEMENT_ROUTER_ABI,
  USDC_ADDRESS_BY_CHAIN,
  parseUsdcAmount,
  formatUsdc,
} from "../contract";
import { DEFAULT_CHAIN } from "../wagmi";
import { addPendingEntry } from "../pendingStore";
import type { ContractStateResponse } from "../client";

type FormStep =
  | { kind: "idle" }
  | { kind: "validation_error"; message: string }
  | { kind: "approving"; txHash?: Hex }
  | { kind: "settling"; txHash?: Hex }
  | { kind: "submitted"; txHash: Hex }
  | { kind: "error"; message: string };

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

function isAddressLike(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

/**
 * Compute the bytes32 trade reference for the settle() call.
 *
 * Spec §8.4 #3 prescribes: free-text input → keccak256 → bytes32. Empty
 * input maps to the zero bytes32 (the contract accepts this as a sentinel
 * "no reference").
 */
function computeTradeRef(input: string): Hex {
  const trimmed = input.trim();
  if (!trimmed) return ZERO_BYTES32;
  return keccak256(toBytes(trimmed));
}

export default function SettlementForm({
  contractState,
  memberPubkey,
  onSubmitted,
  onClose,
}: {
  contractState: ContractStateResponse | null;
  memberPubkey: string;
  onSubmitted: () => void;
  onClose: () => void;
}) {
  const { address: walletAddress, isConnected } = useAccount();
  const chainId = useChainId();
  // Pin the public client to the settlement chain so waitForTransactionReceipt
  // polls Base Sepolia regardless of the connector's current chain.
  const publicClient = usePublicClient({ chainId: DEFAULT_CHAIN.id });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [step, setStep] = useState<FormStep>({ kind: "idle" });

  // Always resolve USDC against the chain we actually settle on
  // (DEFAULT_CHAIN), not useChainId() — for a WalletConnect-connected
  // mobile wallet the two can diverge (the wallet may sit on Ethereum
  // mainnet while wagmi reports the config default), which previously
  // built a Base-Sepolia-USDC approve that the wallet tried to execute
  // on mainnet. The submit path below forces a chain switch before
  // sending so the wallet and this address always agree.
  const usdcAddress = USDC_ADDRESS_BY_CHAIN[DEFAULT_CHAIN.id];
  const routerAddress = contractState?.settlement_router_address as `0x${string}` | undefined;
  const feeBps = contractState?.current_fee_bps ?? 0;
  const isPaused = contractState?.is_paused ?? false;

  // Fee preview against the input amount. Computed against the cached
  // feeBps — the on-chain rate at execution wins, per spec §5.
  const feePreviewUnits = useMemo(() => {
    const units = parseUsdcAmount(amount);
    if (units === null || feeBps === 0) return 0n;
    return (units * BigInt(feeBps)) / 10000n;
  }, [amount, feeBps]);
  const feePreviewHuman = formatUsdc(feePreviewUnits);

  const reset = useCallback(() => {
    setRecipient("");
    setAmount("");
    setReference("");
    setStep({ kind: "idle" });
  }, []);

  const submitting =
    step.kind === "approving" || step.kind === "settling";

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!walletAddress) {
        setStep({ kind: "validation_error", message: "Connect a wallet first." });
        return;
      }
      if (!usdcAddress) {
        setStep({ kind: "validation_error", message: `USDC address not configured for chain ${chainId}.` });
        return;
      }
      if (!routerAddress) {
        setStep({ kind: "validation_error", message: "Contract state not loaded yet; try again in a moment." });
        return;
      }
      if (isPaused) {
        setStep({ kind: "validation_error", message: "Settlements are paused. Try again later." });
        return;
      }
      const recipientTrimmed = recipient.trim();
      if (!isAddressLike(recipientTrimmed)) {
        setStep({ kind: "validation_error", message: "Recipient must be a 0x address." });
        return;
      }
      const recipientAddress = recipientTrimmed.toLowerCase() as `0x${string}`;
      const amountUnits = parseUsdcAmount(amount);
      if (amountUnits === null || amountUnits === 0n) {
        setStep({ kind: "validation_error", message: "Amount must be a positive USDC value (up to 6 decimals)." });
        return;
      }
      if (!publicClient) {
        setStep({ kind: "validation_error", message: "Wallet RPC not available; try refreshing." });
        return;
      }
      const tradeRef = computeTradeRef(reference);

      try {
        // Force the wallet onto the settlement chain BEFORE building any
        // transaction. Without this, a WalletConnect-connected mobile
        // wallet can sit on a different chain (e.g. Ethereum mainnet) and
        // execute the approve/settle there — calling the Base Sepolia USDC
        // address on the wrong network, wasting real gas and failing. We
        // switch first; if the wallet rejects or can't add Base Sepolia,
        // the error surfaces here rather than after a bad signature.
        if (chainId !== DEFAULT_CHAIN.id) {
          await switchChainAsync({ chainId: DEFAULT_CHAIN.id });
        }

        // Skip the approve if the router already has sufficient allowance
        // (spec §8.4 #6: "If yes [already approved]: proceed to settle").
        // Beyond saving a redundant transaction, this avoids a real
        // testnet race: submitting settle immediately after the approve
        // confirms can hit a wallet whose gas-estimation RPC still sees
        // the pre-approve allowance, mis-estimates the call as a revert,
        // and falls back to a max gas limit the RPC then rejects
        // ("exceeds max transaction gas limit"). Reading allowance first
        // and skipping the approve when it's already set sidesteps that.
        const currentAllowance = (await publicClient.readContract({
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [walletAddress, routerAddress],
        })) as bigint;

        if (currentAllowance < amountUnits) {
          setStep({ kind: "approving" });
          const approveHash = await writeContractAsync({
            chainId: DEFAULT_CHAIN.id,
            address: usdcAddress,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [routerAddress, amountUnits],
          });
          setStep({ kind: "approving", txHash: approveHash });
          await publicClient.waitForTransactionReceipt({ hash: approveHash });
        }

        setStep({ kind: "settling" });
        const settleHash = await writeContractAsync({
          chainId: DEFAULT_CHAIN.id,
          address: routerAddress,
          abi: SETTLEMENT_ROUTER_ABI,
          functionName: "settle",
          args: [recipientAddress, amountUnits, tradeRef],
        });
        setStep({ kind: "settling", txHash: settleHash });

        // Write Pending entry — the sync loop will resolve it within ~60s
        // when the Settled event lands. Per spec amendment §4 the entry's
        // rpc_url is null here (we don't have direct access to the
        // wallet's RPC endpoint; reverted-tx detection uses wagmi's
        // publicClient which talks to the same default RPC for the chain).
        addPendingEntry(memberPubkey, {
          tx_hash: settleHash,
          submitted_at: Date.now(),
          recipient_address: recipientAddress,
          amount_human: formatUsdc(amountUnits),
          amount_units_raw: amountUnits.toString(),
          rpc_url: null,
          status: "submitted",
        });

        setStep({ kind: "submitted", txHash: settleHash });
        onSubmitted();
      } catch (err) {
        const e = err as { shortMessage?: string; message?: string };
        const message = e.shortMessage ?? e.message ?? "Settlement failed";
        setStep({ kind: "error", message });
      }
    },
    [
      amount,
      chainId,
      isPaused,
      memberPubkey,
      onSubmitted,
      publicClient,
      recipient,
      reference,
      routerAddress,
      switchChainAsync,
      usdcAddress,
      walletAddress,
      writeContractAsync,
    ],
  );

  // ─── Render ──────────────────────────────────────────────────────────

  if (step.kind === "submitted") {
    return (
      <div className="stablecoin-form">
        <div className="sub-alert sub-alert-emerald">
          <span className="sub-alert-icon" aria-hidden>✓</span>
          <div className="sub-alert-body">
            Settlement submitted. It will appear in your history within about a minute of
            on-chain confirmation.
            <div style={{ marginTop: 8, fontSize: "0.75rem", fontFamily: "var(--mono)", color: "var(--text-2)" }}>
              tx: {step.txHash}
            </div>
          </div>
        </div>
        <div className="stablecoin-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={reset}>Send another</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <form className="stablecoin-form" onSubmit={handleSubmit}>
      {!isConnected && (
        <div className="sub-alert sub-alert-amber" style={{ marginBottom: 12 }}>
          <span className="sub-alert-icon" aria-hidden>⚠</span>
          <div className="sub-alert-body">
            Connect a wallet (Settings → Stablecoin Wallet) before sending a settlement.
          </div>
        </div>
      )}
      {isPaused && (
        <div className="sub-alert sub-alert-red" style={{ marginBottom: 12 }}>
          <span className="sub-alert-icon" aria-hidden>✕</span>
          <div className="sub-alert-body">
            Settlements are temporarily paused by the treasury. Try again later.
          </div>
        </div>
      )}
      <label className="stablecoin-field">
        <span className="stablecoin-field-label">Recipient address</span>
        <input
          type="text"
          className="stablecoin-input"
          placeholder="0x…"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={submitting}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="stablecoin-field">
        <span className="stablecoin-field-label">Amount (USDC)</span>
        <input
          type="text"
          className="stablecoin-input"
          inputMode="decimal"
          placeholder="100.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={submitting}
        />
      </label>
      <label className="stablecoin-field">
        <span className="stablecoin-field-label">Reference (optional)</span>
        <input
          type="text"
          className="stablecoin-input"
          placeholder="e.g. invoice-2026-04-15"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          disabled={submitting}
          maxLength={120}
        />
        <span className="stablecoin-field-hint">
          Free-text — hashed via keccak256 and stored as a bytes32 on-chain.
        </span>
      </label>
      <FeeDisplay
        feeHuman={feePreviewHuman}
        feeBps={feeBps}
        variant="preview"
      />
      {step.kind === "validation_error" && (
        <div className="sub-alert sub-alert-amber" style={{ marginTop: 8 }}>
          <span className="sub-alert-icon" aria-hidden>⚠</span>
          <div className="sub-alert-body">{step.message}</div>
        </div>
      )}
      {step.kind === "error" && (
        <div className="sub-alert sub-alert-dim-red" style={{ marginTop: 8 }}>
          <span className="sub-alert-icon" aria-hidden>✕</span>
          <div className="sub-alert-body">{step.message}</div>
        </div>
      )}
      {(step.kind === "approving" || step.kind === "settling") && (
        <StepProgress step={step} />
      )}
      <div className="stablecoin-actions" style={{ marginTop: 12 }}>
        <button type="submit" className="btn btn-primary" disabled={submitting || !isConnected || isPaused}>
          {submitting ? "Working…" : "Send USDC"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function StepProgress({
  step,
}: {
  step: Extract<FormStep, { kind: "approving" | "settling" }>;
}) {
  const label =
    step.kind === "approving"
      ? step.txHash
        ? "Step 1 of 2 — waiting for approval confirmation…"
        : "Step 1 of 2 — sign approval in your wallet…"
      : step.txHash
      ? "Step 2 of 2 — settlement submitted, waiting for inclusion…"
      : "Step 2 of 2 — sign settlement in your wallet…";
  return (
    <div className="sub-alert sub-alert-dashed" style={{ marginTop: 12 }}>
      <span className="sub-alert-icon" aria-hidden>·</span>
      <div className="sub-alert-body">{label}</div>
    </div>
  );
}
