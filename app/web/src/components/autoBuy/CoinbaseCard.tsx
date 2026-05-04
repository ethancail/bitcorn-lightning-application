// app/web/src/components/autoBuy/CoinbaseCard.tsx
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, type AutoBuyStatus } from "../../api/client";

interface Props {
  status: AutoBuyStatus;
  onRefresh: () => Promise<unknown>;
}

type Toast = { kind: "success" | "error"; message: string } | null;

export default function CoinbaseCard({ status, onRefresh }: Props) {
  const connected = !!status.credentials;
  const whitelisted = !!status.config?.withdraw_address_whitelisted_at;

  if (!connected) return <DisconnectedState onRefresh={onRefresh} />;
  if (!whitelisted) return <ConnectedNotWhitelistedState status={status} onRefresh={onRefresh} />;
  return <ConnectedReadyState status={status} onRefresh={onRefresh} />;
}

// ───────────────────────────────────────────────────────────────────────
// Disconnected
// ───────────────────────────────────────────────────────────────────────

function DisconnectedState({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const [blob, setBlob] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const connect = async () => {
    setBusy(true); setToast(null);
    try {
      await api.postAutoBuyCredentials({ json_blob: blob });
      setToast({ kind: "success", message: "Connected. Verifying…" });
      await onRefresh();
      setBlob("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error.";
      setToast({ kind: "error", message: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Coinbase Integration</div>
      <div className="panel-body">
        <p style={{ marginTop: 0, marginBottom: 12 }}>
          Paste your Coinbase Developer Platform (CDP) API Key JSON file below. Sign in at{" "}
          <a
            href="https://portal.cdp.coinbase.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            portal.cdp.coinbase.com
          </a>{" "}
          with your normal Coinbase account — no separate developer account is required.
          We'll verify the key with Coinbase, then encrypt it at rest.
        </p>
        <p className="text-dim" style={{ marginTop: 0, marginBottom: 12, fontSize: "0.8125rem" }}>
          When creating the key, enable all three permissions:{" "}
          <strong>View</strong> (read balances),{" "}
          <strong>Trade</strong> (place buy orders), and{" "}
          <strong>Transfer</strong> (withdraw BTC to your node).
          A key missing Transfer will pass verification but fail silently 72h later at the sweep step.
        </p>
        <textarea
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          placeholder={`{\n  "name": "organizations/.../apiKeys/...",\n  "privateKey": "-----BEGIN EC PRIVATE KEY-----\\n..."\n}`}
          rows={8}
          style={{ width: "100%", fontFamily: "var(--mono)", fontSize: "0.75rem", marginBottom: 12, resize: "vertical" }}
        />
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 12 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button onClick={connect} disabled={busy || !blob.trim()}>{busy ? "Connecting…" : "Save & Connect"}</button>
          <a
            href="https://docs.cdp.coinbase.com/get-started/authentication/cdp-api-keys"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "0.8125rem" }}
          >
            How to create a CDP API Key →
          </a>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Connected but not whitelisted
// ───────────────────────────────────────────────────────────────────────

function ConnectedNotWhitelistedState({ status, onRefresh }: { status: AutoBuyStatus; onRefresh: () => Promise<unknown> }) {
  const [qr, setQr] = useState<string | null>(null);
  const [busyVerify, setBusyVerify] = useState(false);
  const [busyConfirm, setBusyConfirm] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const address = status.config?.withdraw_address ?? "";

  useEffect(() => {
    if (!address) { setQr(null); return; }
    QRCode.toDataURL(address.toUpperCase(), { width: 240 }).then(setQr).catch(() => setQr(null));
  }, [address]);

  const verify = async () => {
    setBusyVerify(true); setToast(null);
    try {
      const r = await api.verifyAutoBuyCredentials();
      setToast({ kind: "success", message: `Verified. ${r.accounts.length} Coinbase account(s) reachable.` });
      await onRefresh();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : "Verification failed." });
    } finally {
      setBusyVerify(false);
    }
  };

  const confirmWhitelist = async () => {
    if (!confirm("Confirm you have added this address to your Coinbase allowlist. If you haven't, withdrawals will fail and Auto-Buy will pause.")) return;
    setBusyConfirm(true); setToast(null);
    try {
      await api.patchAutoBuyConfig({ whitelist_confirmed: true });
      setToast({ kind: "success", message: "Whitelist confirmed. You can now enable Auto-Buy." });
      await onRefresh();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : "Failed to confirm." });
    } finally {
      setBusyConfirm(false);
    }
  };

  const copyAddress = () => {
    if (!address) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(address).then(() => setToast({ kind: "success", message: "Address copied." })).catch(() => fallbackCopy(address));
    } else {
      fallbackCopy(address);
    }
  };

  const fallbackCopy = (text: string) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); setToast({ kind: "success", message: "Address copied." }); }
    catch { setToast({ kind: "error", message: "Copy failed — please copy manually." }); }
    document.body.removeChild(ta);
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Coinbase Integration</div>
      <div className="panel-body">
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 16 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}

        {/* Connection row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
          <div>
            <div className="text-dim" style={{ fontSize: "0.75rem" }}>API Key</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem" }}>{maskKey(status.credentials?.key_name ?? "")}</div>
            <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 2 }}>
              {status.credentials?.last_verified_at
                ? `Last verified ${new Date(status.credentials.last_verified_at * 1000).toLocaleString()}`
                : "Not yet verified"}
            </div>
          </div>
          <button onClick={verify} disabled={busyVerify} style={{ fontSize: "0.8125rem" }}>{busyVerify ? "Verifying…" : "Verify connection"}</button>
        </div>

        {/* Address panel */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: 4 }}>Your dedicated deposit address</div>
          <p className="text-dim" style={{ fontSize: "0.8125rem", marginTop: 0, marginBottom: 12 }}>
            Add this address to Coinbase's withdrawal allowlist before enabling Auto-Buy. Coinbase requires 2FA to add an address — this is enforced in Coinbase's own UI, not ours.
          </p>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            {qr && <img src={qr} alt="QR code" style={{ width: 160, height: 160, borderRadius: 4, background: "white", padding: 8 }} />}
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem", wordBreak: "break-all", padding: 8, background: "var(--panel)", borderRadius: 4, marginBottom: 8 }}>
                {address || <em className="text-dim">address generating…</em>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={copyAddress} disabled={!address} style={{ fontSize: "0.8125rem" }}>Copy</button>
                <a
                  href="https://help.coinbase.com/en/coinbase/privacy-and-security/security/allow-list"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "0.8125rem", alignSelf: "center" }}
                >
                  How to whitelist an address in Coinbase →
                </a>
              </div>
            </div>
          </div>
        </div>

        <button
          onClick={confirmWhitelist}
          disabled={busyConfirm || !address}
          style={{ background: "var(--green)", color: "white", fontWeight: 600 }}
        >
          {busyConfirm ? "Confirming…" : "I've whitelisted this in Coinbase"}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Connected + whitelisted
// ───────────────────────────────────────────────────────────────────────

function ConnectedReadyState({ status, onRefresh }: { status: AutoBuyStatus; onRefresh: () => Promise<unknown> }) {
  const [busyVerify, setBusyVerify] = useState(false);
  const [busyDisconnect, setBusyDisconnect] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const verify = async () => {
    setBusyVerify(true); setToast(null);
    try {
      const r = await api.verifyAutoBuyCredentials();
      setToast({ kind: "success", message: `Verified. ${r.accounts.length} Coinbase account(s) reachable.` });
      await onRefresh();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : "Verification failed." });
    } finally { setBusyVerify(false); }
  };

  const disconnect = async () => {
    if (!confirm("Disconnect Coinbase credentials? This pauses Auto-Buy until you reconnect.")) return;
    setBusyDisconnect(true); setToast(null);
    try {
      await api.deleteAutoBuyCredentials();
      setToast({ kind: "success", message: "Disconnected." });
      await onRefresh();
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : "Disconnect failed." });
    } finally { setBusyDisconnect(false); }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Coinbase Integration</div>
      <div className="panel-body">
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 16 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--green)", marginBottom: 2 }}>
              ✓ Connected & Whitelisted
            </div>
            <div className="text-dim" style={{ fontSize: "0.75rem" }}>
              {maskKey(status.credentials?.key_name ?? "")} — connected {new Date((status.credentials?.connected_at ?? 0) * 1000).toLocaleDateString()}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={verify} disabled={busyVerify} style={{ fontSize: "0.8125rem" }}>{busyVerify ? "Verifying…" : "Verify"}</button>
            <button onClick={disconnect} disabled={busyDisconnect} style={{ fontSize: "0.8125rem", color: "var(--red)" }}>{busyDisconnect ? "…" : "Disconnect"}</button>
          </div>
        </div>

        <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>
          Deposit address (whitelisted): <span style={{ fontFamily: "var(--mono)" }}>{status.config?.withdraw_address}</span>
        </div>
      </div>
    </div>
  );
}

function maskKey(keyName: string): string {
  if (!keyName) return "—";
  if (keyName.length <= 24) return keyName;
  return `${keyName.slice(0, 18)}…${keyName.slice(-8)}`;
}
