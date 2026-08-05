// EmptyState — two-parallel-CTA card per spec amendment §6.
//
// A member with no settlement history sees this in place of the list.
// Spec calls for two CTAs of equal visual weight:
//   - "Send USDC"            → opens the settlement form
//   - "Show my receive address" → surfaces wallet address + copy button + QR
//
// Empty-state population is genuinely mixed — farmers waiting on inbound
// payments need to share their receive address; merchants need to
// initiate. The first call presented matters less than that both are
// visible (spec §6 lock).

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

export default function EmptyState({
  walletAddress,
  onSend,
}: {
  walletAddress: string;
  onSend: () => void;
}) {
  const [showReceive, setShowReceive] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!showReceive) return;
    let cancelled = false;
    QRCode.toDataURL(walletAddress, {
      width: 200,
      margin: 1,
      color: { dark: "#0a0a0c", light: "#e8e8f0" },
    })
      .then((url) => { if (!cancelled) setQrUrl(url); })
      .catch(() => { /* QR unavailable — degrade gracefully */ });
    return () => { cancelled = true; };
  }, [walletAddress, showReceive]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(walletAddress).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => { /* clipboard unavailable; user can still triple-click the code element */ },
    );
  }, [walletAddress]);

  if (showReceive) {
    return (
      <div className="stablecoin-empty">
        <h2 className="stablecoin-empty-heading">Your receive address</h2>
        <p className="stablecoin-empty-body">
          Share this with another Bitcorn member or any BASE wallet. USDC settlements sent here
          will appear in your history within about a minute of on-chain confirmation.
        </p>
        {qrUrl && (
          <div className="stablecoin-empty-qr">
            <img src={qrUrl} alt={`QR code for ${walletAddress}`} width={200} height={200} />
          </div>
        )}
        <code className="stablecoin-empty-address">{walletAddress}</code>
        <div className="stablecoin-empty-actions">
          <button className="btn btn-primary" onClick={handleCopy}>
            {copied ? "✓ Copied" : "Copy address"}
          </button>
          <button className="btn btn-outline" onClick={() => setShowReceive(false)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stablecoin-empty">
      <h2 className="stablecoin-empty-heading">No settlements yet</h2>
      <p className="stablecoin-empty-body">
        Settlements you send or receive will appear here.
      </p>
      <div className="stablecoin-empty-actions">
        <button className="btn btn-primary" onClick={onSend}>
          Send USDC
        </button>
        <button className="btn btn-outline" onClick={() => setShowReceive(true)}>
          Show my receive address
        </button>
      </div>
    </div>
  );
}
