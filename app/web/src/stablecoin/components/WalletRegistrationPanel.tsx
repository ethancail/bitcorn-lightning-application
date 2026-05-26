// WalletRegistrationPanel — the Settings-page surface that registers a
// member's BASE wallet via SIWE.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §8.1, §9.3
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md §1, §2
//
// Flow (matches spec §8.1 steps 1-7 + amendment §2 signature-challenge):
//   1. Member opens Settings → sees this panel
//   2. If wallet already registered: show address + Disconnect + Replace
//   3. Else: show three-option wallet picker (§1: Coinbase Smart Wallet
//      top + Recommended caption, MetaMask middle, Other-wallet bottom)
//   4. Member clicks a tile → wagmi connect flow runs
//   5. Wallet returns address → render inline confirmation
//      "Register 0xabcd...1234 as your BASE wallet?" with Confirm/Cancel
//   6. On Confirm: POST /wallet/challenge → wallet signs returned message
//      → POST /wallet with { message, signature } → success state
//
// State machine kept as a discriminated union per the project pattern
// (mirrors SubscriptionPanel.tsx's ViewState shape).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import {
  stablecoinApi,
  type WalletStatusResponse,
} from "../client";
import { DEFAULT_CHAIN, isWalletConnectConfigured } from "../wagmi";

type ViewState =
  | { kind: "loading" }
  | { kind: "registered"; status: WalletStatusResponse }
  | { kind: "unregistered" }
  | { kind: "fetch_error"; detail?: string };

type RegistrationStep =
  | { kind: "idle" }
  | { kind: "connecting"; connectorId: string }
  | { kind: "confirm"; address: `0x${string}` }
  | { kind: "requesting_challenge"; address: `0x${string}` }
  | { kind: "awaiting_signature"; address: `0x${string}`; message: string }
  | { kind: "submitting"; address: `0x${string}` }
  | { kind: "success"; address: `0x${string}` }
  | { kind: "error"; address: `0x${string}` | null; message: string };

const REGISTERED_REFRESH_EVENT = "bitcorn:stablecoin-wallet-changed";

function truncate(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function WalletRegistrationPanel() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [step, setStep] = useState<RegistrationStep>({ kind: "idle" });

  const fetchStatus = useCallback(async () => {
    try {
      const status = await stablecoinApi.getWalletStatus();
      if (status.wallet_address && status.is_active) {
        setView({ kind: "registered", status });
      } else {
        setView({ kind: "unregistered" });
      }
    } catch (err) {
      const e = err as { status?: number; detail?: string; message?: string };
      // 503 node_not_ready is a transient case — local LND identity
      // hasn't published yet. Render as a fetch error with the same
      // detail message; the periodic refresh will catch up.
      setView({ kind: "fetch_error", detail: e.detail ?? e.message });
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const onChange = () => void fetchStatus();
    window.addEventListener(REGISTERED_REFRESH_EVENT, onChange);
    return () => window.removeEventListener(REGISTERED_REFRESH_EVENT, onChange);
  }, [fetchStatus]);

  return (
    <section className="panel ops stablecoin-wallet-panel">
      <header className="panel-header">
        <div className="panel-title">
          <span className="icon">◇</span>
          <h2>Stablecoin Wallet</h2>
        </div>
      </header>
      <div className="panel-body">
        {view.kind === "loading" && <p className="stablecoin-loading">Loading…</p>}
        {view.kind === "fetch_error" && (
          <div className="sub-alert sub-alert-dim-red">
            <span className="sub-alert-icon" aria-hidden>✕</span>
            <div className="sub-alert-body">
              Couldn't load wallet status.
              {view.detail ? <span className="sub-error-detail"> ({view.detail})</span> : null}
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-outline btn-sm" onClick={fetchStatus}>Retry</button>
              </div>
            </div>
          </div>
        )}
        {view.kind === "registered" && (
          <RegisteredView
            status={view.status}
            onReplaced={fetchStatus}
            onDisconnected={fetchStatus}
          />
        )}
        {view.kind === "unregistered" && (
          <UnregisteredView
            step={step}
            setStep={setStep}
            onRegistered={() => {
              void fetchStatus();
              window.dispatchEvent(new Event(REGISTERED_REFRESH_EVENT));
            }}
          />
        )}
      </div>
    </section>
  );
}

// ─── Registered view ────────────────────────────────────────────────────

function RegisteredView({
  status,
  onReplaced: _onReplaced,
  onDisconnected,
}: {
  status: WalletStatusResponse;
  onReplaced: () => void;
  onDisconnected: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingReplace, setConfirmingReplace] = useState(false);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await stablecoinApi.unregisterWallet();
      onDisconnected();
    } catch (err) {
      const e = err as { detail?: string; message?: string };
      setError(e.detail ?? e.message ?? "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }, [onDisconnected]);

  if (confirmingReplace) {
    return (
      <ReplaceConfirmFlow
        currentAddress={status.wallet_address!}
        onCancel={() => setConfirmingReplace(false)}
        onComplete={() => {
          setConfirmingReplace(false);
          window.dispatchEvent(new Event(REGISTERED_REFRESH_EVENT));
        }}
      />
    );
  }

  return (
    <>
      <div className="stablecoin-registered-row">
        <div className="stablecoin-label">REGISTERED WALLET</div>
        <code className="stablecoin-address">{status.wallet_address}</code>
        <p className="stablecoin-fineprint">
          Registered {status.registered_at ? formatDate(status.registered_at) : "—"}.
          Disconnecting only removes the wallet from Bitcorn's display — it does not affect
          your on-chain USDC balance or settlement history.
        </p>
      </div>
      {error && (
        <div className="sub-alert sub-alert-dim-red" style={{ marginTop: 12 }}>
          <span className="sub-alert-icon" aria-hidden>✕</span>
          <div className="sub-alert-body">{error}</div>
        </div>
      )}
      <div className="stablecoin-actions">
        <button
          className="btn btn-outline"
          onClick={() => setConfirmingReplace(true)}
          disabled={busy}
        >
          Replace with different wallet
        </button>
        <button className="btn btn-danger btn-sm" onClick={handleDisconnect} disabled={busy}>
          {busy ? "Disconnecting…" : "Disconnect wallet"}
        </button>
      </div>
    </>
  );
}

function ReplaceConfirmFlow({
  currentAddress,
  onCancel,
  onComplete,
}: {
  currentAddress: string;
  onCancel: () => void;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<RegistrationStep>({ kind: "idle" });
  return (
    <>
      <div className="sub-alert sub-alert-amber">
        <span className="sub-alert-icon" aria-hidden>⚠</span>
        <div className="sub-alert-body">
          You're about to replace <code>{truncate(currentAddress)}</code> with a new wallet.
          Settlements to the old address will not appear in your history view after this change.
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <UnregisteredView
          step={step}
          setStep={setStep}
          onRegistered={onComplete}
        />
      </div>
      <div className="stablecoin-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

// ─── Unregistered view ──────────────────────────────────────────────────

function UnregisteredView({
  step,
  setStep,
  onRegistered,
}: {
  step: RegistrationStep;
  setStep: (s: RegistrationStep) => void;
  onRegistered: () => void;
}) {
  const { connectors, connectAsync } = useConnect();
  const { connector: activeConnector, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();

  // Map wagmi's connector list back to our three picker tiles.
  const pickerConnectors = useMemo(() => {
    const cb = connectors.find((c) => c.id === "coinbaseWalletSDK" || c.id === "coinbaseWallet" || c.type === "coinbaseWallet");
    const mm = connectors.find((c) => c.id === "metaMaskSDK" || c.id === "metaMask" || c.type === "metaMask");
    const wc = connectors.find((c) => c.id === "walletConnect" || c.type === "walletConnect");
    return { cb, mm, wc };
  }, [connectors]);

  const handleConnectorClick = useCallback(
    async (connectorId: string) => {
      const connector = connectors.find((c) => c.id === connectorId);
      if (!connector) {
        setStep({ kind: "error", address: null, message: `Connector ${connectorId} unavailable` });
        return;
      }
      setStep({ kind: "connecting", connectorId });
      try {
        // If a different wallet was previously connected (e.g. a Coinbase
        // Smart Wallet session persisted in wagmi's localStorage from an
        // earlier flow), disconnect it first so the new connector's
        // account is the authoritative one.
        if (isConnected) {
          await disconnectAsync();
        }
        // Take the address from connectAsync's return value rather than
        // reading useAccount().address afterwards. useAccount() races with
        // the disconnect→reconnect transition: during the switch it can
        // still report the PRIOR connector's account, which then gets
        // snapshotted into the confirm step and fails at sign time with
        // "Account <prior> not found for connector <new>". connectAsync
        // resolves with the freshly-connected connector's own accounts.
        const result = await connectAsync({ connector });
        const connectedAddress = result.accounts?.[0];
        if (!connectedAddress) {
          setStep({ kind: "error", address: null, message: "Wallet connected but returned no account" });
          return;
        }
        setStep({ kind: "confirm", address: connectedAddress });
      } catch (err) {
        const e = err as { message?: string; shortMessage?: string };
        setStep({
          kind: "error",
          address: null,
          message: e.shortMessage ?? e.message ?? "Wallet connection failed",
        });
      }
    },
    [connectAsync, connectors, disconnectAsync, isConnected, setStep],
  );

  const handleConfirmRegister = useCallback(async () => {
    if (step.kind !== "confirm") return;
    const walletAddress = step.address;
    setStep({ kind: "requesting_challenge", address: walletAddress });
    try {
      // Ensure we're on the right chain before signing — Coinbase Smart
      // Wallet auto-selects Base Mainnet by default; for Base Sepolia we
      // need to nudge it explicitly. wagmi's switchChain is a no-op if
      // already on the target chain.
      if (chainId !== DEFAULT_CHAIN.id) {
        try {
          await switchChainAsync({ chainId: DEFAULT_CHAIN.id });
        } catch {
          // Smart Wallet may not surface a network switch UI; the SIWE
          // verifier checks the chain ID in the signed message against
          // the API's expectedChainId, so a mismatch surfaces as a SIWE
          // verification failure rather than going through silently.
        }
      }

      const challenge = await stablecoinApi.requestChallenge(walletAddress);
      setStep({ kind: "awaiting_signature", address: walletAddress, message: challenge.message });

      const signature = await signMessageAsync({
        message: challenge.message,
        account: walletAddress,
      });

      setStep({ kind: "submitting", address: walletAddress });
      await stablecoinApi.registerWallet(challenge.message, signature);
      setStep({ kind: "success", address: walletAddress });
      onRegistered();
    } catch (err) {
      const e = err as { message?: string; shortMessage?: string; detail?: string };
      const message =
        e.detail ?? e.shortMessage ?? e.message ?? "Wallet registration failed";
      setStep({ kind: "error", address: walletAddress, message });
    }
  }, [chainId, onRegistered, setStep, signMessageAsync, step, switchChainAsync]);

  const handleCancel = useCallback(async () => {
    try {
      await disconnectAsync();
    } catch {
      // disconnect failures aren't actionable for the user
    }
    setStep({ kind: "idle" });
  }, [disconnectAsync, setStep]);

  // Step rendering.
  if (step.kind === "confirm" || step.kind === "requesting_challenge" ||
      step.kind === "awaiting_signature" || step.kind === "submitting") {
    return (
      <ConfirmStepView
        step={step}
        connectorName={activeConnector?.name ?? "your wallet"}
        onConfirm={handleConfirmRegister}
        onCancel={handleCancel}
      />
    );
  }

  if (step.kind === "success") {
    return (
      <div className="sub-alert sub-alert-emerald" style={{ marginBottom: 0 }}>
        <span className="sub-alert-icon" aria-hidden>✓</span>
        <div className="sub-alert-body">
          Wallet <code>{truncate(step.address)}</code> registered. Your stablecoin settlement
          history will appear on the Stablecoin page within a minute.
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="stablecoin-intro">
        Connect a BASE wallet to send and receive USDC settlements with other Bitcorn members.
        This is optional — Lightning routing and subscription work without it.
      </p>
      {step.kind === "error" && (
        <div className="sub-alert sub-alert-dim-red" style={{ marginBottom: 12 }}>
          <span className="sub-alert-icon" aria-hidden>✕</span>
          <div className="sub-alert-body">{step.message}</div>
        </div>
      )}
      <div className="stablecoin-picker">
        <WalletTile
          label="Coinbase Smart Wallet"
          caption="Recommended — no seed phrase, works on any device"
          disabled={!pickerConnectors.cb || step.kind === "connecting"}
          loading={step.kind === "connecting" && step.connectorId === pickerConnectors.cb?.id}
          recommended
          onClick={() => pickerConnectors.cb && void handleConnectorClick(pickerConnectors.cb.id)}
        />
        <WalletTile
          label="MetaMask"
          disabled={!pickerConnectors.mm || step.kind === "connecting"}
          loading={step.kind === "connecting" && step.connectorId === pickerConnectors.mm?.id}
          onClick={() => pickerConnectors.mm && void handleConnectorClick(pickerConnectors.mm.id)}
        />
        <WalletTile
          label="Other wallet"
          caption={isWalletConnectConfigured
            ? "Scan with any WalletConnect v2-compatible wallet"
            : "Requires VITE_WALLETCONNECT_PROJECT_ID — not configured for this build"}
          disabled={!isWalletConnectConfigured || !pickerConnectors.wc || step.kind === "connecting"}
          loading={step.kind === "connecting" && step.connectorId === pickerConnectors.wc?.id}
          onClick={() => pickerConnectors.wc && void handleConnectorClick(pickerConnectors.wc.id)}
        />
      </div>
      <p className="stablecoin-network-hint">
        Network: <code>{DEFAULT_CHAIN.name}</code> (chain ID {DEFAULT_CHAIN.id}). Make sure your
        wallet is set to this network — you'll be prompted to switch if needed.
      </p>
    </>
  );
}

function ConfirmStepView({
  step,
  connectorName,
  onConfirm,
  onCancel,
}: {
  step: Extract<RegistrationStep, { kind: "confirm" | "requesting_challenge" | "awaiting_signature" | "submitting" }>;
  connectorName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const busy = step.kind !== "confirm";
  const busyLabel =
    step.kind === "requesting_challenge"
      ? "Requesting challenge from Bitcorn…"
      : step.kind === "awaiting_signature"
      ? `Sign the message in ${connectorName}…`
      : step.kind === "submitting"
      ? "Verifying signature…"
      : null;
  return (
    <>
      <p className="stablecoin-intro">
        Register <code>{step.address}</code> as your BASE wallet?
      </p>
      <p className="stablecoin-fineprint">
        Connected via <strong>{connectorName}</strong>. You'll be asked to sign a one-time
        message to prove you control this address. The signature is off-chain — no gas, no
        on-chain transaction. The message contains your Lightning pubkey, your wallet address,
        this site's hostname, and a single-use nonce.
      </p>
      {busyLabel && (
        <div className="sub-alert sub-alert-dashed" style={{ marginTop: 12 }}>
          <span className="sub-alert-icon" aria-hidden>·</span>
          <div className="sub-alert-body">{busyLabel}</div>
        </div>
      )}
      <div className="stablecoin-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : "Confirm — sign in wallet"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </>
  );
}

function WalletTile({
  label,
  caption,
  recommended,
  disabled,
  loading,
  onClick,
}: {
  label: string;
  caption?: string;
  recommended?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`stablecoin-tile ${recommended ? "stablecoin-tile-recommended" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-busy={loading}
    >
      <div className="stablecoin-tile-label">{label}</div>
      {caption && <div className="stablecoin-tile-caption">{caption}</div>}
      {loading && <div className="stablecoin-tile-status">Connecting…</div>}
    </button>
  );
}

// Re-export for parent panel composition + types referenced above.
export { baseSepolia };
